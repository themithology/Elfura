# Elfura Player

A small, fast, embeddable HLS/DASH player. JW-Player-grade restraint on the
outside; a fully dynamic input schema, real multi-language audio and a
completely customisable subtitle renderer underneath.

**Size:** initial chunk **22.9 KB gzip**. `hls.js` and `dash.js` are separate
chunks loaded on demand — an HLS title never downloads the DASH engine.

```
npm run dev        # vite dev server on 0.0.0.0:5173 (proxies /api -> backend)
npm run build      # typecheck (Part 1 + Part 2) + embed + lib + backend
npm start          # zero-dep Node production server on 0.0.0.0:${SERVER_PORT||PORT||8787}
npm test           # end-to-end security, TMDB, Source 1 & HLS/Range relay test suite
```

### Public landing site

The production server serves a complete public product site at `/`, with direct
entry points for `/demo`, `/docs`, and `/status`. It includes a live embed
builder, movie/series demo, copyable iframe/SDK/PostMessage examples, playback
telemetry, and health-driven infrastructure status.

All catalog artwork and title selections are dynamic. `GET /api/v1/catalog`
resolves trending movies, trending series, and popular Japanese animation from
TMDB, sanitizes the response, builds TMDB poster/backdrop URLs server-side, and
uses a bounded ten-minute RAM cache. The hero, poster filters, clickable poster
rail, and builder quick picks all consume that single response; there is no
hardcoded poster list or generated artwork fallback.

---

## 1. How the player takes input

**One declarative schema drives everything.** `src/core/params.ts` holds a
single table of parameters; parsing, validation, clamping, defaults and the
generated docs all derive from it. There is exactly one place that reads a
query string, so a new knob added there immediately works in all three
channels.

Three channels converge on one config, in this precedence order:

| # | Channel | When | Notes |
|---|---------|------|-------|
| 1 | `PARAM_SCHEMA` defaults | boot | |
| 2 | stored preferences | boot | audio language + subtitle style from `localStorage` |
| 3 | JS config object | boot | `Elfura.mount(el, {...})` / `Elfura.create(el, {...})` |
| 4 | **URL query params** | boot | win — the URL is the shareable, debuggable statement of intent |
| 5 | postMessage commands | runtime | mutate live state only |
| 6 | user interaction | runtime | clicks, keys, drag |

URL beats JS config on purpose: for an embeddable player the publisher's URL is
the more specific claim. Self-hosted code that wants the opposite passes
`ignoreUrlParams: true`. Bad input never throws — it is clamped or dropped and
reported in `issues` (visible with `?debug=1`).

Key parameters (full list: `Elfura.schemaDocs()`):

| Param | Type | Example | Purpose |
|---|---|---|---|
| `tmdb` | id | `94605` | TMDB ID resolved via uniform `/api/v1/playback` |
| `mediaType` | enum | `tv` | `movie` or `tv` (also accepts `?type=movie\|tv` or `/embed/tv/:id/:s/:e`) |
| `season` / `episode` | int | `s=1&e=1` | 1-based season & episode for `tv` playback |
| `source` | id | `source-1` | pin a preferred uniform source adapter |
| `src` | url | `…/master.m3u8` | direct media URL when bypassing TMDB resolution |
| `type` | enum | `hls` | force a protocol instead of sniffing |
| `servers` | pairlist | `a:URL,b:URL` | ordered fallback servers; silent failover on fatal error |
| `t` | time | `1:30:00` | start position; accepts `90`, `1:30`, `01:02:03`, `1h2m3s` |
| `lang` | bcp47 | `hi` | preferred audio language |
| `audioTracks` | pairlist | `hi:URL,ta:URL` | **external dubs**, merged with manifest tracks |
| `sublang` | bcp47 | `en` | preferred subtitle language |
| `subsrc` | pairlist | `en:URL,hi:URL` | external subtitle files (VTT / SRT / ASS) |
| `substyle` | mini-lang | `size:120\|color:#ffd54a` | preset any subtitle style property |
| `color` | hex | `00b4ff` | accent; derived shades computed automatically |
| `skipStep` | int | `30` | ± seek seconds; buttons self-hide on short titles |
| `intro` / `outro` | range | `0:52` | coloured scrubber segments + skip pill |
| `autoplay` `muted` `loop` `speed` `volume` `quality` | — | | playback boot state |
| `controls` `keyboard` `back` `brand` `skin` | — | | chrome |
| `origin` | origin | `https://site.com` | locks the postMessage channel both ways |
| `pltoken` `nonce` | opaque | | forwarded verbatim on manifest requests, **never logged or posted** |

