# Sources 18–21 — audit, protocols, and what was deliberately rejected

Date: 2026-11-14. Branch `arena/399224d8-elfura`.

Inputs: the provider inventories of two independently maintained plugin repos —
[`Skywave22/Plugins-TJ`](https://github.com/Skywave22/Plugins-TJ) (Nuvio/TV plugins, 26 providers, pushed daily)
and [`Skywave22/TJ-Plugins`](https://github.com/Skywave22/TJ-Plugins) (SkyStream, +8 providers) —
plus [`kacigaya/binje`](https://github.com/kacigaya/binje) `docs/playback-providers.md` for resolver notes.

Maintenance vetting (per RULES §vetting): both Skywave22 repos are one author, near-daily commits, consistent
per-provider module layout, shared `_lib` helpers, and explicit "why this lane is dead" comments. `kacigaya/binje`
is a smaller app but documents real playback results instead of copy-pasting resolvers. Treated as **reference
implementations**, not dependencies: no code is vendored, no relay domain is used.

## Hosts actually behind each provider

Extracted from each plugin's own network calls, so the decision is made on the API, not the name:

| Provider | Backend host(s) | Verdict |
|---|---|---|
| **SubDubAnime** | `blakiteapi.xyz` + `hugh.cdn.rumble.cloud` | **adopted → Source 18** |
| **DesiDubAnime** | `desidubanime.me` (WP REST) + `*.p2pplay.pro` + `vidmoly.*` | **adopted → Source 19** |
| **FMovies (vidora only)** | `moviesapi.to/api/vidora/v1` | **adopted → Source 20** |
| **KMMovies** | `kmmovies.beer` + `*.kmcloud.*` + `.r2.dev` | **adopted → Source 21** |
| CineHD / CineJoy | `api.vidlove.cc` + `nxsha.space` + `vidrock.net` | rejected — Nxsha/VidRock re-exports (already Sources 1/5) |
| Vidbox / HiStream / Zenix | `nxsha.space`, `embed.vidrift.in` | rejected — same backends as Sources 1/5 |
| AniHype | `embed.vidrift.net`, `bingr.one`, `embed.filmu.in`, `embed.animetvplus.site`, `sora.anixx.cloud` | rejected — pure embed aggregator over other lanes' players |
| ZXCStream | `vidstuck.cc` | rejected — ZXC family, excluded by standing rule |
| MoviesHubHD / Cinezo | `*.streamed-*.workers.dev` | rejected — third-party Cloudflare relay, not the provider's own CDN |
| KatMovieHD / SSRMovies / KDMaza / PikaHD / KatDrama / Movies4u | `drive.google.com`, `drive.usercontent.google.com` | rejected — Google Drive pipelines: quota-throttled, non-seekable, materially worse exposure |
| HiCine | `api.hicine.sbs` + per-request worker hostnames + pixeldrain | rejected — needs minted worker hostnames per session and file-host chains; brittle and no independent CDN |
| RareAnimes | `codedew.com/streambeta` | rejected — the plugin itself documents that its CDN **403s data-centre IPs**; a Pterodactyl box is one |
| Vidru (binje) | `ythd.org` → `vidsrc.sh`, WASM-decrypted list, IP-bound tokens | deferred — the only lane needing a WASM runtime; revisit if the four above fall short |

## Protocols implemented

### Source 18 — SubDubAnime
```
GET  /api/get.php?tmdbId=<id>                     (movie)
GET  /api/get.php?id=<s>-<e>&tmdbId=<id>          (series)
 -> { data: { dataId, quality, qid, format, ranges } }
```
`format: M3U8` → one HLS playlist per `ranges` line: `<start>-<end> (1080p)` becomes
`…/video/<dataId>.<code>.tar?r_file=chunklist.m3u8&r_type=application%2Fvnd.apple.mpegurl&r_range=<start>-<end>`
(codes `oaa`240 / `baa`360 / `caa`480 / `gaa`720 / `haa`1080). Otherwise `qid` enumerates fixed MP4 renditions.

A title can exist as **several catalogue entries, one per audio language**, sharing `originalTmdbId` and differing
only in the zero-padded `tmdbId`. That is the only way this provider exposes a Hindi dub and an English dub as
distinct streams, so `getAllAnime.php` is read (8 MiB cap, 30-minute RAM cache, skipped on failure) and each variant
is queried with its own padded id. Labels are trusted (`ELFURA_SUBDUB_TRUST_LABELS`, default on, following the
Source 17 precedent in RULES §5.1) and always recorded as `claimedAudioLang` too.

### Source 19 — DesiDubAnime
```
GET /wp-json/wp/v2/anime?search=<title>            (JSON; no card scraping)
GET /anime/<slug>/                                 → /watch/ links
GET /watch/<…>                                     → <span data-embed-id="b64(name):b64(url)">
```
- **Streamp2p**: `GET <origin>/api/v1/video?id=<id>&w=1920&h=1080&r=<host>` returns a hex body; AES-128-CBC with
  `kiemtienmua911ca` / `1234567890oiuytr` unwraps JSON carrying `cfNative` + `source` HLS URLs and subtitle tracks.
- **VidMoly**: JW Player setup, `sources:[{file:"…master.m3u8"}]`, usually multi-audio; the shared liveness probe
  harvests the real `#EXT-X-MEDIA` languages.
- Mirrordub / Abyss / filesforever are encrypted multi-host wrappers → ignored.

Episode selection uses the anime page's `/watch/` links first and only reads one watch page's
`.episode-list-item` list when the season/episode is not in the URL.

### Source 20 — Vidora
```
GET /api/vidora/v1/movie/<tmdb>
GET /api/vidora/v1/tv/<tmdb>/<s>/<e>   (x-player-key, Referer/Origin)
 -> { result, sources: [ { url, tracks: [ { file, label } ] } ] }
```
One JSON round-trip, direct adaptive HLS master, subtitle tracks filtered to `vtt|srt|ass` on HTTPS.

### Source 21 — KMMovies
```
GET /?s=<query>                       → <article class="movie-card" aria-label="Title (Year)">
GET /dune-part-two-2024/              → #download-links a.dl-btn → https://one.kmcloud.lol/s/<id>
GET https://one.kmcloud.lol/d/<id>/watch_online   → ?videoUrl=<R2 object>  (or .r2.dev)
GET https://one.kmcloud.lol/d/<id>/sonicboom      → signed ?file=…&dl=r2/worker
```
Series posts expose one **combined** file per season (`data-type="combined-<n>"`), which is what is used.
Google Drive copies (`/go/<id>/mydirect`) and archive uploads are not returned: they need a browser session.

## Source 8 fix — PNG-wrapped transport streams

The live `/diagnose` on the healthy box showed source-8 manifests alive with `language: hi` but the media segment
reported `unexpected-content-type (image/jpeg)`, and the lane was dropped as failed. `binje`'s notes document why:
VidRock-Nova-style CDNs wrap each segment in a **1×1 PNG whose real payload is the MPEG-TS**, stored in a private
`tsDa` chunk, and hand non-browser user agents 90-second clips. A `Content-Type` header therefore says nothing
about whether the stream is playable.

Two changes, both in `backend/`:

1. `backend/src/sources/media-sniff.ts` — bounded byte sniffing: `mpeg-ts` (sync byte at 0/188), `png-wrapped-ts`
   (PNG signature + `tsDa` chunk within the first few chunk headers), `png-image`, `jpeg-image`, `mp4`.
   `diagnoseCandidatePlayback` now sniffs the first bytes of a segment before judging it, so
   • PNG-with-`tsDa` → **ok** and reported as `mediaEncoding: "png-wrapped-ts"`,
   • TS bytes under `image/jpeg` → **ok**,
   • a genuine poster/error image → still `unexpected-content-type` and still never eligible for CDN offload.
2. `backend/src/relay.ts` — when a `kind='a'` segment comes back as an image, the relay unwraps the `tsDa` payload
   (8 MiB hard ceiling) and serves `video/mp2t`; anything that is not a wrapped stream is passed through byte-for-byte.

The false negative was the *diagnostic*, not the stream; but without the relay half the browser could not have played
a wrapped segment anyway.

## Verification

- `backend/test/sources-18-21.mjs` — payload parsing for all four lanes, AES Streamp2p round-trip, episode/list
  parsing, KMCLOUD share parsing, season-combined parsing, opt-out flags, generic labels.
- `backend/test/diagnostics-pipeline.mjs` — real JPEG rejected, TS-mislabelled-as-JPEG accepted, PNG-wrapped
  accepted and reported.
- Live: `.github/workflows/sources-probe.yml` runs `scripts/newsources-probe.mjs` from a GitHub runner (the agent
  sandbox has no egress to these hosts) and commits `research/sources-probe-report.md`.
