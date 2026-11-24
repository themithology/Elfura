# VidLink as source 3 — the research

Commissioned because greybox throttles hard and a board of two is a board of one
when its second lane is rate-limited. Measured on runners; raw rows in
[object-overlap.json](object-overlap.json) and [independence.json](independence.json).

**Verdict: it is not a third source. It is vidora with a different API in front.**
That is not a judgement — one media object is byte-identical between the two, and
the evidence is below.

## What works

Everything technical about this adapter:

- The token mints locally from vidlink's own public player constant. No
  `enc-dec.app`, no third party anywhere in the resolve path. A unit test asserts it.
- `/api/b` accepted the minted token on **all four titles**: 3, 3, 4 and 2 media
  URLs. Movies and TV both answered.
- The payload reader handles both quality shapes (object and bare string), the
  `auto` playlist, and `streams[]`.
- A real defect inherited from the attic adapter is fixed: it used 24 **zero**
  bytes as the nonce, so the same id in the same second minted two identical
  tokens. Now random.

The lane is correct. It is refused on identity, not quality.

## The finding: it is vidora

Vidora was already measured on this repo. On `movie/27205` it returned:

```
https://bcdnt.hakunaymatata.com/resource/a58dd00af907b9b8cc3b5c04b1a422c9.mp4?sign=…
```

VidLink, on the same title, returned:

```
https://bcdn.hakunaymatata.com/resource/a58dd00af907b9b8cc3b5c04b1a422c9.mp4?sign=…
```

**`a58dd00af907b9b8cc3b5c04b1a422c9` is the same 32 hex characters in both.**
That is one encoded media object, served by two front-ends. Different subdomain
(`bcdnt` vs `bcdn`), different signature — same file.

The overlap is *partial*, not total, which is what makes it interesting:

| title | vidora | vidlink | shared |
| — | — | — | — |
| inception | `resource/a58dd00a…` | `resource/a58dd00a…` | **yes** |
| naruto s1e1 | `bt/d9353c37…` | `bt/9cc62a6e…`, `bt/d54cc239…` | no |
| fight-club | `paretocdn.site` | `bt/63f060bb…` | no |

So vidlink is not a pure mirror — it also carries a library vidora does not. But
it does serve at least one object vidora serves, from the same CDN, with the same
library naming. Two front-ends for one store is exactly what this board refuses.

## The finding nobody asked for: the board overlaps itself

The probe compared the two **approved** sources while it was there, and they are
not disjoint.

On fight-club, greybox handed out:

```
https://img1.hscow.com/hls/78164859/720/index_287.m3u8
https://img1.hscow.com/hls_mps/78164859/480/index_287.m3u8
```

`img1.hscow.com` is citadel's media host — source-1. And citadel's own row for
the same film is the same object:

```
hsc:78164859   citadel  (fight-club)
hsc:78164859   greybox  (fight-club)
hsc:210544560  citadel  (inception)
hsc:210544560  greybox  (inception)
```

Greybox serves part of its catalogue by **re-hosting citadel's rows through its
own proxy** (`/api/player/river/media?u=` wrapping an `img1.hscow.com` URL and
signing it).

This does not make source-2 worthless. Greybox answered with **7 languages** on a
title where citadel offers 2 candidates, its anime coverage is real, and it hides
the upstream on most rows behind `?u=m1.<base64>`. It does mean:

- The earlier claim that the board was "disjoint — the first evidence the board
  is not two names for one pipe" was **wrong**. It was based on hostnames, and
  the overlap lives one hop down, in the same place the vidlink finding lives.
- On the titles where greybox falls back to citadel's library, a viewer gains
  nothing from having both — and when greybox throttles, citadel still serves.
- The honest description of the board is *one large library, one aggregator that
  partly re-exports it and partly adds its own*, not two independent catalogues.

## Opacity limits what this can conclude

Measured across the run:

| lane | URLs handed out | distinct object ids named |
| — | — | — |
| source-1-citadel | 11 | 2 |
| source-2-greybox | 31 | 2 |
| source-3-vidlink | 12 | 12 |

Vidlink names every object in plain text. Citadel and greybox mostly do not —
citadel's `hsc:` ids come from only 2 of its 11 URLs, and greybox's majority rows
are `?u=m1.<base64>`, opaque by construction. So **the measured overlap is a
lower bound**: the true overlap between greybox and citadel may be larger, and
nothing in this run can rule that out.

## Where this leaves the board

Three lanes were examined, and the outcome is not the one the plan expected:

- **vidlink** — technically perfect, partially the same library as vidora, refused.
- **atlantic/vidbox** — upstream 502 on everything.
- **atlantic/q62** — plays, but on `proxy.7movie.ws`, a relay.

If a third source is still wanted, the next candidate has to be measured on
**object ids and library naming**, not on hostnames, and it has to clear the
board's own internal overlap as a baseline. The anime lanes (Novus, MegaPlay,
AnimeSalt) remain the only untested path that promises coverage the board has
none of — and the `hsc:`/`hex:` id comparison now exists to test them properly.