Time and colour coercion is forgiving by design (`ARGB` hex, `mm:ss`, bare
seconds all work) because embed builders emit inconsistent values in the wild.

## 2. Multi-language audio

Two kinds of track exist and conflating them is the usual cause of
"switching language stutters":

- **Native** (muxed in the manifest). HLS `EXT-X-MEDIA:TYPE=AUDIO`, DASH
  `AdaptationSet contentType="audio"`. Switching is an in-band operation — the
  engine swaps the audio SourceBuffer without touching the clock, so video
  never blinks.
- **External** (a separate file per language, `?audioTracks=hi:URL`). Common
  when dubs are produced apart from the video. There is no clean in-band switch,
  so the player keeps the video element running muted and drives a **second
  `<audio>` element locked to the video clock** (`core/audio.ts` →
  `ExternalAudioSync`), correcting drift continuously: hard-seek above 350 ms,
  gentle playback-rate nudge between 60–350 ms.

Both surface as one unified `AudioTrack[]`. Rules:

- **Matching:** `?lang=hi` matches `hi` exactly first, then primary subtag
  (`hi` satisfies `hi-IN`). Same rules for subtitles.
- **De-duplication:** an external track is dropped if the manifest already
  carries that language natively (native switches more cleanly).
- **Precedence:** explicit `?lang=` → stored preference → manifest `DEFAULT=YES`
  → first track.
- **Persistence:** the chosen language is remembered per browser and applied to
  future titles when `persistAudio=1` (default on). Turn off for a kiosk.
- **UI:** the audio button and the audio tab only appear when there is more
  than one track. A stream with one language shows nothing.

## 3. Subtitle customisation

Native `<track>::cue` cannot express per-property opacity, free positioning or
font control, and differs per browser — so the player parses **VTT, SRT and
SSA/ASS itself** (`subs/parser.ts`) and paints a DOM overlay (`subs/renderer.ts`).

Everything below is a key in `SubtitleStyle`, settable via the style panel, via
`?substyle=k:v|k:v`, or via the `setSubtitleStyle` postMessage command:

| Group | Controls |
|---|---|
| Colour | text colour, background colour |
| **Transparency** | **text transparency and background transparency, independently** (0–100%). The UI speaks "transparency"; the model stores opacity, so "transparent box, solid text" is one slider each |
| Font | family (8 stacks), size (40–220%), weight (Regular→Extra bold), italic, uppercase, letter spacing |
| Legibility | outline on/off + colour + width; drop shadow on/off + blur |
| Box | padding, corner radius, max width |
| **Position** | top/bottom edge, distance from edge (0–45%), left/centre/right align, horizontal nudge (−40…40%) — **plus drag-the-captions-directly-on-the-video**, which writes back to the same sliders so both stay in sync |

Font size is a percentage of a **720p baseline scaled to the actual player
height**, so 100% reads identically in a 480 px embed and in fullscreen.

Persistence: the user's style is saved to `localStorage` and reused across
titles and embeds on the origin (`persistSubs=1`, default on); a publisher's
`?substyle=` always overrides the stored value for that embed.

The style panel edits a **live preview renderer** (a real `SubtitleRenderer`
over a synthetic surface), so every slider is verifiable before it touches the
video — and the same changes apply to real cues immediately.

## 4. Chrome behaviour (per the reference design)

- Thin full-width scrubber riding on a solid control bar; ±step, volume, time
  on the left; audio / CC / settings / PiP / fullscreen on the right.
- Settings is an **icon-tabbed overlay**: Quality · Subtitles · Speed · Audio.
  Tabs exist only when the stream offers something — no audio tab with one
  track, no CC tab with none, no gear at all when there is nothing to set.
- Quality HUD top-right shows `Quality: Auto` plus a pill with the **effective**
  resolution the ABR is actually serving (`LEVEL_SWITCHED` / `QUALITY_CHANGE_RENDERED`).
