# Registered-source upstream audit (2026-11-20)

This is a historical snapshot before TGVIDX was added as Source 17. See
[tgvidx-source17.md](tgvidx-source17.md) for the later registry change.

## Scope and evidence

The actual registry contains **23 adapters**: 22 enabled under the standard
configuration, plus Source 6 (default off). Source 22 is subtitles-only, not a
video source: the default configuration therefore has 21 video adapters and
one subtitle adapter. Operator configuration, metadata, title coverage and
network access can change the effective set. The server-side relay is Elfura's
playback mechanism; it is distinct from using another player's discovery API or
another provider's media proxy.

This is a source-code and public-reference audit, not proof every source works
from every IP, not a count of independent media catalogues, and not a promise
of coverage. References below include older runner experiments, which must not
be silently treated as current deployment results. VPS logs previously supplied
showed many providers returning 403, 429 or network errors. These tests cannot
establish the cause or resolve those restrictions, and no VPS media playback
was tested here. Existing source paths remain in place.

## Every registered adapter

| ID | Discovery → observed or declared media path | Decision for this audit |
|---|---|---|
| 1 | VidBolt API → Orion movie `api.movy.lol`, TV `img.animecurx.tech` → `img.rousav.tech`/`gzip.rousav.tech`; also VidRift boot/Orion and VidRock APIs. | **Added optional direct Orion**, concurrently with all existing paths. Requires separately supplied movie/TV provider keys; unset means no direct request and preserves prior behavior. [Runner test](https://github.com/themithology/Elfura/actions/runs/45028582454) got master, audio/video playlists and segments for one movie and two TV titles, not browser playback or VPS proof. Unkeyed APIs returned 401. Movie quality labels have been observed wrong; keep auto quality behavior. VidRift and VidRock remain unchanged: no equally reliable separate identity/auth path was established. |
| 3 | VidSync `/api/stream` and `/api/core/streams`; provider proxy and possible raw fields. | **No safe replacement.** Past runner saw HTTP 200 HTML instead of JSON. Raw and proxied rows may encode different dub selections; do not unwrap on URL similarity alone. |
| 4 | Bingr watch page → per-server `/api/sources` → supplied media. | **No replacement.** Server identities and origins are dynamic; a public reference to `bingr.one`'s differently shaped API is not proof it is equivalent to this `bingr.st` protocol or the same episode/audio. Retain existing lanes. |
| 5 | Nxsha server inventory and per-scraper API, with optional ScreenScape set. See detailed lane table below. | **No blanket bypass.** Rive-backed entries have a separate Source 14 path, but equivalence of results/dubs is not guaranteed. Other scraper names do not supply a proven direct title-to-media protocol. Keep Nxsha and optional ScreenScape unchanged. |
| 6 | Telugu-filtered subset of Source 5 Nxsha. | **No replacement.** Default off and dependent on Nxsha; preserve the language filter and opt-in. |
| 8 | Direct VidZee `core.vidzee.wtf` servers `dcloud`, `tik`, `ipcloud`, `v6:Hindi` → media URL. | **Already direct discovery; no further safe bypass identified.** `v6` has historically produced Citadel-family hosts. Do not equate other server names or manufacture audio metadata. Existing reachable single-audio fix remains. |
| 9 | VixSrc API → VixSrc embed page token → signed HLS CDN. | **No replacement.** Manifest is direct but signed token is acquired through the provider; no verified stable title-to-token alternative. |
| 10 | VidNest per-lane encrypted API; six lanes below. | **No blanket replacement.** Source 8/24 and 11 provide independently resolved potential overlaps; Source 26 exists but is not registered. Retain all six VidNest lanes and validate media. |
| 11 | `streamdata.vaplayer.ru/api.php` → media; nextgencloudfabric is a public player reference. | **Already direct API; no further verified replacement.** A public extractor uses IMDb and different headers; this is only a lead, not evidence that it preserves TV episode identity or plays from the deployment. |
| 12 | VidZen server list → usually opaque same-origin `/api/stream/` URLs, sometimes provider URLs. | **No safe replacement.** Prefer explicit provider URLs already in payload; opaque URLs can represent any of 11 servers and are not reversible from evidence. Keep proxy path. |
| 13 | Xpass via freakyniki signed `/proxyv2`; embedded target hosts include `vip.1x2.space`, `tik.1x2.space`, `suprox.xpass.top`. | **No replacement.** Target is visible but direct playback, correct identity, headers and signing are unproven; earlier access was blocked. Retain signed proxy. |
| 14 | RiveStream scraper API → six providers; Citadel `img*.hscow.com`/`fcxmb.com`, PrimeVids `slowcloud.live`; FlowCast proxy rejected by existing policy. | **Already bypasses Nxsha for Rive API; no proven deeper discovery.** Preserve each lane, allow direct CDN results, and do not silently turn a third-party proxy into a raw source. |
| 15 | Mapple page tokens → seven server IDs `mapple`, `s25`, `s2`, `s1`, `s3`, `s4`, `s10` → returned media. | **No safe replacement.** Server names are not validated backend identities; token and episode binding must be preserved. |
| 16 | TMDB→AniList mapping → Mikaza Hindi resolve → returned media. | **No safe bypass.** Mikaza's resolved-language field is the evidence used; don't guess season/sequel or strip language-specific selection. |
| 18 | Blakite catalogue → `hugh.cdn.rumble.cloud` HLS/MP4. | **Already direct CDN path.** Anime/episode catalogue mapping and separate provider-labelled languages remain necessary. |
| 20 | MoviesAPI Vidora API → `paretocdn.site` or provider-selected worker relay. | **No general replacement.** Prefer supplied direct CDN using existing ranking; worker URLs are not safely reversible. User does not need to run a Worker. |
| 21 | Watchout catalogue on jsDelivr/GitHub raw → episode/movie media host. | **Already direct catalogue-to-media path.** CDN 404/reset is not fixed by changing the catalogue; no new host guessed. |
| 22 | Vidly API → subtitle URLs only. | **No video-source substitution.** Preserve subtitle-only behavior, existing language/identity checks and styled-subtitle rendering. |
| 24 | VidLink API → CDN media. Previously required external enc-dec token API first. | **Local token generation added**, with the old token service retained as fallback for empty/rejected local-token results (not 429/5xx). [Runner comparison](https://github.com/themithology/Elfura/actions/runs/45028346229) decrypted service tokens to the correct IDs and got API candidates using both paths on two movies and two episodes. MP4 liveness was inconclusive; this is not proof of media or browser playback. No external Worker is needed. |
| 25 | Greybox source API → absolute media and provider-relative proxy paths. | **Unchanged** per user instruction to leave the dedicated Greybox investigation. Earlier failures were intermittent/reset/429, not evidence for a safe replacement. |
| 28 | AnimeSalt catalogue → Ravok player endpoint → media. | **No safe replacement.** Already returns media rather than an embed, with strict season-one/episode-title matching. Prior real-player tests are documented in `anime-sub-dub-investigation.md`; subtitles were not established there. |
| 29 | AniZip mapping + NovusCloud API → raw HLS, restricted connection. | **Already direct.** Preserve conservative episode matching and restricted HTTPS; previously browser-tested samples do not establish universal coverage. |
| 30 | AniZip mapping + MegaPlay API → raw HLS, restricted connection. | **Already direct.** Preserve matching/security and existing fallback; previous tests found a repeatable dub-switch timeout for one sample. |

### Source 5: each configured Nxsha scraper

Names below are Nxsha's advertised scraper identifiers, **not verified independent
origins**. The decision is per lane: keep it through Nxsha because no verified,
equivalent standalone title/episode-to-media resolver was established, except
that the named Rive lanes also have the independent Source 14 route listed.

| Lane | Finding / disposition |
|---|---|
| nitro | Nxsha scraper; no independently verified raw discovery; keep. |
| mahalala | Nxsha scraper; no independently verified raw discovery; keep. |
| awsind | Nxsha scraper; Source 14 historically saw Rive `awsind` API errors; do not assume equality; keep. |
| rive-citadel | Source 14 separately queries Rive `citadel` and gets direct signed CDN rows; retain Nxsha too. |
| castle | Nxsha scraper; a VidSync provider of this name is not proven equivalent; keep. |
| streamflix | Nxsha scraper; historical Rive API returned error for similarly named lane; keep. |
| xdownloader | Nxsha scraper; no verified standalone resolver; keep. |
| vixolity | Nxsha scraper; no verified standalone resolver; keep. |
| rive-primevids | Source 14 separately queries Rive `primevids` and gets direct CDN rows; retain Nxsha too. |
| mhbox | Nxsha scraper; Rive API historically errored for same name; keep. |
| stvv | Nxsha scraper; Rive API historically errored for same name; keep. |
| imovr | Nxsha scraper; no verified standalone resolver; keep. |
| ophim | Nxsha scraper; no verified identity/episode mapping to a direct catalogue; keep. |
| yomovies | Nxsha scraper; no verified standalone resolver; keep. |
| vidapi | Nxsha scraper; Source 11 may overlap but same catalogue/audio is not proven; keep. |
| levi | Nxsha scraper; no verified standalone resolver; keep. |
| toonstream | Nxsha scraper; no verified standalone resolver; keep. |
| rive-flowcast | Source 14 also queries Rive `flowcast`, whose observed result was a third-party proxy and is rejected by Source 14; keep Nxsha policy unchanged. |
| rive-quasar | Source 14 also queries Rive `quasar`; historical probe timed out/empty; keep Nxsha too. |
| hdhub4u | Nxsha scraper; no verified standalone resolver; keep. |
| k4khdhub | Nxsha scraper; no verified standalone resolver; keep. |
| filmyfly | Nxsha scraper; no verified standalone resolver; keep. |
| moviesdrive | Nxsha scraper; no verified standalone resolver; keep. |
| movone | Nxsha scraper; no verified standalone resolver; keep. |
| zoko | Nxsha scraper; no verified standalone resolver; keep. |
| mbox (ScreenScape) | Optional Nxsha lane; MovieBox adapter exists but has a documented browser compatibility concern and is not registered; keep unchanged. |
| bdxs (ScreenScape) | Optional Nxsha lane; no verified standalone resolver; keep. |
| watchout (ScreenScape) | Source 21 uses Watchout's catalogue, but equality to the Nxsha result is unproven; keep. |
| rive-hindicast (ScreenScape) | Source 14 also queries Rive `hindicast`; historical runner timed out; keep Nxsha too. |
| purstream (ScreenScape) | Optional Nxsha lane; no verified standalone resolver; keep. |
| em-8 (ScreenScape) | Optional Nxsha lane; no verified standalone resolver; keep. |

### Source 10: each configured VidNest lane

| Lane | Finding / disposition |
|---|---|
| moviebox | Direct MovieBox adapter exists as Source 26, but is **not registered** due to HEVC browser compatibility; do not substitute it. |
| allmovies | Individual VidNest encrypted API lane; no verified independent title-to-media protocol; retain. |
| nextgencloudfabric | Public extractors associate the player with VAPlayer (`streamdata.vaplayer.ru`); Source 11 resolves that API separately, but exact equality is unproven; retain both. |
| vidzee | Source 8 directly queries VidZee servers; equivalence of every VidNest result is unproven; retain both. |
| vidlink | Source 24 queries VidLink itself; token dependency now avoidable locally; equivalence of every VidNest result is unproven; retain both. |
| onehd | VidNest encrypted API; no verified independent title-to-media protocol; retain. |

## Non-registered/merged paths

- Source 2 is intentionally disabled and unregistered; old endpoints are not reactivated.
- Source 7 was merged into Source 5 as optional ScreenScape lanes, still default off.
- Source 17 and 19 are not registered; historical reports refer to older registry versions.
- Source 26 MovieBox exists and has useful runner tests but **is not in the current registry** due to HEVC compatibility; earlier wording suggesting it was active was wrong.
- Source 27 exists in the tree but is not registered. Source 23 does not appear as an active adapter.

## Security and testing notes

Orion keys are optional environment values, not bundled in code. They are sent to
the corresponding upstream and can be included in its signed media URL, which
Elfura seals into playback tickets; they should be treated as credentials and
not put in logs or committed configuration. Configure `SOURCE1_ORION_MOVIE_KEY`
and/or `SOURCE1_ORION_TV_KEY` on each resolver only when authorized values are
available. The direct route does not replace the existing ones. Local VidLink
uses a public client protocol constant that can rotate; its fallback handles
protocol rejection without retrying on 429/5xx. Both additions respect normal
liveness and relay behavior; no resolver-balancing code is changed.

Existing research with further detail: `provenance-report.md`,
`flixfun-upstream-audit.md`, `sources-18-20.md`, and
`anime-sub-dub-investigation.md`. Existing reference reports may describe older
source registrations and filtering; the registry and this audit's dates govern.
