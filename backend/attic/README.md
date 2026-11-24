# attic

Retired code, kept whole so it can be read and resurrected deliberately.

Nothing here is compiled, imported, linted or tested. `backend/tsconfig.json`
includes only `src/**`, and the test runner no longer references anything in
`this directory`. Moving a file out of here is the only way it can affect the
service.

## Why it exists

The first board carried thirty source adapters — 7,651 lines — and almost none of
them produced playable bytes. Every one of them had a config block, an env-var
switch, a row in the operator panel and a test that asserted its *shape* rather
than its output. The result was a console that reported coverage while the
viewer got nothing, and a codebase where a provider change had to be applied in
five places that could silently disagree.

The board is now empty on purpose (`backend/src/sources/index.ts`), and a source
is admitted only by `backend/test/source-contract.mjs`: real titles, a real
manifest, real segment bytes. These files are the knowledge we paid for, not a
thing to run.

## What is here

| Path | What it is |
| --- | --- |
| `sources/source*.ts` | The thirty retired adapters. Each one records how a provider was actually reached: endpoints, tokens, encryption, playlist shapes. That research is the expensive part and it is why this is an archive rather than a deletion. |
| `sources/anime-db.ts`, `anime-direct-mapping.ts` | TMDB → AniList mapping used by the anime lanes. |
| `sources/upstream-fetch.ts`, `provenance.ts` | The bounded-text fetcher and the relay/origin classifier those adapters shared. |
| `test/*.mjs` | Their tests and the live probes that were run against them. Probes need real egress; the sandbox that edits code cannot reach the providers. |

The imports inside the archive are rewritten to point at the live tree
(`../../src/sources/types.js` and so on) and at each other, so the code reads
correctly. It is not type-checked; expect it to need small fixes if it is ever
revived.

## Resurrecting one

1. Read the adapter. Decide whether the provider still answers at all before
   spending time on the code — most of these were already dead when they were
   retired, which is why they were retired.
2. Copy the file to `backend/src/sources/<name>.ts` and fix its imports back to
   `./types.js` style.
3. If it used `anime-db.ts`, `anime-direct-mapping.ts`, `upstream-fetch.ts` or
   `provenance.ts`, copy those too, and only if the adapter genuinely needs them.
4. Give it one entry in `APPROVED_SOURCES` with probe titles you have confirmed
   exist upstream. A probe that 404s everywhere proves nothing either way.
5. `npm run build && node backend/test/source-contract.mjs`. It must print a
   manifest and a segment byte count. If it times out, it is still not a source.

Step 5 is the whole point. Six working lanes that answer every time beat thirty
that might.
