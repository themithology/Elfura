# nxsha — the source that was refused on the wrong evidence

**Short answer: yes, it has real sources, and the refusal in this repo was based
on measuring the website instead of the API.** Measured on a runner; raw rows in
[nxsha-probe.json](nxsha-probe.json) and [object-overlap.json](object-overlap.json).

## What the old verdict actually measured

`research/measurements.md` says:

| lane | playable | what it is |
| — | — | — |
| nxsha | 0/8 | Cloudflare challenge |

Every request behind that verdict is a **`/watch/<type>/<id>` HTML page** returning
403. The retired adapter never called `/watch`. It called:

```
GET /api/servers?q=<sealed>   → { _hash } → AES-256-CBC → { servers: [{scraper}] }
GET /api/sources?q=<sealed>   → { _hash } → AES-256-CBC → { sources: [{url, language, …}] }
```

The website was challenged. The API was never asked.

## What the API answers

```
watch-page (the old verdict)  200
api/servers                   200
passphrase                    opened with 38c8cd65…
payload                       34 scrapers: 4 RiveStream-family, 30 of its own
sources:nitro                 200 — 3 rows on wts.itsnitrox.tech
```

The passphrase recorded in the attic adapter **still works**, and the app-facing
endpoint answers without a challenge.

## It is not citadel in disguise

This was the obvious risk: citadel is `rive-citadel`, and nxsha lists four
`rive-*` lanes. But its payload separates cleanly:

| family | lanes |
| — | — |
| RiveStream (same as source-1) | `rive-citadel`, `rive-primevids`, `rive-flowcast`, `rive-hindicast` |
| its own scrapers | `nitro`, `mahalala`, `watchout`, `awsind`, `castle`, `streamflix`, `xdownloader`, `purstream`, `vixolity`, `mhbox`, `bdxs`, `stvv`, `imovr`, `ophim`, `yomovies`, `showbox-online`, `vidapi`, `levi`, `toonstream`, `tamilblasters`, `hdhub4u`, `hdhub4u-direct`, `k4khdhub`, `k4khdhub-direct`, `filmyfly`, `filmyfly-direct`, `moviesdrive`, `movone`, `zoko`, `em-8` |

**30 of its own, and the four shared ones are a minority the adapter can filter
out.** A first run with one lane (`nitro`) proved the API works; three lanes were
then measured through the object-id comparison that refuted vidlink.

## Measured independence

Four titles, three of its own scrapers:

| title | nxsha candidates | media domains |
| — | — | — |
| fight-club | 4 | `itsnitrox.tech`, `halcyoncreative.site` |
| inception | 5 | `itsnitrox.tech`, `workers.dev` |
| got-s1e1 | 7 | `itsnitrox.tech`, `97bf1.com`, `wealthmanagementplan.cfd` |
| naruto-s1e1 | 4 | `itsnitrox.tech` |

**Shared objects with the board: zero.** The only pair that collides anywhere is
citadel & greybox (the `hsc:` finding from earlier). nxsha names no object the
board names, on any title.

And it carries **anime** — naruto returned 4 candidates, where greybox was
throttled and citadel returned one row. That is the category this board has none
of.

## The problems, stated plainly

1. **`workers.dev` appears in its media hosts** (inception). That is a
   third-party Cloudflare relay — the thing this board refuses and greybox's
   adapter explicitly filters. One row, one title, but it is there.
2. **Rotating domains.** `97bf1.com`, `wealthmanagementplan.cfd`,
   `halcyoncreative.site` are not names anyone would recognise, and they will
   churn. Each is a lane whose URL can stop resolving.
3. **A rotating passphrase.** Currently recovered from the site's own JS bundle
   when the constant goes stale. That works, but it is maintenance forever.
4. **I measured 3 of 30 lanes.** The rest are unmeasured; "not a re-export" is
   proven for the ones tested, not for all of them.
5. **A reference-quality warning from the retired adapter itself:** it restricted
   its lane list to HLS lanes and excluded embed-only hosts, season packs and
   unbounded fan-out. Any rebuild must keep those refusals.

## The lane survey (all 30, measured 2026-11-25)

| result | lanes |
| — | — |
| **serves media (6)** | `nitro`, `watchout`, `awsind`, `purstream`, `ophim`, `zoko` |
| **relay-shaped (2)** | `castle`, `vixolity` — both `*.nxstreamhub.workers.dev` |
| **nothing (22)** | the rest |
| **Google Drive (0)** | — |

The relay finding is the one worth having: `castle` reads like a normal scraper
name and is a `workers.dev` front. It is refused twice — off the allowlist, and
again by the host filter.

The six media lanes carry genuinely different catalogues:

| lane | host | label |
| — | — | — |
| `nitro` | `wts.itsnitrox.tech` | 1080P |
| `watchout` | `suw.halcyoncreative.site` | watchout |
| `awsind` | `i-arch-400.asrmo449ddj.com` | **Hindi** |
| `purstream` | `free.finepulfe.xyz` | pulse · 1080 |
| `ophim` | `v7.kkphimplayer7.com` | Vietsub |
| `zoko` | `hls.dramahot.top` | **ZokoAnime** |

## Registered and proven

Source 3 is on the board. The contract, on a runner:

```
✓ source-1: resolved 2 candidate(s),  65536 segment bytes, 1480ms
✓ source-2: resolved 9 candidate(s), 2100702 segment bytes, 9224ms
✓ source-3: resolved 8 candidate(s),  242803 segment bytes, 1951ms
✓ source contract: 3/3 approved source(s) produced real bytes
```

Third lane on the board, 1.9 s, and the only one carrying anime.

The first contract run failed it — `candidate needs request headers or the CDN
will refuse the player` — because nxsha hands out per-row headers its media hosts
check, and the adapter was dropping them. That is the gate doing its job: an
adapter that looks right and cannot play was caught before it served anyone.

## Rules the adapter enforces

- `rive-*` filtered **by pattern**, not by a comment, because `rive-citadel` IS
  source-1 and including it would request one catalogue twice per resolve.
- `workers.dev`, relay-shaped hosts, Drive and `usercontent` pages refused — the
  same rules source-2 applies and the same reason six sources were rejected.
- per-row headers forwarded through an allowlist (UA, Referer, Origin only, no
  CRLF), so a provider cannot inject a header into the proxy.
- a rotated passphrase yields no candidates rather than an exception: a rotation
  is a quiet lane, not an outage.
- `query.signal ?? own timer`, never `AbortSignal.any` — which would make the
  caller's deadline irrelevant the moment this lane's own timer fired.
