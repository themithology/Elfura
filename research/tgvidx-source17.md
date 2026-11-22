# TGVIDX integration research

## Scope and identity

TGVIDX is an aggregator whose server list changes by title and over time, not a
single media provider. Source 17 resolves the public inventory using the
browser-observed TMDB movie/TV server-function request. It decodes the public
client-side wire obfuscation locally, without a browser, account, operator key,
or a Worker operated by the user. It rejects a mismatched title/type (and TV
season/episode if present), unsafe URLs, and its own player endpoints.

One registry source owns the full inventory, with individual returned streams
remaining separate playback candidates. This avoids inventing a fixed mapping
from dynamic server labels to independent providers. Player labels do not prove
provider or CDN identity. Source 17 was unused in the current registry; the
retired AniVortex integration previously used the same number.

| Observed TGVIDX label | Evidence and treatment |
| --- | --- |
| TG GREY ORION, ORION · HINDI, CARBON, MOON, PULSE, VALIANT | Included as separate dynamically discovered rows. Some go to Greybox `/api/media` or `/api/player/river/media`, others to provider/bridge URLs. Source 25 independently queries Greybox, so coverage may overlap. HTTP 429, 403, timeouts and HEVC-only streams were also observed. |
| TG STREAMHG | Included. TGVIDX `/api/public/stream-proxy` returned HLS manifests. Browser playback through the actual Source 17/Elfura relay was observed on movie 1303331, movie 550 and TV 1396 S1E1 on a GitHub runner. |
| TG MAGPIE | Included. The TGVIDX proxy returned DASH on movie 550 and TV 1396 S1E1. Samples advertised only HEVC video; Chromium on the test runner played audio without video. Source 17's player path now detects definitively HEVC-only DASH on unsupported devices and fails over; it remains available to devices that support HEVC. No successful HEVC browser playback is claimed. |
| TG NEST 2 | Included when returned, rather than being hardcoded to one title. Discovery was observed on TV 1396 S1E1 in one run; actual playback was not independently verified. |
| TG PIRATE / TG PIRATE 2 / 3 / 4 | Excluded because the user confirmed it is their own Elfura deployment. Feeding it into Elfura would create recursive discovery/relay paths, not a new provider. |

The dynamic parser accepts other supported HLS, DASH, or MP4 rows if TGVIDX
adds them, subject to identity and URL validation; it skips malformed or
unsupported rows. Subtitles stay attached to the row that supplied them; a
Hindi label is recorded only as an unverified language claim. The adapter does
not infer actual media quality or language from a server name.

## Evidence and limitations

- [Inventory research](https://github.com/themithology/Elfura/actions/runs/45033838563)
  observed different server sets for movie 1303331, movie 550 and TV 1396/1/1.
- [Direct HTTP media probe](https://github.com/themithology/Elfura/actions/runs/45034823827)
  independently decoded the inventory and fetched HLS/DASH manifests, recorded
  codec strings, and observed varying Greybox outcomes. It is not full playback.
- [Initial actual adapter browser run](https://github.com/themithology/Elfura/actions/runs/45034494193)
  observed video through Elfura for the three HLS samples. Its two HEVC DASH
  samples reached audio but not video on that runner; they were failures, not
  successful playback. A previous test accidentally reused cached HLS during
  its DASH cases; that earlier run is not evidence for DASH.
- [Compatibility retest](https://github.com/themithology/Elfura/actions/runs/45035067436)
  verified the HEVC-only DASH samples did not start audio-only on unsupported
  Chromium, and that a forced DASH selection fell back to working HLS.
- Results are from a GitHub runner, not the user's VPS or every browser. Source
  inventory, signed URLs, server-function hashes, the public transform, network
  availability and codecs may change; a protocol change can make this lane
  return no candidates until updated. No guarantee is made for all titles or
  each individual listed server.
