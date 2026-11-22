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

## Re:ZERO S1E1 additional lanes (TMDB 65942)

The live [TGVIDX inventory](https://github.com/themithology/Elfura/actions/runs/45035801401)
contained TG MAGPIE, TG STREAMHG, TG VIDSHARED and TG VIDARA, as well as
up to four self-referential TG PIRATE entries. The existing dynamic Source 17
already includes the first four without new adapter numbers; Pirate remains
excluded. Inventories varied between runs. Regression fixtures now cover the
new VIDSHARED and VIDARA names explicitly.

The [actual Source 17 browser test](https://github.com/themithology/Elfura/actions/runs/45036054654)
observed video for STREAMHG and VIDSHARED. Another run saw VIDSHARED time out
on segments, so it is not guaranteed reliable. VIDSHARED's HLS manifest exposed
Hindi and Japanese audio groups; that is manifest evidence, not verification of
the spoken language or audio switching. The video duration was about 52:40,
while TGVIDX's Pirate-selected video initially showed about 49:10; identity
and content equivalence of the files have not been independently checked.

VIDARA was discovered and its playlist and segment requests answered, but Elfura
failed to start video with `fragParsingError` in the
[diagnostic run](https://github.com/themithology/Elfura/actions/runs/45037145674).
A separate [TGVIDX player test](https://github.com/themithology/Elfura/actions/runs/45037145675)
selecting VIDARA also reached a "No playable source available" screen. The
cause of the media format problem is not established; no speculative decoder
or claim of VIDARA playback has been added. Magpie's HEVC limitation remains as
above. These are GitHub runner observations, not the user's VPS.

## Full-flow follow-up: slow inventory and grouped failover

The [transport comparison](https://github.com/themithology/Elfura/actions/runs/45048992544)
on a GitHub runner observed TGVIDX's current inventory call taking 8.2–8.6 s
for both Re:ZERO S1E1 and Fight Club. The actual TGVIDX browser made the same
call and successfully played Re:ZERO. The TLS-impersonating wreq alternative
received an immediate HTTP 403 in this sample, so it was not adopted.

An [initial full-board run](https://github.com/themithology/Elfura/actions/runs/45049007267)
showed a Re:ZERO discovery returning an apparent 403 at the 9 s shared abort;
a later retry succeeded at 8.1 s. The egress wrapper can return its original
403 when a retry is aborted, so that observation does **not** establish that
TGVIDX itself returned the final 403. The old deadline gave the call almost no
margin. Source 17 now gets up to 20 s for its discovery task, while the first
response and all other adapters keep their existing bounded deadlines; its
result joins through the existing late wave. Diagnostics distinguish an aborted
retry from a final 403. No resolver routing or health-balancing behavior changed.

In the [post-change full-flow test](https://github.com/themithology/Elfura/actions/runs/45049769316),
real adapters, four resolver HTTP nodes, the real relay and Chromium were used
with fixture TMDB metadata. Source 17's STREAMHG played for Re:ZERO S1E1,
Fight Club, Breaking Bad S1E1 and Dhamaal 4. Re:ZERO inventory returned in
8.95 s and Source 17 appeared in the player around 11.25 s; those times vary.
A cold source-only Re:ZERO embed returned at 9.31 s and played. Several other
TGVIDX lanes failed during that run: VIDARA had HLS demux errors, VIDSHARED
had fragment timeouts, and MAGPIE did not play on that Chromium. A manifest
probe is not evidence that video will play.

Another issue was visible in that full-board test: the UI groups TGVIDX's
independent upstreams as Source 17, but after a manually selected row failed,
the player preferred a different provider group over the other Source 17 rows.
Manual Source 17 failover now tries the group's remaining rows first; if a
language is selected it only prioritizes rows with matching language evidence,
and otherwise retains the existing cross-provider language search. All other
groups retain their prior automatic fallback order. A later [real-browser
full-flow run](https://github.com/themithology/Elfura/actions/runs/45051630097)
forced Re:ZERO MAGPIE and observed the player remain in Source 17 and reach
STREAMHG with video progressing. Its Source 17 inventory completed in 5.2 s
and appeared around 10.4 s. This is one sample, not a speed guarantee.

The same run recorded a guarded uncaught `TypeError` in Undici 6.29.1's HTTP/2
abort/queue code (`client.js` / `client-h2.js`). The test continued under the
same process guards used in production. Its frequency and effect on real VPSes
are unknown; it is not established as the TGVIDX failure, and a global transport
replacement has not been made without a reproducible regression test. Upstream
servers can still be down or incompatible, and the runner cannot prove the
user's VPS can reach them. TG PIRATE remains excluded to prevent recursion.

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
