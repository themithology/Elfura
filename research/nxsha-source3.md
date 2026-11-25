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

## Verdict

**It is a genuine candidate for source 3** — the first one that has cleared
"different objects, not a different name for the same pipe". The measured
numbers support building it far more than vidlink's ever did.

It is **not registered**, and should not be until an adapter exists with:

- the four `rive-*` lanes filtered out by construction (they are source-1),
- `workers.dev` and relay-shaped hosts refused, as source-2 already does,
- the same measured-bytes contract gate as the board,
- a lane allowlist rather than all 30, tuned to what actually plays.

The retired adapter is a reference for the protocol, not a thing to restore: it
predates the zero-disk rule, the language fallback and the size ranking.
