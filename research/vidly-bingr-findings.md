# vidly and bingr — what the measurements say

Both were already in this repo's history, and neither earlier verdict was about
coverage. Measured 2026-11-25 on a runner; raw rows in
[upstream-lookup.json](upstream-lookup.json).

---

# Vidly — the subtitle index works, but not for the language that matters

## What it is

`vidly.pro` is a TMDB-keyed embed player. Its **streams are gated** — a
per-session token scraped from the page, and a hand-rolled xorshift keystream
whose key lives in the public JS bundle. The retired source-22 documents why that
is refused: the key changes silently on any redeploy, and getting it wrong
produces garbage rather than an error.

Its **subtitle index is not gated**:

```
GET /api/subtitles?kind=movie&tmdb=<id>
GET /api/subtitles?kind=tv&tmdb=<id>&season=<s>&episode=<e>
```

Plain JSON, no token, no cookie, no key.

## What it actually carries — 8/8 titles indexed

| title | tracks | Indic present |
| — | — | — |
| fight-club | 43 | — |
| inception | 97 | — |
| dune-2 | 94 | Bengali |
| rrr | 96 | Bengali, **Telugu** |
| pathaan | 14 | — |
| got-s1e1 | 95 | Malayalam, Tamil |
| naruto-s1e1 | 40 | Bengali |
| breaking-bad-s1e1 | 89 | — |

**Every title indexed. 14–97 tracks each.** That is a broad catalogue by any
measure.

## The finding that decides it: no Hindi

**Zero of eight titles carry a Hindi subtitle**, including `rrr` and `pathaan` —
two of the most Hindi-dubbed films in existence. Malayalam, Tamil, Telugu and
Bengali appear; Hindi does not.

That matters because the retired adapter's own header says why it existed:

> "A single title carries 60+ tracks, including the Indic set (Hindi, Malayalam,
> Tamil, Telugu, Bengali, Punjabi, Urdu) that our dub sources care about and that
> we otherwise have no way to label correctly."

The stated value — Hindi — is not there. What IS there is a decent general
international set plus a partial Indic set.

## The lane is gone, but the consumer is still in the registry

`backend/src/sources/registry.ts` still contains the whole path:

```ts
// Vidly subtitle index: a language fallback, never a replacement.
const vidlyTracks = query.extraSubtitles ?? [];
```

Nothing fills `query.extraSubtitles` any more, because source-22 went to the
attic in the re-zero. So the board carries dead code that exists only to admit a
lane that is not there.

That is a decision to make, not a source to discover:

- **Restore it** — but then it is a *subtitle* lane, not a source. It adds no
  streams and never will, and its claimed advantage is the language it lacks.
- **Remove the consumer** — the honest option if Hindi is the point, because
  Malayalam/Tamil/Bengali subtitles on a few titles is not worth a permanent
  maintenance surface.
- A middle course would be to restore it *filtered* to the Indic set it actually
  has — but that is a product decision, not a technical one.

**Nothing here supports promoting vidly to a source.** Its streams are gated and
its index is a subtitle table.

---

# Bingr — the 403 was a page challenge, not a dead site

## What was recorded before

```
source-4   raw=0  116ms :: 1 req · bingr.one 403
```

## What it answers now

| host | home | watch page |
| — | — | — |
| `bingr.st` | **200** | 403 + Cloudflare challenge |
| `bingr.one` | **200** | 403 + Cloudflare challenge |

Both hosts are alive. Both watch pages are behind a **JS challenge** — the body
carries Cloudflare's interstitial, which is the same class as `videasy`, `hexa`
and `cinesrc`: the ones whose crypto lives in the browser and whose front page
renders only after a challenge is solved.

**So the old "403" was neither "dead" nor "blocked from datacenter IPs". It was a
challenge on one page**, and the retry-with-better-headers approach that rescued
nxsha cannot work against it, because the gate is JavaScript, not a header.

## What that means for this board

- The homepage answering 200 proves the site exists but proves nothing about
  playback.
- `bingr.one`'s history here is as an **embed aggregator** — `research/sources-18-20.md`
  records AniHype rejected for being "a pure embed aggregator over other lanes'
  players", with `bingr.one` among its sources.
- Getting through the challenge would need a real browser in the resolve path.
  This board's resolve budget is measured in seconds and its rule is no browser
  in the hot path.
- Its former role on this board (source-4) was a watch-page API, and
  `research/all-source-upstream-audit.md` records: "server identities and origins
  are dynamic; a public reference to bingr.one's differently shaped API is not
  proof it is equivalent".

**Verdict: refused, on two independent grounds.** The page gate makes it
unreachable without a browser, and what sits behind the gate has historically
been other people's players.

---

# What this changed

Nothing on the board — source count stays at three, and neither lane is
registered or restored.

Two corrections to the record:

1. **bingr is not dead.** It was recorded as a 403 refusal. It is a live site
   behind a JS challenge. That distinction matters because "dead" invites a
   re-probe and "challenged" closes the question.
2. **vidly's advertised advantage does not hold.** The Hindi set that justified
   the lane is not in the index today. If it is restored later, it should be
   restored for Malayalam/Tamil/Telugu/Bengali, described honestly as partial.
