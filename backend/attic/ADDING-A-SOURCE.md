# Adding a source now

The board is empty. There are no providers configured, and the service is
expected to say so:

```
[elfura-backend] listening on 0.0.0.0:8787 (0/0 sources; roxy: enabled)
[elfura-config] ... sources=none-approved
[elfura-selftest] no sources approved yet — nothing to test
```

`{"sourceCount":0}` in `/api/v1/health` is correct, not a bug.

---

## The shape of it

A source exists in exactly two places:

1. `backend/src/sources/<name>.ts` — the adapter
2. one entry in `APPROVED_SOURCES` in `backend/src/sources/index.ts`

The registry builds its list from that array and nothing else, so anything not
in the array cannot serve traffic. There is no `sourceN` config block, no
`SOURCE*_ENABLED` table, and no provider list in the roxy panel. Those all
existed before; each was a second registry that drifted out of sync with the
adapters it described.

## Step 1 — the adapter

```ts
import type { SourceAdapter, SourceQuery, RawSourceResult } from './types.js';
import { sourceEnv } from './index.js';

export function createExampleAdapter(): SourceAdapter {
  const env = sourceEnv();                    // process.env, .env already merged
  const origin = env.EXAMPLE_ORIGIN ?? 'https://example.invalid';

  return {
    id: 'source-1',                           // must match the manifest entry
    label: 'Source 1',                        // public, branded, never the provider name
    // Optional, only if the player must behave differently for this lane:
    // traits: ['aggregator' | 'animeEpisode' | 'hardSubtitle' | 'slowManifest' | 'hevcFirst']
    // discoveryTimeoutMs: 12_000,            // only if this lane needs longer than RESOLVE_TIMEOUT_MS
    enabled: () => env.EXAMPLE_ENABLED !== '0',

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      // Return candidates whose `url` is the UPSTREAM url; the registry wraps
      // them in /api/proxy itself. Never hand the client a raw provider url.
      return { candidates: [/* … */] };
    },
  };
}
```

`sourceEnv()` is how a lane reads its own settings, which is why `config.ts`
has no per-source keys any more.

If your lane needs different player behaviour, set a trait instead of adding a
provider id to a list in `src/`:

| trait | what the player does |
| --- | --- |
| `aggregator` | a manually chosen lane exhausts its own servers before switching groups |
| `animeEpisode` | gets the anime first-wave window, keeps its own episode-aligned subtitles, skipped for movies |
| `hardSubtitle` | candidates may be labelled `Provider-labelled Hard Sub` |
| `slowManifest` | gets the 12s/15s manifest and fragment budget instead of 5.5s/7s |
| `hevcFirst` | manifest is inspected before dash.js attaches on devices without HEVC |

## Step 2 — the manifest entry

```ts
export const APPROVED_SOURCES: SourceDefinition[] = [
  {
    id: 'source-1',
    create: () => createExampleAdapter(),
    probes: [{ type: 'movie', tmdbId: '550' }],   // titles you have confirmed exist upstream
    website: { name: 'Example', url: 'https://example.invalid' }, // optional, panel only
  },
];
```

`probes` is not optional in practice: `standing-rules.mjs` fails if an entry has
no probe list, because an entry with no titles would pass the contract test
vacuously.

## Step 3 — prove it

```bash
npm run build
node backend/test/source-contract.mjs
```

It must print a line like:

```
✓ source-1: resolved 4 candidate(s), 131072 segment bytes, 3184ms
```

What the test actually does — a 200 is not enough:

1. resolve the probe titles, at least one candidate comes back
2. every candidate is already a `/api/proxy` path, not an upstream URL
3. the proxy serves a manifest, not an HTML error page
4. a media line behind that manifest returns real bytes
5. no provider hostname leaked into the served text

This sandbox cannot reach the providers (TLS resets — it is the sandbox, not the
adapter), so run it on a GitHub runner:
`.github/workflows/source-contract.yml` runs the same file nightly and on push,
and the job is red if any approved lane fails.

## Step 4 — commit

Only now. `npm test` includes the contract test, so a lane that stops producing
bytes turns the suite red until it is fixed or removed from the manifest.

## Retiring one

Delete the entry and `git mv` the adapter and its tests into `backend/attic/`.
That directory is outside `backend/tsconfig.json`'s `include` and outside the
test glob, so archived code is never compiled, imported or run. See
`backend/attic/README.md` for resurrecting one.

## Why it is this strict

Thirty adapters, 7,651 lines, and almost none of them produced playable bytes.
The tests asserted the shape of things, the console reported coverage, and the
viewer got nothing. Six lanes that answer every time beat thirty that might.
