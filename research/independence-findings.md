# What the independence probes actually found

Measured on GitHub runners. Raw rows: [independence.json](independence.json),
[measurements.json](measurements.json). This file is the reading of them, written
because two of the three candidates were rejected for reasons that a playability
test would never have surfaced.

## VidLink resolves to the board's third-party family

VidLink answered on **all four titles** — 3, 3, 4 and 2 media URLs. The local
token works: `/api/b` accepted a token minted from the public protocol constant,
with no call to `enc-dec.app` or any other service. The adapter, the mint and the
payload reader are all correct.

Then every one of those URLs answered **HTTP 429**, and the host underneath them
is:

```
bcdn.hakunaymatata.com
```

That host does not appear on the current board, so a host-equality check alone
would call VidLink independent. It is not. The `hakunaymatata` family is already
established in this repo's own research as the CDN behind **vidora**
(`bcdnt.hakunaymatata.com`), behind **AniVortex** (`sbcdnw.hakunaymatata.com`,
which answers 426), and behind every absolute row in **greybox**'s payload
(`sacdn.hakunaymatata.com`, via a `dash-hls-bridge.john1mc.workers.dev` shim).

So the family map is:

| family | lanes |
| --- | --- |
| `hakunaymatata.com` (`sacdn`, `bcdn`, `bcdnt`, `sbcdnw`) | greybox (absolute rows), vidora, AniVortex, **vidlink** |
| `hscow.com` / `fcxmb.com` | citadel |
| `greyboxtv.duckdns.org` | greybox (its own proxy rows) |

**VidLink is the same pipe as vidora, behind a different API.** Adding it would
give the viewer a third name for media that one upstream already serves, and the
429s say that upstream is rate-limiting anyway. It is not added.

### The lesson that changed the probe

Comparing *exact hostnames* is not independence testing. `sacdn`, `bcdn`, `bcdnt`
and `sbcdnw` are four names for one network, so a candidate resolves to
"independent" by choosing a subdomain nobody has used yet. The probe should
compare **registrable domains**, not hostnames, and it should treat a CDN family
as one dependency. Until it does, its independence verdict is a lower bound.

## Atlantic is two lanes with two different problems

| lane | result |
| --- | --- |
| `atlantic-vidbox` | **502 on all four titles.** The upstream itself is down; the payload is an error envelope (`error_code`, `error_name`, `error_category`), not an empty catalogue. |
| `atlantic-q62` | Plays: 131,072 bytes per movie, 1,392 / 1,481 segments. Movies only — 404 on both TV titles. |

q62's only media host is **`proxy.7movie.ws`**. It shares nothing with the board
and is still not addable: the hostname says `proxy`, which is exactly the
third-party relay front that source-2 refuses in its own adapter and that this
repo rejected for MoviesHubHD and Cinezo. A relay that happens to be independent
of the current board is still a relay.

## AniVortex: a known block, not a guess

Not probed by this run — the evidence predates it and is unambiguous: its media
hosts are on the same `hakunaymatata` family and answer **HTTP 426** to datacenter
IPs on every route tested. It would land in the same family as vidlink, with an
additional IP-based refusal.

## What this means

Three candidates were examined; none is addable, and **none was rejected for the
obvious reason**:

- Atlantic/vidbox: the upstream is down.
- Atlantic/q62: it is a relay.
- VidLink: correct in every respect, and behind the same CDN as everything else.

The board still has two sources, and the `hakunaymatata` family now has **four**
known front-ends that are not on it. That is the real map: this ecosystem is
narrower than its front-end count suggests.
