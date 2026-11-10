# FlixFun upstream audit

Goal: trace the embed players listed by FlixFun to actual media candidates for Elfura, focusing on real language availability. An embed, a website responding, a provider's label, or an M3U8 URL is **not** proof of playable multilingual media. No provider in this audit has been newly integrated or fully browser-playback-tested here. Do not add Vidara or OFC.

## Scope

FlixFun's page lists 40 choices: VIP, vidsrc.mov, VidSrc.fyi, VidFast, VidUp, VidRock, Vidnest, VidLink, 111Movies.net, MultiEmbed, MappleTV, MoviesAPI, VidZee, VidRift, VidSrc.sh, VidSrc.su, VidSrc.buzz, APIPlayer, NontonGo, VidAPI.xyz, VidAPI.ru, VidCore.org, VidCore.io, VixSrc, EmbedBandit, VidLux, VidSpark, Embed-API, VidZen, Cinextream, YapGrid, VidBolt, Net79, EmbedMaster, Screenscape, RiveStream, 2Embed, AutoEmbed, MegaEmbed and Frembed. Page-reader output exposes the button IDs, not the actual iframe destinations. Therefore domain associations below are research leads, not proof of the exact FlixFun button target. VIP is opaque.

## Code inspected

- **ScreenScape:** [Nuvio provider source](https://github.com/Skywave22/Plugins-TJ/blob/e770752bc9d9d5acbec174f838c141ec9368d0d6/src/screenscape/plugin.skystream.js) uses Nxsha `api/servers` and `api/sources`, listing Nitro, MhPly, Citadel etc. Elfura already implements Nxsha as Source 5. Adding the wrapper would not automatically add an independent backend. Nuvio code claims Hindi and multi-audio, but labels must not be trusted as proof of audio.
- **RiveStream:** [Nuvio provider](https://github.com/Skywave22/Plugins-TJ/blob/e770752bc9d9d5acbec174f838c141ec9368d0d6/src/rivestream/plugin.skystream.js) fetches its named Rive lanes through Nxsha; Elfura Source 5 already requests several. A separate [Hostreamio adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/rivestream.dart) uses a RiveStream scraper API. Dedupe and security review required.
- **VidNest:** [Nuvio MoviesHubHD adapter](https://github.com/Skywave22/Plugins-TJ/blob/e770752bc9d9d5acbec174f838c141ec9368d0d6/src/movieshubhd/plugin.skystream.js) lists `new.vidnest.fun` per-provider API (`allmovies`, `nextgencloudfabric`, `onehd`, `flixhq`, etc.). It describes nonce + AES-GCM responses and separate language-labeled rows; relative paths can depend on third-party relay workers. It also says MoviesHubHD's NontonGo lane uses this API; this does not prove FlixFun's NontonGo button does. A bounded public request via page retrieval returned v2 encrypted responses for Dune (693134) for allmovies and nextgencloudfabric; onehd returned a Cloudflare 502. A partial, unauthenticated CTR prefix inspection of nextgencloudfabric response exposed a stream labeled Original, HLS, with a nextgencloudfabric Origin/Referer. This is NOT an authenticated decryption, a verified playable manifest, or evidence of Hindi. Use Node AES-GCM authentication for a proper prototype, not the reference's unchecked CTR. Avoid adding external relays without explicit review.
- **VidAPI:** [Hostreamio adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidapi.dart) identifies `streamdata.vaplayer.ru/api.php` and `nextgencloudfabric.com`; VidNest's nextgencloudfabric lane may overlap. This does not prove whether FlixFun's .xyz and .ru buttons share it. Do not claim independent servers without resolving media fingerprints.
- **VidFast and VidUp:** [VidFast adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidfast.dart), [VidUp adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidup.dart), and [merger](https://github.com/NEOpro-cyper/vidfast-vidup-merger) describe server lookup plus enc-dec.app encryption/decryption; merger uses node-libcurl because normal fetch can receive Cloudflare 403. Not established as Hindi/multi-audio or suitable for Elfura's startup latency. External dependency and native module require review.
- **VidLink:** [Hostreamio adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidlink.dart) uses vidlink.pro and an external encrypt endpoint. No real track or playback verification performed.
- **VidCore.org:** [Hostreamio adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidcore.dart) handles HLS candidates. Does not establish that VidCore.io is the same service or has same protocol. No audio verification.
- **VidRock:** [Hostreamio adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidrock.dart) describes AES-GCM; Elfura already has a VidRock lane. The reference uses a different domain, so identity/availability require checking.
- **VidZee:** [Hostreamio adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidzee.dart) lists language-labeled media candidates; VidNest also lists a `vidzee` lane. No audio confirmed.
- **VixSrc:** [Hostreamio adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vixsrc.dart) resolves VixSrc, but playback/audio languages need testing.
- **MappleTV:** [Mapple adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/mapple.dart) uses `mapple.club` encryption and stream endpoints; mapping to FlixFun's button and audio availability are unverified.
- **MultiEmbed and 2Embed:** the [Hostreamio MultiEmbed adapter](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/multiembed.dart) actually uses `2embed.cc` then `play.xpass.top`; it does not prove FlixFun's MultiEmbed uses that path. Possible overlap, no verified dub.
- **VidRift and VidBolt:** existing Elfura Source 2 lane and Source 1 respectively. Past synthetic/live source and browser tests exist in this repo, but do not establish current availability of every title.

## Players without a deeper trace (prior to first-pass inventory below)

VIP, vidsrc.mov, VidSrc.fyi, 111Movies.net, MoviesAPI, VidSrc.sh, VidSrc.su, VidSrc.buzz, APIPlayer, NontonGo (only an indirect reference above), VidAPI.xyz vs VidAPI.ru domain mapping, VidCore.io, EmbedBandit, VidLux, VidSpark, Embed-API, VidZen, Cinextream, YapGrid, Net79, EmbedMaster, AutoEmbed, MegaEmbed, Frembed. They must not be called dead or multilingual based on lack of evidence. Confirm exact FlixFun target before assuming identical provider names point to the same system.

## Next verification steps

1. Prototype authenticated VidNest v2 decoding with fixture tests, bounded requests, cancellation, SSRF protection, safe header handling and no third-party relays unless explicitly approved. Never select rejected providers.
2. On a network that can actually reach the provider from the Elfura server, test multiple movie and TV TMDB IDs, manifest/child/segment fetches and actual playback; check HLS audio renditions or distinct labeled dubs, and verify spoken language where possible. Record latency and failures. A single HTTP 200 does not prove playback.
3. Follow the remaining players individually; map direct upstream hosts and compare against current adapters before integration. Keep discovery outside the startup critical path and do not silently add unverified sources.

No GitHub Actions were used for this audit. The sandbox's direct network cannot fetch arbitrary providers; browser/page retrieval can reach some public endpoints but is not a replacement for server-side playback testing.

## First-pass inventory: all 40 buttons

Each row has been searched individually; **lead** means a public implementation or documentation was found, not that it works or fits Elfura. Audio is **unknown unless stated as a claim**. For every row, the exact FlixFun iframe target remains unverified because the accessible rendering only reveals button fragments.

| # | FlixFun choice | Research result / next step |
|---|---|---|
| 1 | VIP (No ADS) | Opaque label; no reliable origin or upstream mapping found. Needs the actual player request. |
| 2 | vidsrc.mov | [Site](https://vidsrc.mov/) documents TMDB/IMDb embeds. Direct upstream and dubs unknown; don't assume the various VidSrc domains share a backend. |
| 3 | VidSrc.fyi | [Site](https://vidsrc.fyi/) documents embeds and multilingual subtitles; direct upstream/audio unverified. |
| 4 | VidFast | [Extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidfast.dart) uses vidfast.vc + enc-dec.app; native Node fetch may be Cloudflare-blocked per the merger repo. No verified dub. |
| 5 | VidUp | [Extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidup.dart) uses vidup.to + enc-dec.app; no verified dub. |
| 6 | VidRock | Existing Elfura Source 2 lane; [reference](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidrock.dart) uses AES-GCM on another domain. Current languages not established. |
| 7 | Vidnest | VidNest per-provider JSON/AES-GCM reference and partial observation above. Hindi unknown until manifests and audio verified. |
| 8 | VidLink | [Extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidlink.dart) uses vidlink.pro + enc-dec.app. Actual tracks and latency unverified. |
| 9 | 111Movies.net | [Site](https://111movies.net/) says aggregator. Extractor/upstream identity and audio unknown. |
| 10 | MultiEmbed | [This reference](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/multiembed.dart) uses 2embed and XPass, but exact FlixFun mapping unproven. Audio unknown. |
| 11 | MappleTV | [Documentation](https://mappletv.uk/) now references mapple.fun and claims multiple audio tracks; [extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/mapple.dart) uses mapple.club, so domain/protocol mismatch must be resolved. |
| 12 | MoviesAPI | [Stremio scraper README](https://github.com/gauravsuman007/stremio-tv-scrapers-web-vod) describes a moviesapi.to JSON endpoint with a player key and HLS, but the repository could not be cloned during this audit. No independent verification or language proof. |
| 13 | VidZee | [Reference extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidzee.dart) has language-labeled rows; labels and liveness unverified. May overlap with VidNest. |
| 14 | VidRift | Existing Elfura Source 2 lane; no current playback/audio proof for every title. |
| 15 | VidSrc.sh | [Official domain page](https://vidsrc.domains/) identifies it as primary; old VidSrc extractors are not proof current protocol works here. No audio proof. |
| 16 | VidSrc.su | [Site](https://vidsrc.su/) claims multi-server embed; no reliable upstream/audio mapping yet. |
| 17 | VidSrc.buzz | [Site](https://vidsrc.buzz/) advertises subtitles; no direct extraction or dub proof. |
| 18 | APIPlayer | [Site](https://apiplayer.ru/) documents subtitles/player; third-party [catalog](https://github.com/LyeDevGit/free-streaming-apis) reports a stopped page, conflicting with accessible documentation. No direct-stream verification. |
| 19 | NontonGo | [Site](https://nontongo.win/) documents TMDB and IMDb iframe routes. A Nuvio adapter links a *different site's* NontonGo lane to VidNest; not sufficient to identify this button's upstream. |
| 20 | VidAPI.xyz | [Site](https://vidapi.xyz/) claims multiple audio sources. Exact extraction, Hindi and association with .ru must be validated. |
| 21 | VidAPI.ru | [Site](https://vidapi.ru/) documents vaplayer.ru embeds. [Extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidapi.dart) references vaplayer API/nextgencloudfabric; overlap with VidNest possible. |
| 22 | VidCore.org | [Extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidcore.dart) can emit HLS; site's FAQ claims dubbed audio. Neither live audio nor playback tested. |
| 23 | VidCore.io | [Resolver README](https://github.com/titan717/vidcore-io-stream-resolver) describes session tokens, rotating player crypto, catalog unlock, HLS and referer relay. Repository clone returned not found; availability and license need review. Not assumed equivalent to .org. |
| 24 | VixSrc (Italian) | [Extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vixsrc.dart) describes direct HLS. Third-party reports multi-audio on some titles; no current Elfura test. |
| 25 | EmbedBandit | [Site](https://embedbandit.com/) offers iframe + server selection; docs name a Bolo server but no verified media endpoint or dubs. |
| 26 | VidLux | [Documentation](https://vidlux.site/) lists `vidrock` and `vixsrc` as two lanes, plus others; potential duplication. Operator claims multi-audio; not validated. |
| 27 | VidSpark | [Site](https://vidspark.to/) describes embeds and subtitles. [Third-party parser](https://github.com/oe-mirrors/e2iplayer/pull/745) claims shared moviesapi.to/cdn.vidspark.to player protocol; not independently confirmed. |
| 28 | Embed-API | [Site](https://watch.embed-api.stream/) says it uses external providers including VidSrc. Exact backend/FlixFun mapping, raw media and audio unknown. |
| 29 | VidZen | [Site](https://vidzen.fun/) advertises a Helios multi-audio engine and Neptune CloudFabric. These are claims/labels only; no extraction protocol or verified tracks. |
| 30 | Cinextream | [Site](https://cinextream.cc/) documents Vidstack embeds and anime sub/dub routes, not direct HLS or Hindi movie audio. |
| 31 | YapGrid | [Documentation](https://github.com/enikqi/yapgrid) describes iframe, subtitles, and server selection. Direct stream and dubbed audio unknown. |
| 32 | VidBolt | Already Elfura Source 1; [site](https://vidbolt.xyz/) claims selectable Hindi, Tamil and English where available. Previous tests did not guarantee all titles. |
| 33 | Net79 | A [third-party page](https://netmirror.io/download/web/) associates net79.cc with NetMirror and claims multi-audio. Exact button destination, authentication and extractability unknown. |
| 34 | EmbedMaster | [Provider inventory](https://github.com/LyeDevGit/free-streaming-apis) says embedmaster.com may require login/API key. No current direct-stream or language proof. |
| 35 | Screenscape | Nuvio adapter uses Nxsha; existing Elfura Source 5 partly overlaps. Source ID/name equivalence with the actual FlixFun button remains unconfirmed. |
| 36 | RiveStream | Nuvio adapter uses Nxsha Rive lanes, and a separate reference uses RiveStream scraper API. Language labels and duplicate hosts need verification. |
| 37 | 2Embed | [MultiEmbed reference](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/multiembed.dart) traces 2embed.cc to XPass. Actual FlixFun destination and language availability unverified. |
| 38 | AutoEmbed | [Reference inventory](https://github.com/Astralchemist/tmdb-embed-providers) distinguishes autoembed.co and .cc; exact FlixFun domain/unwrapped media unknown. |
| 39 | MegaEmbed | [Nuvio plugin](https://github.com/viniwalkersp2023/testeeeeee) describes MegaEmbed → viewplayer.online → encrypted embed, returning iframe rather than direct streams. Portuguese-focused; no verified Hindi. |
| 40 | Frembed (French) | [Extractor PR](https://github.com/kacigaya/binje/pull/51) describes metadata + Uqload/Netu extraction and French/original options. It is not evidence of Hindi. |

This is a complete first-pass **inventory**, not a complete reverse engineering or live verification of all 40. Several rows remain unresolved. No runtime integration, deployment or GitHub Actions were performed.

## Further code review: ScreenScape and CinePro

- The [ScreenScape plugin](https://github.com/Skywave22/Plugins-TJ/blob/e770752bc9d9d5acbec174f838c141ec9368d0d6/src/screenscape/plugin.skystream.js#L324) explicitly describes ScreenScape's Scape server as Nxsha, and queries all announced lanes except `ophim` concurrently. It lists additional potential lanes such as `mbox`, `bdxs`, `watchout`, `rive-hindicast`, `filmyfly` and `em-8` that Elfura's fixed Source 5 allowlist does not request. It also filters embed-only responses, applies TV season-pack heuristics and verifies streams. More listed lanes are not proof of better working HLS or reliability; some can be files, wrong episodes, or embeds. User wants ScreenScape and existing Nxsha **both retained**, accepting duplication, after research. Need evaluate bounded concurrency, compatible HLS, and latency before any implementation.
- Inspected [CinePro core commit 98ba005](https://github.com/cinepro-org/core/tree/98ba005f75d2675877774f5a676b3bc1c4150c27/src/providers) as independent code leads. VidAPI uses `streamdata.vaplayer.ru/api.php` and `stream_urls`; VidNest maps several individually decrypted providers including allmovies and vidlink; VidRock targets vidrock.net including lok-lok header handling; VidZee requests `player.vidzee.wtf/api/server` then decrypts URLs; VixSrc resolves its API to a second page and constructs a tokenized playlist; its VidSrc implementation targets `vsembed.ru` and cloudnestra, **not proven to match any of the four FlixFun VidSrc labels**. These are static implementations, not live results or audio verification.

## First layer: candidate player origins (not confirmed FlixFun iframe targets)

This table distinguishes the player layer from underlying hosts. Candidate domains are from the provider documentation or the referenced implementations in the inventory above. A matching label or official-looking page does **not** confirm that FlixFun uses that domain. Latest retrieval of FlixFun watch page returned a JavaScript/cookie human-check, so its actual button-to-iframe mapping could not be inspected in this environment. Exact targets: **0/40 independently verified**. No counts here mean working streams.

| # | Button | Candidate first-layer origin / finding |
|---|---|---|
| 1 | VIP | Unknown: generic label, no defensible match. |
| 2 | vidsrc.mov | `vidsrc.mov` (domain explicitly in label; [docs](https://vidsrc.mov/)). |
| 3 | VidSrc.fyi | `vidsrc.fyi` (domain in label; [docs](https://vidsrc.fyi/)). |
| 4 | VidFast | `vidfast.vc` per Hostreamio; also `.pro` in other implementations; exact choice unknown. |
| 5 | VidUp | `vidup.to` per Hostreamio. |
| 6 | VidRock | `vidrock.net` per Elfura/CinePro; other domains exist. |
| 7 | Vidnest | `vidnest.fun` embed, `new.vidnest.fun` API in cited source. |
| 8 | VidLink | `vidlink.pro` per Hostreamio. |
| 9 | 111Movies.net | `111movies.net` (label and [docs](https://111movies.net/)). |
| 10 | MultiEmbed | `multiembed.mov` per [third-party list](https://github.com/LyeDevGit/free-streaming-apis); Hostreamio uses 2embed.cc under its MultiEmbed adapter. Exact target unknown. |
| 11 | MappleTV | [mappletv.uk](https://mappletv.uk/) documents `mapple.fun`; older extractor uses `mapple.club`. |
| 12 | MoviesAPI | `moviesapi.to` per third-party parser. |
| 13 | VidZee | `vidzee.wtf` family (`player.vidzee.wtf`, `core.vidzee.wtf`) per CinePro; actual embed origin unknown. |
| 14 | VidRift | `embed.vidrift.in` per current Elfura adapter. |
| 15 | VidSrc.sh | `vidsrc.sh` (domain in label; [domain listing](https://vidsrc.domains/)). |
| 16 | VidSrc.su | `vidsrc.su` (domain in label; [docs](https://vidsrc.su/)). |
| 17 | VidSrc.buzz | `vidsrc.buzz` (domain in label; [docs](https://vidsrc.buzz/)). |
| 18 | APIPlayer | `apiplayer.ru` candidate; conflicting status reports above. |
| 19 | NontonGo | `nontongo.win` candidate ([docs](https://nontongo.win/)). |
| 20 | VidAPI.xyz | `vidapi.xyz` (domain in label). |
| 21 | VidAPI.ru | `vidapi.ru` (label); [docs](https://vidapi.ru/) direct embeds to `vaplayer.ru`. |
| 22 | VidCore.org | `vidcore.org` (label). |
| 23 | VidCore.io | `vidcore.io` (label); treat separately from `.org`. |
| 24 | VixSrc | `vixsrc.to` per CinePro/Hostreamio. |
| 25 | EmbedBandit | `embedbandit.com` ([docs](https://embedbandit.com/)). |
| 26 | VidLux | `vidlux.site`, `.xyz`, `.online`, `.top` ([docs](https://vidlux.site/)); exact host unknown. |
| 27 | VidSpark | `vidspark.to` ([docs](https://vidspark.to/)). |
| 28 | Embed-API | `watch.embed-api.stream` ([docs](https://watch.embed-api.stream/)); other embed-api hosts exist. |
| 29 | VidZen | `vidzen.fun` ([docs](https://vidzen.fun/)). |
| 30 | Cinextream | `cinextream.cc` ([site](https://cinextream.cc/)); page also shows cinextream.net examples. |
| 31 | YapGrid | `yapgrid.com` ([docs](https://github.com/enikqi/yapgrid)); [third-party plugin](https://github.com/zxuru/nn-anime-plugins) reports default VixSrc engine, not independently verified. |
| 32 | VidBolt | `vidbolt.xyz` per current Elfura adapter. |
| 33 | Net79 | `net79.cc` possible NetMirror site; not verified as FlixFun's target or as an embed API. |
| 34 | EmbedMaster | `embedmaster.com` ([site](https://embedmaster.com/)) and `embedmaster.link` exist; exact target/access requirements uncertain. |
| 35 | ScreenScape | `screenscape.me` and its nxsha embed per [plugin](https://github.com/Skywave22/Plugins-TJ/blob/e770752bc9d9d5acbec174f838c141ec9368d0d6/src/screenscape/plugin.skystream.js); additional domains [embed](https://embed.screenscape.me/) and [flix](https://flix.screenscape.me/) exist. |
| 36 | RiveStream | `rivestream.app` candidate per Hostreamio; plugin resolves Nxsha Rive lanes. Exact target unknown. |
| 37 | 2Embed | `2embed.cc` candidate per Hostreamio, also `.stream` and other variants; exact target unknown. |
| 38 | AutoEmbed | `autoembed.co` and `.cc` are distinct candidates; exact target unknown. |
| 39 | MegaEmbed | Third-party plugin references viewplayer.online / megaembed.link; target not established. |
| 40 | Frembed | French player; reviewed extractor PR but exact FlixFun origin unknown. |

All candidate mappings remain provisional, including exact-domain labels, until FlixFun's real player request is inspected. The table's sources identify plausible services, not an independently validated button mapping. First-layer investigation remains blocked on that observation; direct-stream/audio testing remains a separate next phase. No app changes.

## Multi-language audio shortlist (research leads; not verified playback)

Ranked for Hindi relevance and extraction leads, not measured reliability. Claims are title-dependent; a label, player feature, subtitles, or advertised server is not proof that an accessible Hindi audio rendition exists. Exact FlixFun mappings remain unconfirmed.

1. **ScreenScape** — [Nuvio source](https://github.com/Skywave22/Plugins-TJ/blob/e770752bc9d9d5acbec174f838c141ec9368d0d6/src/screenscape/plugin.skystream.js) checks Hindi/multi labels and Nxsha lanes including `rive-hindicast` and `em-8`. Existing Nxsha Source 5 covers a subset. User explicitly wants both retained; no track testing yet.
2. **VidZee** — [third-party resolver](https://github.com/utubysdog/free-movies-api) describes a `v6:Hindi` server and language-bearing response; no independent test or proof for any title.
3. **VidBolt** — [operator docs](https://vidbolt.xyz/) claim selectable Hindi, Tamil, English and other audio, when available. Already Elfura Source 1; current track coverage not reverified.
4. **VidNest** — [plugin](https://github.com/Skywave22/Plugins-TJ/blob/e770752bc9d9d5acbec174f838c141ec9368d0d6/src/movieshubhd/plugin.skystream.js) processes language labels and prioritizes Hindi; its lanes may be duplicates or original-only. Previous partial decrypt is not authenticated or Hindi proof.
5. **VidLux** — [forum description](https://www.wjunction.com/threads/free-vidlux-premium-embed-player-for-movie-tv-streaming-sites-9-servers-auto-fallback-multi-language.272161/) claims selectable English/Hindi; [docs](https://vidlux.site/) identify VidRock and VixSrc among its servers. Extraction and tracks unverified.
6. **VidAPI.xyz** — [operator](https://vidapi.xyz/) claims it collects multiple audio sources; no Hindi-specific proof or direct extractor for this domain yet. Do not assume identical to VidAPI.ru.
7. **VidZen** — [operator](https://vidzen.fun/) claims a multi-audio Helios engine; Hindi, protocol and playback unverified.
8. **MappleTV** — [operator](https://mappletv.uk/) claims multiple audio tracks; Hindi and current extractor-domain match unverified.
9. **VidCore.org** — [operator](https://vidcore.org/) claims available dubbed audio; no Hindi-specific proof or playback test.
10. **Net79** — [third-party reference](https://netmirror.io/download/web/) associates net79.cc with multilingual NetMirror; actual FlixFun target and direct access unverified.
11. **RiveStream** — [historical third-party capture](https://www.joesandbox.com/analysis/1509149/0/html) shows a `Hindi`-labeled source at rivestream.live in 2024; may not match present FlixFun player or Nxsha's Rive lanes. Not proof of today's audio.
12. **VixSrc** — [third-party implementation](https://github.com/qwertyuiop8899/prisynx_cs3) reports Italian plus multi-audio HLS; useful for multilingual coverage but Hindi is not established. YapGrid and VidLux may route here.
13. **Frembed** — [extractor PR](https://github.com/kacigaya/binje/pull/51) describes French vs original streams; worthwhile for non-Hindi language coverage, not evidence of Hindi.

The other 27 choices have insufficient audio-specific evidence in this audit. That is **unknown**, not a finding that they lack dubs; continue examining them before ruling them out. Next phase: authenticate/decrypt responses where relevant, check manifests for audio renditions or separately labeled files, verify correct title/episode and actual playback, measure startup, and confirm spoken language. No sources added.

### MovieBox lead

[CinePro VidNest adapter](https://github.com/cinepro-org/core/blob/98ba005f75d2675877774f5a676b3bc1c4150c27/src/providers/vidnest/vidnest.ts) defines a `moviebox` lane and maps `url[].lang`, `link`, and `type` into stream candidates. This is static code, not proof of current MovieBox origin, playable links, or Hindi. ScreenScape lists an `mbox` lane but its identity is unconfirmed. Include both in later checks; do not equate them without evidence.

## Ordered reverse-engineering log

Work through the 40 choices in the inventory order. An unresolved entry stays open rather than blocking the rest; no title is marked playable or multilingual without actual tests.

### 1. VIP (No ADS) — unresolved

- **First layer:** label only. The accessible [FlixFun watch page](https://flixfun.st/watch/movie/1423191) now returns a JavaScript/cookie human-check rather than the player markup. Public searches for this label with FlixFun did not identify an origin. Generic VIPEmbed/SuperEmbed search matches are not evidence that FlixFun uses them.
- **Extraction / underlying media:** unknown; no target URL or protocol to reverse engineer yet.
- **Audio and playback:** unknown. No live source was tested. The check response is not evidence that the player is offline.
- **Status / next step:** keep open and revisit if the button destination becomes observable; continue to #2 rather than inventing a mapping.

### 2. vidsrc.mov — embed responds, extraction unresolved

- [Provider documentation](https://vidsrc.mov/) specifies `/embed/movie/{id}` and `/embed/tv/{id}/{season}/{episode}` using TMDB/IMDb IDs. This is an iframe interface, not a media URL.
- Page retrieval of [TMDB 693134](https://vidsrc.mov/embed/movie/693134) returned the Dune: Part Two title three times, but no player requests, media URL, manifest, tracks, or playback evidence. Exact FlixFun mapping still unobserved.
- Search results surfaced extractors for other VidSrc domains; no .mov-specific direct extraction was established. The CinePro `vsembed.ru` implementation must not be assumed to apply here. Hindi and playback unknown.
- Next: observe this embed's network/JS on a reachable environment and trace its own server selection, then validate manifest/audio. Continue to #3 meanwhile.

### Ordered checks 3–11 and cross-checks (one test title)

On 2026-11-04, page-reader inspection of TMDB movie 693134 gave the following. Rendered UI, loading timers and HTTP responses do not establish actual audio, direct extraction, stream reliability, or FlixFun's exact button mapping. A rendered player may have executed remote JavaScript; the reader does not expose its network traffic.

3. **VidSrc.fyi:** embed rendered the movie name; no tracks or sources exposed. Unknown.
4. **VidFast:** four displayed server labels said original audio. This title/UI does not show multi-audio, but other titles may differ; not sufficient to exclude provider entirely.
5. **VidUp:** two displayed server labels said original audio for this title. No multi-audio verified.
6. **VidRock:** displayed title and player only. Existing lane retained; no multi-audio evidence from this page.
7. **VidNest:** MovieBox endpoint without nonce returned `missing or invalid nonce`; a valid-shaped nonce returned a large encrypted `d` payload. No authenticated decode or playback, so no audio conclusions. Never save URL as playable media.
8. **VidLink:** rendered an Audio setting but no audio choices; Hindi appeared under captions/subtitles, which is not Hindi audio. Unverified.
9. **111Movies.net:** movie test redirected to `player.vidmario.net` and displayed player/timing; no audio evidence and no attribution to actual FlixFun route.
10. **MultiEmbed:** no new direct extraction or language result; remains open.
11. **Mapple:** rendered three server names but no track details; the operator claims multiple audio, still unverified.

Other bounded page checks to inform later numbered entries: **VidSrc.sh/su/buzz**, **NontonGo**, **VidAPI.ru**, **VidCore.org/io**, **VidLux**, **VidSpark**, **VidZen** and **YapGrid** rendered some form of player/title without sufficient multilingual-audio evidence. VidCore.io labels for this title said original audio. MoviesAPI's tested URL returned VidSpark; do not infer common hosting or current playback solely from redirect. A guessed VidZee path returned 404 and guessed VidAPI.xyz path returned 'No input file specified'; those are route observations, not proof of outage. **VixSrc**'s rendered page included Italian and English in player UI adjacent to subtitle settings, a useful lead but insufficient to establish that they are playable audio renditions. **Cinextream** displayed a `Timora [Multi]` server and an unavailable error; the label is not proof of audio or playback. These remain unverified. No application change or source registration made.

### Experimental ScreenScape implementation

Source 7 is an **opt-in experiment**, not a live-verified provider: `ELFURA_SCREENSCAPE_ENABLED=1` enables it, default is disabled. It calls the existing Nxsha protocol on six additional bounded ScreenScape plugin lanes, retains Source 5 unchanged, and returns reachable HLS candidates with either manifest multi-audio or an unambiguous language label (a label is not verified speech). The test suite uses mocked manifests; it does not prove real provider availability, correct episode, spoken language, media segment access or end-to-end playback. It doesn't add every plugin lane, and the current client background-recovery list does not include Source 7, so a slow result may only be available on later requests or an explicit source selection. This requires real deployment validation before promoting it.

### VidZee and separate-dub policy

The [VidZee reference](https://github.com/utubysdog/free-movies-api/blob/main/providers/vidzeeCrypto.js) reports `core.vidzee.wtf/streams` with `e=0`; the older Hostreamio API route returned 404. Page retrieval for Dune 693134 produced a Hindi-labelled URL from `v6:Hindi` and an `Auto` URL from `dcloud`; `tik` returned a 502 and `ipcloud` returned unknown server. This is not playback or spoken-language proof. The signed Hindi media request from the page reader returned invalid signature; cause unknown.

Source 8 is an experimental direct adapter, off by default. Its fixed server list, URL/header validation, HLS filtering and liveness checks retain reachable manifest-proven multi-audio and clearly language-labelled individual dubs; it does not call subtitle support audio and does not use third-party relay services. The user clarified separate dubs are desired, so Source 7 now does the same. Both have only mocked unit tests, and user-facing language labels are upstream claims unless verified in a manifest. Existing player recovery has a static source group list, so late results for sources 7/8 may require explicit selection or a later request. Actual playback, audio, availability, episode identity, and performance remain unverified on the deployed environment.

### Update: active candidates and VixSrc

Following the user's request to avoid individual manual testing, Sources 7 (ScreenScape lanes), 8 (VidZee), and 9 (VixSrc) are now enabled by default; set the respective `ELFURA_SCREENSCAPE_ENABLED`, `ELFURA_VIDZEE_ENABLED`, or `ELFURA_VIXSRC_ENABLED` to `0` to disable one. This supersedes earlier statements that Sources 7 and 8 default to off. They remain experimental: no deployment playback or spoken-language confirmation is claimed. Source 9 uses the VixSrc API's relative embed path and the signed HLS playlist from its page, with no execution of provider JavaScript or third-party relay. The movie and episode API returned relative embed references through page retrieval; mocks exercised extraction and manifest audio handling. The test suite's integration fixtures disable these external providers explicitly. Source 7/8/9 can miss the client-side late group recovery, as noted above. No assertion is made that these adapters cover every source in the 40-player inventory.

### VidNest direct adapter (Source 10)

The experimental VidNest adapter queries six fixed upstream lanes (including `moviebox`) using a fresh random nonce and authenticates v2 AES-GCM before parsing. It accepts only public absolute HLS or MP4 links, strips unsafe/unnecessary headers, rejects embed links, rejected providers and relative third-party relay links, and only retains reachable candidates with manifest multi-audio or an unambiguous language label. A label is not proof of the spoken track. The MovieBox path has returned an encrypted payload via page retrieval, but its contents and end-to-end playback have not been verified. It is enabled by default; `ELFURA_VIDNEST_ENABLED=0` disables it. Tests cover synthetic authenticated envelopes, tampering, unsafe URLs, individual dubs, multilingual manifests and a fast-source startup race with hung new adapters; none is a live playback test. Existing late recovery does not enumerate the added sources, so some results can miss the first response. VidNest may overlap with other sources; it is not a guarantee of independent media coverage.

### VidAPI.ru / VAPlayer (Source 11)

Page retrieval of `streamdata.vaplayer.ru/api.php` for TMDB 693134 and TV 1396 S1E1 returned JSON with `stream_urls`; movie/episode identity fields were present in these examples, but there were no audio language labels. The new direct adapter uses this API, verifies the season/episode fields when supplied, validates URLs, and only promotes HLS whose live manifest exposes at least two languages. It does not treat subtitles, a filename, or an `Original` label as multilingual audio. This is the .ru/VAPlayer lead and not evidence that VidAPI.xyz uses it. It can overlap VidNest's NextGenCloudFabric lane. Enabled by default (`ELFURA_VAPLAYER_ENABLED=0` disables); only mocked manifests and fixture tests were checked. The actual CDN manifest, spoken languages, playback and performance on the deployed server remain unverified; added source groups can miss the current player late-recovery list.

### Generic late-source recovery update

The backend now advertises generic enabled `sourceGroups` ids in the uniform playback response. The player validates and bounds these IDs and uses them for background and exhaustion recovery, falling back to its old list when talking to an older backend. This supersedes the earlier limitation that Sources 7–11 were omitted from late recovery. Local tests cover a mocked Source 10 arriving late without interrupting playback, dynamic exhaustion recovery, and old-backend fallback; deployed live playback has not been checked.

## Next batch: five candidates under investigation

Batch evaluated 2026-11-04; these are **not yet added**, and no one should infer that all are dead or single-audio. The aim is a useful multilingual library, not a count of iframe URLs. Exact FlixFun button-to-domain mappings remain unverified.

1. **VidLink (`vidlink.pro`)** — [Hostreamio](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidlink.dart) uses a third-party token helper and `/api/b/movie/{encrypted-id}`. Page retrieval of that chain for TMDB 693134 returned file qualities and captions, including Hindi **subtitles**, but no HLS playlist or audio-language metadata in the displayed portion. [Another investigation](https://github.com/muhdfaisalwork-gif/ShadowStream/pull/1) reports `multiLang` affecting subtitles, not audio, for its test. Need a direct/local token implementation and real audio verification across other titles before adding; third-party crypto helper is not a media host. Do not make Hindi subtitle options look like Hindi dub.
2. **MappleTV** — [current documented domain](https://mappletv.uk/docs/getting-started/endpoints) is `mapple.fun`; an attempted `mapple.club` watch URL redirected there. Hostreamio's [older extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/mapple.dart) expects a request token, cookies, optional PoW, encryption endpoint and multiple server calls on the old domain; not established to work on the current player. Multi-audio is a site claim; track/host and performance need verifying. No remote JavaScript should be blindly executed in production.
3. **VidFast** — [extractor](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidfast.dart) relies on enc-dec.app for token/envelope operations; [E2iPlayer investigation](https://github.com/oe-mirrors/e2iplayer/pull/803) reports a local QuickJS player VM taking 7–11 seconds on a PC and longer on a set-top box. 693134 and 872585 rendered original-audio server labels; this is not proof other titles lack dubs. No current direct multi-audio evidence or safe, fast local crypto path.
4. **VidUp** — similar encrypted source protocol and external helper in [Hostreamio](https://github.com/sakinator/hostreamio/blob/b022280ed079394b3046ab597ab5863450b30436/lib/upstream/services/scraper/sites/vidup.dart). A [resolver](https://github.com/sharoon7171/vidup-stream-solver) says it executes upstream player code in a Node VM; integrating untrusted code would need a strong sandbox, resource limits and domain confinement, plus licensing review. A Dune example displayed original audio; no multilingual playback confirmed.
5. **VidCore.org** — Hostreamio's historical `/api/sources?id=...&type=...` returned a LiteSpeed 404 on both `vidcore.org` and `www.vidcore.org` via page retrieval. This only disproves those specific requests, not the embed or entire provider. Official site claims dubbed tracks; current direct extraction and audio verification remain unresolved. Do not conflate with VidCore.io.

No new provider was registered from this batch: all five still have protocol, audio or safety gaps. The output of the page reader is not an end-to-end server or browser test.

### RiveStream Citadel: multilingual direct-stream lead

On 2026-11-04, the Rive scraper's `api/provider?provider=citadel&id=693134` returned separate HLS entries labelled English, Hindi, Kannada, Tamil and Telugu, with 720p and 480p choices. Movie 872585 returned English, Hindi and Tamil-labelled streams, and TV 1396 S1E1 returned Hindi-labelled entries. These are audio-stream labels, not caption labels; they are still provider assertions, not independently confirmed speech. The Dune Hindi 720p manifest was accessible via page retrieval and contained HLS media segments, but the page reader returned HTTP 500 when asked to retrieve a segment. That is not proof the segment is unusable: the reader may not handle binary media. Actual segment decoding, spoken language, correct TV episode and startup time have not been verified. The observed offerings top out at 720p for these examples, so no 1080p/4K claim is justified. The API is a provider-specific Rive scraper, and exact FlixFun mapping is unknown. Do not register it solely on these observations; the available environment cannot perform direct outbound segment/playback verification, and quality/reliability need independent confirmation.

### RiveStream follow-up: lane quality and duplicate-label risk

The Rive endpoint exposes 17 named providers, not 17 independently verified multilingual sources. On 2026-11-04, single-title requests for Dune 693134 found direct Citadel HLS; PrimeVids returned two unlabeled slowcloud manifests; Apollo, Vanguard, Lumen, Prometheus and AsiaCloud returned null; Kismet, Fortress and Oberon reported an internal error; Apogee and Electra returned third-party proxy URLs wrapping Bingr and VidBolt origins; Rift wrapped VidRift; Valiant and Sentinel returned nested proxies. These are individual request results, not a lasting health census. The proxy-wrapped streams should not be treated as independent new direct providers or accepted blindly.

Citadel's API returned distinct paths for Dune's Hindi, Tamil, Telugu and Kannada-labelled entries and its Hindi playlist was readable. Breaking Bad 1396 S1E1 and S1E2 returned different HLS content paths, consistent with episode selection, though not proof of correct episodes. A separate check on 940721 returned 720p Japanese and Tamil-labelled entries with the same `/hls_mps/<content-id>/720/` path on different CDN hosts and index names; 480p English and Japanese also shared that content path. This is a **label-conflict warning**, not definitive proof that bytes or audio are identical: test media bytes/audio before exposing conflicting labels, and don't assume URL strings or CDN domains represent distinct dubs. The manifest inspected was a media playlist with JPG-named segment URLs, not an `EXT-X-MEDIA` multi-audio master. Its URL and labels cannot prove spoken language.

Existing Source 5's Nxsha priority includes `rive-citadel` and related Rive lanes; Source 2 also prioritizes `rive-citadel`. This is an overlap in configured lane names, not proof that they successfully return the same content in production. A direct Rive adapter could offer an independent discovery route, but should handle duplicate/contradictory language labels, bounded request and liveness budgets, CDN/SSRF constraints, and binary-segment relay, and preserve the other sources. [Kunai PR #346](https://github.com/KitsuneKode/kunai/pull/346) reports a third-party headless mpv decode of Citadel at 720p with Hindi and English audio, while describing an unplayable PrimeVids mirror despite a 200 manifest. It does not identify all our tested titles or establish Elfura playback. [Kunai PR #653](https://github.com/KitsuneKode/kunai/pull/653) reports a Citadel Breaking Bad S1E1 reachable probe and about 6s resolution in its environment; neither timing nor playback is verified on the user's deployment. No playback code changed in this investigation.
