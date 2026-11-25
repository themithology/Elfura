# enc-dec.app — useful, but not as a dependency

Reviewed 2026-11-25. Sources: the repo README, the `samples/` directory, the live
site, and a GitHub code search for local reimplementations.

## What it actually is

An API toolkit for ~20 streaming sites plus two databases. Each site is a pair of
endpoints (`enc-*` / `dec-*`) that turn a site's obfuscated strings into readable
JSON. The README is explicit about the shape:

> Note: as the encryption/decryption methods are frequently changing and have
> become increasingly difficult to maintain due to patches, the code has been
> made closed-source.

So it is a **hosted oracle**, not a library. You send it a ciphertext, it sends
back plaintext. The algorithms are not published.

Two things in it are more than crypto:

- `enc-dec.app/db/flix` — TMDb/IMDb → yflix content-id database, daily updates
- `enc-dec.app/db/kai` — MAL/AniList → AnimeKai id database, daily updates

Those are genuinely useful for research: they solve "which site id is this title"
without scraping.

## Why it cannot be a dependency

Every lane would cost 2–3 round trips to a third-party VPS *inside the resolve
path*:

```
megaplay:  page → getSources → POST enc-dec.app/api/dec-megaplay → media URL
```

This board's rule is that no third party sits in the critical path of a resolve.
VidLink's adapter was written specifically to avoid `enc-dec.app`, and that cost
20 lines of local crypto. The same trade here costs the board's main latency
budget for every title, and adds a single point of failure that is not theirs and
not observable.

## Nobody has cracked it locally — and that is the real finding

GitHub code search for `dec-megaplay` in TypeScript: **0 results.** The endpoint
appears in Python clients, CLI tools, and one actively-maintained 2026 repo —
[Seanime-Providers](https://github.com/Seanime-contributions/Seanime-Providers),
whose MegaPlay provider is 201 lines and hard-codes:

```js
this.decryptUrl = "https://enc-dec.app/api/dec-megaplay";
```

So the people *shipping* these lanes use the API too. There is no public
implementation to port, which means every site on that list is either (a) broken
and re-broken by its owner, or (b) only reachable through this one service.

That is a dependency graph where the board would be downstream of a closed-source
VPS with no stated uptime and a donation button.

## Most of its sites are already dead ends here

| site | status in this repo |
| — | — |
| cinejoy | rejected — Nxsha/VidRock re-export (`research/sources-18-20.md`) |
| megaplay | already source-30 territory; playback work already done |
| vidfast, vidup | already audited as enc-dec.app-dependent (`research/flixfun-upstream-audit.md`) |
| abyss | "encrypted multi-host wrapper → ignored" (`research/sources-18-20.md`) |
| vidlink | built, measured, archived — the host refuses this client |
| hexa, cinesrc | client-side challenge / Next.js server actions — the thing a server cannot hold |

## Where it *is* useful

As a **research instrument**, not a runtime.

The expensive part of adding a source is finding out whether its catalogue is
worth having before reverse-engineering its crypto. enc-dec lets that be measured
in one runner job: ask it to decrypt a site's response, and see what languages
and what media hosts come back. If the answer is "same hakunaymatata objects as
greybox", no further work is justified. If it is a catalogue this board has none
of, the local implementation becomes worth the effort.

Sites worth measuring this way, in order:

1. **kisskh.do** — Korean and Asian drama. The board has zero of this category,
   so there is no overlap to worry about.
2. **animekai.to / anikai.to** — large anime catalogue; the DB already maps
   MAL/AniList ids, so coverage is measurable rather than guessed.
3. **yflix.to** — general movies and TV; check its host family before anything else.

## Measured, then dropped

The three were probed on a runner before any adapter was written. What came back:

| site | what answered |
| — | — |
| kisskh.do | home 200 (22 KB); drama listing **400**; episode endpoint **403 with a zero-byte body** without `kkey` |
| animekai.to | home 200; watch page 200; **episodes list answered 200 twice with no `enc` token at all** — so for this endpoint no third party is needed |
| yflix.to / 1movies.bz / solarmovie.fi | **all three domains failed at transport** — no HTTP status at all |

kisskh is the one that matters: its episode endpoint answers **403 with a
zero-byte body** when no `kkey` is presented — a gate the site mints server-side,
and no public implementation of that mint exists.

**The animekai result contradicts the reason I gave for dropping it.** Its
episodes list needed no `enc` token at all. It is not blocked by crypto; the
unmeasured part is the later `links/view` response, which is a sealed payload. I
had written that all three were "too hard to crack" before this run came back,
which was a guess dressed as a conclusion.

The owner's call stands regardless — the three were dropped as not wanted, and
one endpoint answering without a token does not change whether the catalogue is
desired. But the record should say what was measured, not what was assumed.

All three yflix domains failed at transport (`ENOTFOUND` on two,
`UND_ERR_CONNECT_TIMEOUT` on the third), which is a DNS/CDN block rather than a
dead site.

## Verdict

The databases and the documented call orders are worth keeping as reference. The
service itself is not a dependency this board can take: a lane whose crypto only
one closed-source VPS can solve is not a source the board owns, and the moment
that VPS stops, every lane built on it stops with it.

The archived probe at `backend/attic/test/catalogue-probe.mjs` is the measurement
that led here. The adapter work was never started, which is the point — the probe
answered the question for the price of one runner job instead of three adapters.