- Centre state flash on play/pause/seek; buffering spinner; auto-hide after 2.6 s.
- Intro/outro render as coloured segments inside the scrubber plus a skip pill.
  Segment metadata is resolved independently of stream racing, and the ranges
  refresh on initial UI creation and `loadedmetadata`. Intro/outro clicks seek
  past the range; an outro opens the next episode instead when one is available.
- When OpenSubtitles returns usable tracks, every stream exposes that same
  deduplicated one-track-per-language catalogue. Native subtitles are retained
  only as the fallback when OpenSubtitles has no usable result.

### Nothing is hardcoded
Quality rows come from the manifest; tabs, buttons and segments derive from
stream capability and config; time format adapts to duration; the accent and
every derived shade come from one CSS custom property.

### It stays fast
One `requestAnimationFrame` loop drives time/scrubber/buffer and writes a DOM
property only when the value changed; the panel body is built once per open and
tab switches swap only the body; no `innerHTML` in the hot path; engines are
code-split and fetched only when needed.

## 5. Embedding & the postMessage protocol

```html
<iframe src="https://play.example.com/embed.html?src=…&lang=hi&color=00b4ff"
        allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>
```

Versioned envelope, origin-locked in both directions:

```js
// -> iframe   { __elfura:1, v:1, kind:'cmd',   name:'setSubtitleStyle', data:{ value:{ fontSizePct:130 } }, reqId }
// <- iframe   { __elfura:1, v:1, kind:'ack',   reqId, ok:true }
// <- iframe   { __elfura:1, v:1, kind:'event', name:'audioChange', data:{ lang:'hi', label:'Hindi' } }
```

Commands are acked, so a host can `await` them: `createHostClient(iframe).send('seek', { value: 90 })`.
`pltoken` / `nonce` are redacted from every outbound message and log.

## 6. Uniform Backend & Pterodactyl Deployment (`backend/`)

Elfura maintains a strict separation between **Part 1 (`src/`)** and **Part 2 (`backend/`)** (see [`RULES.md`](./RULES.md)):

- **Clean TMDB Embed URLs:**
  - Movie: `/embed/movie/:tmdbId` or `/embed?tmdb=:tmdbId&type=movie`
  - TV Episode: `/embed/tv/:tmdbId/:season/:episode` or `/embed?tmdb=:tmdbId&type=tv&s=1&e=1`
- **Single Uniform Endpoint (`GET/POST /api/v1/playback`):** Resolves TMDB metadata (from your self-hosted `TMDB_API_BASE`) + modular `SourceAdapter` streams into one uniform schema with zero upstream provider names or raw CDN URLs exposed, wrapped in an **AES-256-GCM Sealed Playback Envelope** (`X-Elfura-Envelope: 1`) so DevTools Network Preview and copied cURL commands only see ciphertext.
- **Smart Hybrid Stream Relay (`GET /api/v1/stream?t=<ticket>`, `RELAY_MODE=hybrid`):** Encrypts upstream URLs and required `Referer`/`Origin` headers inside AES-256-GCM tickets, always relays manifests/subtitles/keys and header-locked or source-identifying streams in memory with zero disk writes, and offloads verified anonymous CORS-safe HTTPS video segments directly to edge CDNs (keeping Cloudflare Proxy & 2 GB RAM Pterodactyl containers safe at scale, with automatic `&p=1` backend-tunnel failover if a viewer's ISP blocks an external CDN).
- **Pterodactyl Ready (`elfura-pterodactyl.zip`):** Upload `elfura-pterodactyl.zip` to `/home/container` in Pterodactyl's **Files** tab and click **Unarchive** (flat-root archive — extracts directly into `/home/container` with pre-built `dist/` and zero heavy `node_modules`). Edit `.env` (or Startup variables) with `ELFURA_SECRET`, `TMDB_API_BASE`, and `ALLOWED_ORIGINS`, keep `MAIN_FILE=index.js` (also supports `index.ts`, `server.js`, `app.js`, `main.js`, `bot.js`, `start.js`, and ParkerCP's `ts-node --esm` Node 24 Egg), and click **Start**.

## 7. Layout

