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

### Part 2 — Backend (`backend/`)
- **Isolated runtime & directory (`backend/`)** housing the HTTP server, anti-scraper security layer, TMDB client, source adapters, and stream ingress/egress relay.
- Owns all communication with our self-hosted TMDB API and external media sources (`Source 1`, `Source 2`, etc.).
- Normalizes messy, inconsistent upstream responses into **one strict uniform schema** before anything reaches Part 1.

---

## 2. Single Uniform Endpoint & Anti-Scraper Security

1. **One Uniform Client API (`GET/POST /api/v1/playback`):**
   - Part 1 requests playback metadata from **one uniform backend endpoint** (`/api/v1/playback`, keyed by `type=movie|tv`, `tmdb`, `s`, `e`, optional `source`, and `lang`).
   - Regardless of how `Source 1`, `Source 2`, or future sources work internally, `backend/src/sources/registry.ts` molds every source into `UniformPlaybackResponse` (`media`, `primary`, `sources[]`, `segments`).
2. **Uniform Stream Ingress / Egress Relay (`GET /api/v1/stream?t=<ticket>`):**
   - Raw upstream stream URLs, provider domains, cookies, signed query strings, and required `Referer`/`Origin`/`User-Agent` headers **must never be exposed to the browser**.
   - Every stream URL, audio dub URL, and subtitle URL is sealed into a stateless AES-256-GCM encrypted ticket (`backend/src/security.ts` -> `sealStreamTicket`).
   - `backend/src/relay.ts` decrypts tickets server-side, enforces SSRF checks (`isSafeUpstreamUrl`), rewrites every child URI inside HLS (`.m3u8`) and DASH (`.mpd`) manifests into fresh `/api/v1/stream?t=...` tickets, and pipes binary media segments directly with zero disk writes.
3. **Anti-Scraper Gates (`POST /api/v1/session` & SSR `__ELFURA_BOOT__`):**
   - Embed HTML routes (`/embed/movie/:tmdbId`, `/embed/tv/:tmdbId/:s/:e`) and `POST /api/v1/session` mint short-lived HMAC-SHA256 `pltoken` + `nonce` credentials.
   - `/api/v1/playback` enforces `Origin`/`Referer` validation, bot UA rejection, bounded in-memory `CF-Connecting-IP` rate limiting, and `X-Playback-Token` verification.

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
   - Ship pre-built `dist/` with **zero `devDependencies`** in the archive's `package.json` so ParkerCP's startup `npm install` downloads 0 MB from npm.
   - Include entrypoint shims calling `startBackendServer()` across common Pterodactyl `MAIN_FILE` defaults (`index.js`/`index.ts`, `server.js`/`server.ts`, `app.js`/`app.ts`, `main.js`/`main.ts`, `bot.js`/`bot.ts`, `start.js`, `src/index.js`/`src/index.ts`) plus the lightweight local `vendor/ts-shim` compiler shim so ParkerCP's `/usr/local/bin/ts-node --esm` Egg boots cleanly on Node 22/24 even when global `typescript@7+` (TSGo) is installed.

---

## 4. TMDB & Modular Source Adapter Contract

1. **Self-Hosted TMDB Primary Identity:**
   - Titles are addressed by TMDB ID (`movie` or `tv` with `season` & `episode`), resolved through our self-hosted TMDB API configured via env vars.
2. **Plug-and-Play Source Isolation:**
   - Each source lives in its own isolated module (e.g., `backend/src/sources/source1.ts`, `source2.ts`) implementing a shared `SourceAdapter` interface.
   - Adding, fixing, or retiring a source **must only touch `backend/`** — Part 1 (`src/`) must require **zero code changes** when new sources are added.
   - Public-facing source identifiers and labels must stay clean and branded (`source-1` / `Source 1`, etc.), never leaking internal upstream provider names.

---

## 5. Dynamic Multi-Audio, Fastest-Server Selection & Clean Consumer UI

1. **Zero Hardcoded Audio Tracks or Language Lists:**
   - **Never** hardcode audio track lists or pre-populate languages that a title's streams do not actually offer.
   - Audio tracks must be discovered **100% dynamically** at runtime from parsed HLS/DASH manifests (`#EXT-X-MEDIA:TYPE=AUDIO` / `<AdaptationSet contentType="audio">`), dynamic sidecar `audioTracks`, and the actual audio languages dynamically reported across resolved raw stream candidates for that TMDB title.
   - Language tag canonicalization (ISO 639-1 / ISO 639-2 / BCP-47) and human display labels must rely on runtime `Intl.Locale` + `Intl.DisplayNames` rather than hardcoded language dictionaries.
