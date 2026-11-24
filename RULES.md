# Elfura — Project Architecture & Engineering Rules

This document is the authoritative rulebook for **Elfura**. Every contributor and coding agent must follow these boundaries before modifying code, adding dependencies, or introducing new sources.

> **Living Governance:** If any implementation starts drifting outside these rules—or if our architecture intentionally evolves—update this file immediately so the contract stays accurate and enforced.

---

## 1. Strict Two-Part Boundary

Elfura is split into two isolated parts in this repository so upstream scraper churn never breaks the player, and player UI work never compromises backend security. Both parts may be updated together when evolving the shared uniform contract, **never by blurring the boundary**.

### Part 1 — Player (`src/`, `embed.html`, `vite*.config.ts`)
- **Pure, source-agnostic media player & embed SDK.**
- **Zero upstream leakage:** Never place scraper logic, third-party extractor code, upstream provider domains/names, API keys, or custom header workarounds inside `src/` or client bundles.
- **Uniform consumption only:** Talks exclusively to Part 2's uniform endpoint(s) and renders generic, normalized source labels (e.g., `Source 1`, `Source 2`), quality levels, audio dubs, and subtitles.
- **Core player discipline (do not regress):**
  - `src/core/params.ts` (`PARAM_SCHEMA`) remains the single declarative source of truth for client inputs.
  - Keep `hls.js` and `dash.js` lazy-loaded (`import()`) so the initial embed bundle stays ~23 KB gzip.
  - Capability-driven UI only — never hardcode quality ladders, audio tabs, or subtitle tabs that the stream doesn't offer.
  - Maintain the single `requestAnimationFrame` loop with change-detected DOM writes and zero `innerHTML` in hot paths.
  - Security params (`pltoken`, `nonce`, `token`, `sig`) must always be redacted from logs and outbound `postMessage` events.
  - Episode changes start a fresh timeline (never reuse the preceding episode's position or initial `t` offset), while same-episode source/audio switches preserve position. Forward the sanitized `episodeChange` event to the embedding host when a selection starts; the host must verify the player origin and iframe sender.

### Part 2 — Backend (`backend/`)
- **Isolated runtime & directory (`backend/`)** housing the HTTP server, anti-scraper security layer, TMDB client, source adapters, and stream ingress/egress relay.
- Owns all communication with our self-hosted TMDB API and external media sources (`Source 1`, `Source 2`, etc.).
- Normalizes messy, inconsistent upstream responses into **one strict uniform schema** before anything reaches Part 1.

---

## 2. Single Uniform Endpoint & Anti-Scraper Security

1. **Uniform Client APIs (`GET/POST /api/v1/playback` & `GET /api/v1/episodes`):**
   - Part 1 requests playback metadata from **one uniform backend playback endpoint** (`/api/v1/playback`, keyed by `type=movie|tv`, `tmdb`, `s`, `e`, optional `source`, and `lang`), plus `/api/v1/episodes` (`tmdb`, `s`) for TV season/episode catalogs.
   - The public site (`/`, `/demo`, `/docs`, `/status`) must remain catalog-driven. `GET /api/v1/catalog` supplies sanitized live TMDB movie/series/anime entries and TMDB artwork URLs through a bounded RAM cache; hero demos, poster rails, and builder picks consume that response. Never add fixed poster walls, generated-artwork substitutes, or silent hardcoded catalog fallbacks.
   - Regardless of how `Source 1`, `Source 2`, or future sources work internally, `backend/src/sources/registry.ts` molds every source into `UniformPlaybackResponse` (`media`, `primary`, `sources[]`, `segments`). The uniform playback response may include only generic enabled `sourceGroups` ids, allowing the source-agnostic player to recover slow groups without a hardcoded provider list; no upstream identifiers are exposed. Intro/outro metadata resolves independently of stream racing and is RAM-cached so a fast source cannot discard a slower valid segment response. OpenSubtitles (`backend/src/subtitles.ts`, delivered through `/api/proxy?u=<encoded>`) is the sole subtitle catalogue whenever it returns usable tracks—one track per language, with no native/provider duplicates; existing native subtitles remain the fallback only when OpenSubtitles has no usable result.
2. **Raw Stream Proxy (`GET /api/proxy?u=<encoded upstream>`):**
   - There is exactly **one** delivery path and it is a dumb pass-through: `backend/src/stream-proxy.ts` fetches the upstream manifest or segment and streams it to the viewer with zero buffering and zero disk writes. There are no sealed stream tickets, no ticket endpoints, no per-segment CDN offload probes, and no relay/force-proxy modes. `RELAY_MODE`, `/api/v1/stream`, `sealStreamTicket`, `verifyDirectSegmentOffload`, and the `fp`/`p=1` player fallbacks are gone for good.
   - Upstream provider domains, aggregator APIs, worker bridges, cookies, API keys, and required `Referer`/`Origin`/`User-Agent` headers **must never be exposed to the browser**: `u` is opaque base64url (`encodeProxyTarget`), required headers travel in `h` (base64url JSON), and rewritten playlists/MPDs only ever reference `/api/proxy?...` URLs — never a provider hostname.
   - Every master/child manifest, `#EXT-X-KEY` URI, external audio dub, subtitle, and DASH `SegmentTemplate` is rewritten so all children route back through `/api/proxy` (`rewriteHlsManifest`, `rewriteDashManifest`, `materializeProxyTemplate`). DASH `$RepresentationID$/$Number$/$Time$/$Bandwidth$` placeholders stay literal in `u`; dash.js substitutes them via `_dr/_dn/_dt/_db`.
   - `restrictedOrigin` (`ro`) pins every child, key, and DASH URL to one declared HTTPS origin: off-origin HLS children and keys are dropped, off-origin DASH URLs are refused, and off-origin redirects are never followed.
   - `isSafeUpstreamUrl` is enforced per hop, redirects are followed manually (max 5) with sensitive-header stripping across origins, and a bounded byte sniff rejects HTML/JSON bodies with `502` `no-store` unless they are provably mislabelled MPEG-TS/MP4 (including PNG-wrapped TS, unwrapped under an 8 MiB cap).
   - `/api/proxy` is stateless and CORS-`*`, so it needs no session, no token, and no per-viewer state; a single stateless container can serve every viewer.

3. **Anti-Scraper Gates (`POST /api/v1/session`, SSR `__ELFURA_BOOT__`, Sealed Playback Envelope & `Referrer-Policy`):**
   - Embed HTML routes (`/embed/movie/:tmdbId`, `/embed/tv/:tmdbId/:s/:e`) emit `Referrer-Policy: same-origin` (keeping full same-origin `Referer` for Elfura's API while sending **zero `Referer`** to cross-origin segment CDNs) and `POST /api/v1/session` mints short-lived HMAC-SHA256 `pltoken` + `nonce` credentials.
   - `/api/v1/playback` enforces `Origin`/`Referer` validation, automated CLI/downloader UA rejection (`curl`, `yt-dlp`, `ffmpeg`, `python-requests`, etc.), bounded in-memory `CF-Connecting-IP` rate limiting, and `X-Playback-Token` verification. `/api/proxy` is intentionally public and stateless (CORS `*`): it is a byte pipe, exposes no provider identity, and is rate limited like any other media route.
   - When `ElfuraPlayer` sends `X-Elfura-Envelope: 1`, `/api/v1/playback` encrypts the JSON payload into an **AES-256-GCM Sealed Playback Envelope** (`{ ok: true, s: 1, p: "<base64url>" }`) keyed per-session from `pltoken + nonce`, so DevTools Network Preview and copied cURL requests only ever see opaque ciphertext.

---

## 3. Hosting, Zero-Disk Storage & Cloudflare Rules

Our production environment runs on a **Pterodactyl Panel container** (heavy CPU/RAM shared hosting plan, **strictly limited disk space**) behind a **Cloudflare domain proxy**.

1. **ZERO Disk Cache / ZERO Local Persistence (Hard Rule):**
   - **Never** write cache files, SQLite/JSON databases, temporary media segments, or log files to the container filesystem.
   - **Stream in memory with backpressure:** Always pipe upstream media responses using streaming APIs (`Readable` / Web Streams) — never buffer whole video files or large segments in disk or unbounded RAM.
   - **Minimal dependency footprint:** Prefer Node built-ins (`node:http`, `node:crypto`, native `fetch`, Web Streams) and lightweight packages so `node_modules` consumes minimal disk space on Pterodactyl.
2. **Cloudflare Edge Caching:**
   - Offload caching to Cloudflare's edge using explicit `Cache-Control` / `CDN-Cache-Control` headers on cacheable responses (e.g., TMDB metadata, public static assets, immutable segments where appropriate), while marking token-minting or user-specific handshakes `private, no-store` as needed.
   - Respect `CF-Connecting-IP` (with safe fallback) for client IP identification and rate limiting.
3. **Pterodactyl Port & Host Binding:**
   - Always bind backend/server listeners to `0.0.0.0` and read the port from `process.env.SERVER_PORT || process.env.PORT` (Pterodactyl injects `SERVER_PORT`).
   - All environment secrets (self-hosted TMDB base URL/key, signing secret, allowed origins) must come from environment variables, never hardcoded.
4. **Pterodactyl `.zip` Packaging (`npm run build:pterodactyl` -> `elfura-pterodactyl.zip`):**
   - Archives must ALWAYS be **flat-root** (files extract directly into `/home/container/`, never inside a wrapper folder).
   - **Never bundle a root `.env` inside `elfura-pterodactyl.zip`** (ship `.env.example` only) so unarchiving on Pterodactyl never overwrites an operator's configured `/home/container/.env`; if `ELFURA_SECRET` is unset or still holds a template placeholder (`replace-with-...`), generate a fresh cryptographic ephemeral secret per boot.
   - Ship pre-built `dist/` with **zero `devDependencies`** in the archive's `package.json` so ParkerCP's startup `npm install` downloads 0 MB from npm.
   - Include entrypoint shims calling `startBackendServer()` across common Pterodactyl `MAIN_FILE` defaults (`index.js`/`index.ts`, `server.js`/`server.ts`, `app.js`/`app.ts`, `main.js`/`main.ts`, `bot.js`/`bot.ts`, `start.js`, `src/index.js`/`src/index.ts`) plus the lightweight local `vendor/ts-shim` compiler shim so ParkerCP's `/usr/local/bin/ts-node --esm` Egg boots cleanly on Node 22/24 even when global `typescript@7+` (TSGo) is installed.

---

## 4. TMDB & Modular Source Adapter Contract

1. **Self-Hosted TMDB Primary Identity & Zero-Outage Fallback:**
   - Titles are addressed by TMDB ID (`movie` or `tv` with `season` & `episode`), resolved first through our self-hosted TMDB API (`TMDB_API_BASE`) and automatically falling back across `api.themoviedb.org/3` / `api.tmdb.org/3` in both `fetchTmdbMetadata` and `fetchTmdbSeasonEpisodes` if `TMDB_API_BASE` is unset or unreachable.
2. **A source is admitted by proof, not by declaration:**
   - The board is `APPROVED_SOURCES` in `backend/src/sources/index.ts`, and it is
     empty by default. The registry builds its adapter list from that array and
     nothing else. There is no per-source config block, no `SOURCE*_ENABLED`
     env table, and no hand-maintained provider list anywhere else in the app —
     those existed before and drifted out of sync with the adapters they
     described.
   - A lane enters that array only after `backend/test/source-contract.mjs`
     passes for it: real probe titles resolved, every candidate already a
     `/api/proxy` path, the manifest fetched through the proxy, a media segment
     returning real bytes, and no provider hostname in the served text. That
     test is in `npm test` and in `.github/workflows/source-contract.yml`. A lane
     that answers a 200 with an error page is not a source.
   - Retiring a lane means deleting its entry and moving its files to
     `backend/attic/`. Archived code is not compiled, imported or tested, so it
     cannot half-exist.
   - Adding, fixing, or retiring a source **must only touch `backend/`** — Part 1
     (`src/`) must require **zero code changes** when new sources are added.
   - Public-facing source identifiers and labels must stay clean and branded
     (`source-1` / `Source 1`, etc.), never leaking internal upstream provider
     names.
   - A source reads its own settings from `sourceEnv()` (the real environment,
     `.env` already merged) rather than growing a key in `BackendConfig`. A
     source that needs per-installation credentials must stay off unless both
     its switch and its credentials are present, keep those credentials in
     `.env` key/value form (never on disk, never in logs, never in diagnostics),
     and emit one diagnostic instead of making any request when unconfigured.

---

## 5. Dynamic Multi-Audio, Fastest-Server Selection & Clean Consumer UI

1. **Zero Hardcoded Audio Tracks or Language Lists:**
   - **Never** hardcode audio track lists or pre-populate languages that a title's streams do not actually offer.
   - Audio tracks must be discovered **100% dynamically** at runtime from parsed HLS/DASH manifests (`#EXT-X-MEDIA:TYPE=AUDIO` / `<AdaptationSet contentType="audio">`), dynamic sidecar `audioTracks`, and the actual audio languages dynamically reported across resolved raw stream candidates for that TMDB title.
   - Language tag canonicalization (ISO 639-1 / ISO 639-2 / BCP-47) and human display labels must rely on runtime `Intl.Locale` + `Intl.DisplayNames` rather than hardcoded language dictionaries.
   - **Separate per-language streams are the one explicit exception:** when an upstream returns one distinct stream URL per language (e.g. `source-17` AniVortex DASH lanes, which carry a single audio adaptation set and no rendition list), that stream's declared language is authoritative for that candidate. Expose one candidate per language, canonicalize the tag, and keep the behaviour behind the adapter's own `ELFURA_*_TRUST_LABELS` switch so it can be reverted to claim-only.
2. **Dynamic Language-Aware Server Hierarchy & Multi-Audio Speed Priority:**
   - Source adapters must harvest **all online upstream servers** (including all 30+ `byServer` nodes and distinct language/quality variants on `Source 2`, plus true CDN manifest RTTs on `Source 1`) without leaking upstream server names or domains.
   - **Never neglect Multi-Audio streams when ranking or racing a language (e.g., Hindi):** Multi-Audio streams (`multiAudio: true`, carrying `#EXT-X-MEDIA:TYPE=AUDIO` tracks or untagged Multi-Audio masters) must enter the **top race wave alongside direct language streams**, always ranked ahead of single-language sources when compatible, and locked onto the target audio track synchronously (`hls.audioTrack`) before downloading initial segments.
   - Whenever an audio language is selected or persisted, `ElfuraPlayer` (`reorderSourcesHierarchy`) and `/api/v1/playback?lang=...` **dynamically re-order the server hierarchy** so whichever server responds fastest for that language (including Multi-Audio servers) sits at **`#1` on top**, with non-matching servers cleanly below.
3. **Exhaustive Raw-Source Search per Selected Language:**
   - Whenever an audio language is selected (via the Audio menu, `?lang=`, or `postMessage`), try instant in-band native/external tracks first, then race all candidate raw sources for that language across parallel waves before declaring it unavailable.
   - If every candidate raw source has been searched/probed and the requested language is still unavailable, display:
     `Sorry, we searched all sources yet didn't find it in "<Language>"`
     while keeping/restoring playable video cleanly without crashing the player.
4. **Clean Consumer UI (Zero Developer / Internal Clutter):**
   - Never display internal/technical stream labels (`other stream`, `in stream`, `external dub`, `external`, raw `kbps`, `HLS · N CC`, or raw internal error codes) in player menus or toasts. Keep Audio, Subtitles, Quality, and Sources menus clean and viewer-friendly.
5. **Deep Stream Liveness Verification (Zero Dead Streams Entering the Player):**
   - Never rely on master-only `#EXTM3U` checks: both Part 2 (`backend/src/sources/liveness.ts`) and Part 1 (`ElfuraPlayer`) must verify child variant & default audio playlists in parallel so master-alive / child-HTML dead streams, `403` direct links, and dead mirrors are pruned before playback starts, while pre-warming the bounded RAM manifest cache and harvesting all `#EXT-X-MEDIA:TYPE=AUDIO` / `<AdaptationSet>` languages directly from live manifests.
   - `/api/proxy` must strictly reject `text/html` / non-manifest bodies on manifest requests and on media segments with `502` `no-store`, so soft-403 HTML pages are never cached at Cloudflare edge or fed to `hls.js`.
   - Single-dub manifests emitting generic `#EXT-X-MEDIA:TYPE=AUDIO,NAME="Audio"` without `LANGUAGE=` must preserve their known canonical dub language (`l` proxy hint + player inheritance) so bogus `"Original"` ghost tracks never appear alongside real languages, and HEVC-only (`hvc1`/`hev1`) variants must be skipped on MSE engines lacking hardware HEVC support.
6. **Cinema OTT Player Chrome, Brand Watermark & Paused Screen (Part 1 `src/ui/`):**
   - **Persistent Brand Watermark & Top Bar:** Top-left carries the `← Back` pill **only when player UI is on** (collapsing completely when UI hides; never a `Home` button), followed by the persistent `[ TV-Logo  TheOGPirateBot ]` pill that stays on top even when UI hides — at **100% opacity** when started or paused and fading smoothly while playing. Never render a duplicate top title logo; for TV episodes, show `S# · E# — Episode Name` beside the brand pill when UI is visible. Top-right keeps only clean `Quality` and `Screen Lock` triggers; primary TV and language navigation belongs in the bottom control bar.
   - **Title Logo & Cartoony Fallback + Cinema Paused Screen:** Render the official TMDB Title Logo above the seekbar (with compact `Movie/Series · Genre · Year` metadata) and on the full **Cinema Paused Screen** (`PAUSED`, italic `"Tagline"`, `Year • ★ Rating`, and overview synopsis); whenever no TMDB logo exists or fails to load, fall back automatically to rendering the title in a bold cartoony display font.
   - **Uncluttered Center, Gestures & Integrated Language Navigation:** Never place `-10s` / `+10s` skip buttons in the center; keep animated Play/Pause & 4-corner Fullscreen buttons (with automatic mobile `landscape` orientation lock on fullscreen), two-finger Pinch-to-Zoom (`Fit` ↔ `Zoom to Fill`), left/right double-tap `10s` skip with ripple + chevrons, press-and-hold `2×` speed, Screen Lock (`Tap to Unlock`), and a persistent bottom `Audio & Subtitles` button that names the actual selected language (for example, `Hindi`) with EN/हिं-style language badges and a white border around the selected row; never add decorative green status dots. Do not restore floating first-five-second language pills. SVG clicks inside any control must never fall through to video-surface gestures.
   - **Cinema QoL Controls & Right-Hand Episode Wheel:** Provide a floating scrub timestamp bubble above the capsule thumb, duration click-to-toggle remaining time (`-1:04:12`), `"Will End at xx:xx"` client-local-time button (`24h` default, click toggles `12h`), live moving-progress Intro/Outro Skip button + `0.2s` pre-warmed Next Episode switching, WebAudio Phone Speaker Boost (`100%–200%`) + Subtitle Sync (`-0.5s` / `+0.5s`) inside `Audio & Subtitles`, and a right-hand vertical fading Episode Selector for TV/Anime (`Playing` green status vs `Queue —`) opened by an upward-animated bottom `Episodes` button. Episode rows must include lazy-loaded TMDB thumbnails with number fallbacks and a visible close control.
   - **Responsive Startup & Terminal States:** Use safe-area-aware, non-overlapping controls at phone portrait/landscape sizes. While backend streams resolve, show the title backdrop/logo, honest progress text, and rotating quotes (a fresh live fetch on every rotation, duplicate protection, and a larger offline fallback set; never show the project codename in viewer-facing quote attribution). When resolution returns no sources or every source fails, replace the black player with a branded unavailable screen and a working in-place retry; non-fatal audio/subtitle errors remain toasts.