```
RULES.md                  strict Part 1 / Part 2 architecture & zero-disk rules
src/core/params.ts        input schema (single source of truth)
src/core/config.ts        precedence + path/SSR boot + provenance + redaction
src/core/events.ts        event bus + origin-locked postMessage bridge
src/core/audio.ts         native/external tracks, language matching, sync engine
src/core/player.ts        engine adapters (lazy), uniform API client, source failover
src/subs/parser.ts        VTT / SRT / ASS -> Cue[]
src/subs/renderer.ts      DOM overlay renderer, drag-to-position
src/subs/style.ts         SubtitleStyle model, clamping, persistence
src/ui/controls.ts        chrome, Sources/Quality/CC/Speed/Audio panel, rAF loop
src/ui/styles.css         one accent property, derived shades
embed.html                iframe surface
backend/src/index.ts      zero-dep HTTP server + SSR token bootstrap
backend/src/config.ts     env config (SERVER_PORT, ELFURA_SECRET, TMDB_API_BASE)
backend/src/security.ts   HMAC pltoken, AES-256-GCM stream tickets, SSRF & rate limit
backend/src/tmdb.ts       self-hosted TMDB metadata client
backend/src/relay.ts      zero-disk HLS/DASH manifest rewriter & Range stream proxy
backend/src/sources/      isolated SourceAdapter registry + Source 1, Source 2 & Source 3 adapters
```

## Roxy operator dashboard

Open `/roxy` on the backend origin and sign in with the existing `ELFURA_SECRET` from `.env`. Configure a strong, non-placeholder secret and use HTTPS. The secret is not copied into the deployment ZIP. The dashboard shows actual embed playback starts, approximate active viewers (last heartbeat within 60 seconds), reported terminal playback failures, embedding origins, and an on-demand, title-specific source resolution/liveness test. Counts start from installation, not historical data; SDK and direct API playback are not included. Titles fall back to TMDB IDs when metadata is unavailable. A returned candidate or manifest liveness is not proof of complete playback. Test times include upstream fetches and liveness, not viewer startup latency.

Analytics are kept for 72 hours and pruned automatically. The clear button deletes analytics immediately but deliberately preserves site bans. Data and bans are persisted in `data/roxy.json` (or in the directory specified by `ROXY_DATA_DIR`), outside the deployment ZIP; keep this directory writable and persistent across deployments. No client IPs, full referrer URLs, stream URLs or playback tokens are stored. Storage errors are shown on the dashboard.

Website attribution and banning use the browser's `Referer` origin on embed requests. This is best-effort, not authentication: referrers can be absent or spoofed, direct API users are not covered, and already-playing streams are not immediately disconnected. Missing referrers appear as unknown. Use proper authenticated, origin-bound integration credentials and network policy if strong access control is required.

## Download pages (experimental)

The separate `/dl/` interface uses Elfura's existing HLS sources, not an external download catalogue. This prototype is **disabled by default** and is not ready for a production deployment. Enable it only in an isolated test environment with `ELFURA_EXPERIMENTAL_HLS_DOWNLOADS=1` and set `ELFURA_FFMPEG_PATH` to a compatible executable. FFmpeg is not bundled. The separate `elfura-hls-converter-test.zip` enables the prototype at startup and attempts to download a pinned Linux x64 FFmpeg package from npm in the background. It needs npm, tar, internet access, and approximately 300 MB of temporary free disk space. Playback starts independently if installation fails. Other architectures need a compatible executable supplied via the `ELFURA_FFMPEG_PATH` environment variable. No generic URL endpoint is provided.

It currently supports only complete unencrypted MPEG-TS HLS playlists without byte ranges or discontinuities; DASH, fMP4, encrypted/live playlists and separate external audio files are not supported. It stream-copies the chosen video and audio into a fragmented MP4 without re-encoding. The detail page checks playlist durations and the first segment timestamps before offering a download, and the converter preserves the source timestamp relationship. These checks cannot prove matching dialogue or perfect sync, or guarantee the rest of the file will succeed. Downloads consume server bandwidth, do not support resume, can be interrupted by upstream failures, and are limited to two concurrent jobs. The underlying relay's network security has not been independently audited for DNS rebinding; do not expose this prototype to untrusted clients. A share ticket lasts 30 minutes, but upstream links may expire earlier. Language and quality come from source metadata and aren't independently guaranteed.