2. **Full Upstream Server Harvesting & Concurrent Fastest-Server Selection:**
   - Source adapters must harvest **all online upstream servers** (including all 30+ `byServer` nodes and distinct language/quality variants on `Source 2`, ordered by `scanReport` / `byServer` `latencyMs`) without leaking upstream server names or domains.
   - TMDB metadata and `SourceAdapter.resolve()` run concurrently with bounded, strictly zero-disk in-memory RAM caches (TMDB metadata, raw adapter results, and small VOD manifests) to eliminate redundant round-trips while minting fresh per-request stream tickets.
   - Both initial playback and audio-language switching must **race candidate servers concurrently** across distinct opaque `fingerprint`s (never walking candidates sequentially top-to-bottom), immediately selecting the lowest-buffer responder and skipping duplicate failed `fingerprint`s.
3. **Exhaustive Raw-Source Search per Selected Language:**
   - Whenever an audio language is selected (via the Audio menu, `?lang=`, or `postMessage`), try instant in-band native/external tracks first, then race all candidate raw sources for that language across parallel waves before declaring it unavailable.
   - If every candidate raw source has been searched/probed and the requested language is still unavailable, display:
     `Sorry, we searched all sources yet didn't find it in "<Language>"`
     while keeping/restoring playable video cleanly without crashing the player.
4. **Clean Consumer UI (Zero Developer / Internal Clutter):**
   - Never display internal/technical stream labels (`other stream`, `in stream`, `external dub`, `external`, raw `kbps`, `HLS · N CC`, or raw internal error codes) in player menus or toasts. Keep Audio, Subtitles, Quality, and Sources menus clean and viewer-friendly.
5. **Deep Stream Liveness Verification (Zero Dead Streams Entering the Player):**
   - Never rely on master-only `#EXTM3U` checks: both Part 2 (`backend/src/sources/liveness.ts`) and Part 1 (`ElfuraPlayer`) must verify child variant & default audio playlists in parallel so master-alive / child-HTML dead streams, `403` direct links, and dead mirrors are pruned before playback starts, while pre-warming the bounded RAM manifest cache and harvesting all `#EXT-X-MEDIA:TYPE=AUDIO` / `<AdaptationSet>` languages directly from live manifests.
   - `/api/v1/stream` must strictly reject `text/html` / non-manifest bodies on manifest (`k='m'`) and media segment (`k='a'`) tickets with `502` `no-store` so soft-403 HTML pages are never cached at Cloudflare edge or fed to `hls.js`.
   - Single-dub manifests emitting generic `#EXT-X-MEDIA:TYPE=AUDIO,NAME="Audio"` without `LANGUAGE=` must preserve their known canonical dub language (`l` ticket hint + player inheritance) so bogus `"Original"` ghost tracks never appear alongside real languages, and HEVC-only (`hvc1`/`hev1`) variants must be skipped on MSE engines lacking hardware HEVC support.
6. **Cinema OTT Player Chrome, Brand Watermark & Paused Screen (Part 1 `src/ui/`):**
   - **Persistent Brand Watermark & Top Bar:** Top-left carries the `← Back` pill **only when player UI is on** (collapsing completely when UI hides; never a `Home` button), followed by the persistent `[ TV-Logo  TheOGPirateBot ]` pill that stays on top even when UI hides — at **100% opacity** when started or paused and fading smoothly while playing. Never render a duplicate top title logo; for TV episodes, show `S# · E# — Episode Name` beside the brand pill when UI is visible. Top-right keeps clean `Quality`, side-by-side `Audio & Subtitles`, and `Screen Lock` triggers.
   - **Title Logo & Cartoony Fallback + Cinema Paused Screen:** Render the official TMDB Title Logo above the seekbar (with compact `Movie/Series · Genre · Year` metadata) and on the full **Cinema Paused Screen** (`PAUSED`, italic `"Tagline"`, `Year • ★ Rating`, and overview synopsis); whenever no TMDB logo exists or fails to load, fall back automatically to rendering the title in a bold cartoony display font.
   - **Uncluttered Center, Gestures & Hotstar 5s Language Bar:** Never place `-10s` / `+10s` skip buttons in the center; keep animated Play/Pause & 4-corner Fullscreen buttons, left/right double-tap `10s` skip with ripple + chevrons, press-and-hold `2×` speed, Screen Lock (`Tap to Unlock`), and the dynamic Hotstar-style bottom language selector during the first 5 seconds.


