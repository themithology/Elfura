# Nuvio / Stremio addon integration research

Research snapshot: 2026-11-04. Repository descriptions and manifests are claims by their maintainers; they do not prove current source availability, correct title/episode matching, actual media bytes, audio tracks, or deployment playback.

## Confirmed repository leads

| Repository | What it is | License / integration note |
|---|---|---|
| [NuvioPlugin/All-in-One-Nuvio](https://github.com/NuvioPlugin/All-in-One-Nuvio) | Nuvio local-scraper bundle. Its current manifest lists 66 entries, including AllMovieLand, MovieBlast, MovieBox, DooFlix, HindMoviez, MoviesDrive, AnimeSalt and AnimeWorld. The README's count differs from the manifest. | Rechecked the default-branch root: no `LICENSE`, `LICENSE.md`, `LICENSE.txt`, or `COPYING`; GitHub API reports no license metadata (`NOASSERTION`). Do not copy or bundle its scraper code without an upstream license or permission. Its Nuvio plugin runtime is not Elfura's `SourceAdapter` API. |
| [Gowaru/gowaru-nuvio-providers](https://github.com/Gowaru/gowaru-nuvio-providers) | 37 compiled Nuvio plugins, mostly French anime and streaming sites. | GPL-3.0. Porting source code requires preserving notices and complying with GPL obligations; it is not a drop-in Node adapter. |
| [imvinx/animesalt-api](https://github.com/imvinx/animesalt-api) | Separate AnimeSalt API/web application; its README describes audio variants and a proxy-based deployment. | Apache-2.0. It is a self-hosted API, not a Nuvio addon manifest, and its deployment/proxy requirements need separate review. |
| [Adhi-haran/animesalt-nuvio-addon](https://github.com/Adhi-haran/animesalt-nuvio-addon) | AnimeSalt Nuvio addon service. | GitHub reports no license metadata (`NOASSERTION`). |
| [yesgamingt5-bot/animeworld-nuvio](https://github.com/yesgamingt5-bot/animeworld-nuvio) | Nuvio AnimeWorld plugin. | GitHub reports no license metadata (`NOASSERTION`). |
| [D3adlyRocket/Anime-Nuvio](https://github.com/D3adlyRocket/Anime-Nuvio), [Hindi-Nuvio](https://github.com/D3adlyRocket/Hindi-Nuvio), and [NuvioPlugin/asura-providers](https://github.com/NuvioPlugin/asura-providers) | Related compiled plugin collections. | Default-branch roots contain no common license file; GitHub reports `NOASSERTION`. |
| [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams) | Configurable Stremio addon aggregator. | AGPL-3.0. It requires a user-configured instance and is not a local Nuvio scraper bundle. |
| [977711/MediaFusion-1](https://github.com/977711/MediaFusion-1) | Universal Stremio addon. | MIT. It requires a configured instance; returned entries can be torrents/host resolvers rather than direct HLS. |
| [kratoskrator/diziyou-nuvio](https://github.com/kratoskrator/diziyou-nuvio) | DiziYou Nuvio plugin for Turkish-language series. | MIT. Nuvio-specific API; not among the original language/source list. |
| [xuper-plugin/kino-plugin-embed69](https://github.com/xuper-plugin/kino-plugin-embed69) | Embed69 plugin for the Kino client. | Apache-2.0. This is a Kino plugin, not a Nuvio manifest or Elfura adapter. |

A GitHub repository search did not identify an authoritative Duck AIO / Duck Streams Stremio addon repository. Several individual source names in the request appear inside the unlicensed All-in-One bundle, but independent licensed implementations were not located for each.

## Initial Elfura integration

Elfura now has an **optional, generic Stremio stream-resource bridge** (`Source 17`). It does not download or execute third-party code. Configure up to eight HTTPS Stremio addon manifest/base URLs in `ELFURA_STREMIO_ADDONS` as a JSON array. It requests the standard movie/series stream resource using the IMDb ID, rejects torrent/info-hash records, restricts results to direct HLS/DASH/MP4 URLs, limits response size and headers, and leaves the source disabled when the list is empty.

This enables a user-configured AIOStreams or MediaFusion instance only when that instance returns a direct media URL. It does not make a hosted instance, supply user-specific configuration/tokens, or verify that any stream plays. No public AIOStreams/MediaFusion endpoint is hardcoded.

## Next integration rule

For the Nuvio bundles, port individual provider logic into isolated Elfura adapters one at a time only when the source license permits it (or permission is obtained). Keep every new adapter opt-in until title-specific manifest and media-segment checks pass. A server-side segment check is not proof of sustained browser playback or Pterodactyl playback. Do not execute fetched provider JavaScript as a substitute for a reviewed port.
