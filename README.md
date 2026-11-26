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
| `tmdb` | id | `94605` | TMDB ID used by the standard playback sources |
| `anilist` | id | `16498` | AniList ID used by bundled Anivexa; provide this alongside `tmdb` to load and prioritize anime sources |
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

### Detect an episode change on the host site

The player sends an `episodeChange` event whenever an episode is selected,
including the Next Episode button, automatic advance, episode selector, and the
`loadEpisode` or `next` command. Re-selecting the current episode does not fire
an event. It fires when the switch **starts**; it does not guarantee that a source
loaded or playback succeeded. The iframe stays in
place. A host can update its episode highlight or URL without reloading it:

```html
<iframe id="elfura" src="https://play.example.com/embed/tv/1399/1/1?origin=https%3A%2F%2Fwatch.example.com"
        allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>
<script>
  const iframe = document.getElementById('elfura');
  const playerOrigin = 'https://play.example.com'; // exact player origin

  window.addEventListener('message', (event) => {
    // Ignore messages from other origins and other iframes.
    if (event.origin !== playerOrigin || event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg || msg.__elfura !== 1 || msg.v !== 1 ||
        msg.kind !== 'event' || msg.name !== 'episodeChange') return;
    const { tmdbId, season, episode, previous } = msg.data;
    console.log('Now selected:', tmdbId, season, episode, 'previous:', previous);
    // Update your episode selector or use history.replaceState here.
  });
</script>
```

The payload is `{ mediaType: 'tv', tmdbId: '1399', season: 1, episode: 2,
previous: { season: 1, episode: 1 } }`. It contains no playback tokens or
stream URLs. `origin` in the iframe URL must be the **host page's** exact
origin; omit it only when the host's origin is reliably available in the
referrer. Keep `postMessage` enabled. The SDK alternative is
`createHostClient(iframe, playerOrigin).on('episodeChange', callback)`.
A new episode starts at zero even if the previous embed had a `t` start offset;
switching sources or audio within the same episode still preserves position.

## 6. Uniform Backend & Pterodactyl Deployment (`backend/`)

Elfura maintains a strict separation between **Part 1 (`src/`)** and **Part 2 (`backend/`)** (see [`RULES.md`](./RULES.md)):

- **Clean TMDB Embed URLs:**
  - Movie: `/embed/movie/:tmdbId` or `/embed?tmdb=:tmdbId&type=movie`
  - TV Episode: `/embed/tv/:tmdbId/:season/:episode` or `/embed?tmdb=:tmdbId&type=tv&s=1&e=1`
  - Anime episode with AniList-aware providers prioritized: `/embed?tmdb=:tmdbId&anilist=:anilistId&type=tv&s=1&e=1`
- **Single Uniform Endpoint (`GET/POST /api/v1/playback`):** Resolves TMDB metadata (from your self-hosted `TMDB_API_BASE`) + modular `SourceAdapter` streams into one uniform schema with zero upstream provider names or raw CDN URLs exposed, wrapped in an **AES-256-GCM Sealed Playback Envelope** (`X-Elfura-Envelope: 1`) so DevTools Network Preview and copied cURL commands only see ciphertext.
- **Smart Hybrid Stream Relay (`GET /api/v1/stream?t=<ticket>`, `RELAY_MODE=hybrid`):** Encrypts upstream URLs and required `Referer`/`Origin` headers inside AES-256-GCM tickets, always relays manifests/subtitles/keys and header-locked or source-identifying streams in memory with zero disk writes, and offloads verified anonymous CORS-safe HTTPS video segments directly to edge CDNs (keeping Cloudflare Proxy & 2 GB RAM Pterodactyl containers safe at scale, with automatic `&p=1` backend-tunnel failover if a viewer's ISP blocks an external CDN).
- **Pterodactyl Ready (`elfura-pterodactyl.zip`):** Upload `elfura-pterodactyl.zip` to `/home/container` in Pterodactyl's **Files** tab and click **Unarchive** (flat-root archive — extracts directly into `/home/container` with pre-built `dist/` and zero heavy `node_modules`). Edit `.env` (or Startup variables) with `ELFURA_SECRET`, `TMDB_API_BASE`, and `ALLOWED_ORIGINS`, then click **Start**.

  **Startup file: set it to `index.js`.** The zip ships `index.js`, `server.js`, `app.js`, `main.js`, `bot.js`, `start.js` and `src/index.js` — all identical plain JavaScript, so whichever name your egg expects exists. Do **not** point the startup command at a TypeScript toolchain.

  If your egg hard-codes `ts-node --esm index.ts`, change it to `node index.js`. TypeScript files are deliberately not shipped: this project's runtime output is already compiled into `dist/`, and a `.ts` entrypoint makes the host install a compiler it never needs. Some `ts-node` 10.x builds also crash on Node 22 with `Cannot find module './--max-old-space-size=384'` inside `imaginaryUncacheableRequireResolveScript`, which reads as a boot loop in the panel console.

  If you cannot change the startup command, `node index.js` still works when launched through `ts-node`/`tsx` — the entrypoint detects a TypeScript runner, ignores its injected flags, and serves the compiled build. It just needs the runner installed.
<<<<<<< HEAD
=======

### Deployment layouts: one server or two

The project is **one build** that runs in **two roles**. You deploy the same
`elfura-pterodactyl.zip` either once or twice depending on how much isolation you
want. There is no separate resolver package to download.

| Role | Command | Does | Never does |
| --- | --- | --- | --- |
| **Media server** | `node index.js` | Serves embeds, the player, video relay, catalogue, control panel; mints and checks stream tickets | Scrapes providers (when a resolver is configured) |
| **Resolver** | `node index.js --resolver` | Scrapes providers, keeps per-source health, answers `/resolver/api/*` | Serves video, serves embeds, exposes a player |

They share `ELFURA_SECRET` so a stream ticket minted by the resolver opens in the
media server. The player, the relay and the ticket format are identical in every
layout below — that is the point of the seam.

#### Layout A — one server (simplest, and fine)

One Pterodactyl server. One startup command. Everything in one process.

```ini
# .env / Startup variables
ELFURA_SECRET=<a long random string>
TMDB_API_BASE=https://your-tmdb.example
ALLOWED_ORIGINS=https://your-site.example
```

Do nothing else. Resolution happens in-process. Per-source health and the kill
switch work exactly the same. **This is a supported deployment, not a degraded
one.**

If you later want the scraping isolated but still only own one server, add:

```ini
ELFURA_RESOLVER_AUTOSTART=1
```

The media server starts the resolver itself on `SERVER_PORT + 3`, bound to
`127.0.0.1` only, and supervises it. You still have **one** Pterodactyl server;
you now have two processes inside it. If the resolver dies, video keeps serving
and the dashboard tells you.

> RAM: two Node processes in a 500 MB container is tight. Each is capped at
> 384 MB old-space, so they cannot both peak, but if you see restarts after
> enabling this, that is the first thing to check. If in doubt, stay on Layout A
> without autostart, or move to Layout B.

#### Layout B — two servers (full isolation)

Two Pterodactyl servers, same egg, same ZIP, **different startup variables**. They
must be on a private network that can reach each other — a WireGuard/Tailscale
mesh, or two instances on the same host's private network. Do not put the
resolver on the public internet; the media server refuses a public resolver URL
for exactly that reason (see the guard below).

**Server 1 — media server (this is the one your viewers reach)**

```ini
ELFURA_SECRET=<the SAME long random string as server 2>
ELFURA_RESOLVER_URL=http://<resolver-private-ip>:8793
TMDB_API_BASE=https://your-tmdb.example
ALLOWED_ORIGINS=https://your-site.example
SERVER_PORT=8790
```

Started with `node index.js`. This box is the only one that should be publicly
reachable. It holds no provider logic.

**Server 2 — resolver (nothing public, ever)**

```ini
ELFURA_SECRET=<the SAME long random string as server 1>
ELFURA_RESOLVER_LISTEN=<its private IP, e.g. 10.8.0.2>
ELFURA_RESOLVER_PORT=8793
```

Started with `node index.js --resolver`. **Do not** expose a port or a public
domain for this server. It needs outbound internet (to reach providers) and
inbound from server 1 only.

What must match:

| Value | Server 1 | Server 2 |
| --- | --- | --- |
| `ELFURA_SECRET` | same | same |
| Resolver address | `ELFURA_RESOLVER_URL` → server 2 | `ELFURA_RESOLVER_LISTEN` / `_PORT` |
| Startup command | `node index.js` | `node index.js --resolver` |

What must **not** be set on server 2: `ALLOWED_ORIGINS`, `SERVER_PORT` (that is the
media port), `ELFURA_RESOLVER_URL` (it would make the resolver try to use a
resolver). And do not set `ELFURA_RESOLVER_AUTOSTART=1` on server 2 — it is not
needed there and would be ignored anyway.

#### Verifying the wiring

```bash
# from server 1 — should answer {"ok":true,"service":"elfura-resolver"}
curl http://<resolver-private-ip>:8793/resolver/api/health

# from anywhere else — should NOT answer
curl http://<resolver-public-ip>:8793/resolver/api/health
```

Then sign in to `/roxy` on server 1 → **Source health**. The tag reads
`RESOLVER · SEPARATE PROCESS` when server 1 is really using server 2. If it reads
`IN-PROCESS`, server 1 did not accept your URL (check the console: it says why).

#### Keeping the resolver and its sources hidden

Three things enforce this, all covered by tests:

1. **The resolver has no public surface.** It binds `127.0.0.1` unless you set
   `ELFURA_RESOLVER_LISTEN`. Its only unauthenticated route is
   `/resolver/api/health`, which returns `{"ok":true,"service":"elfura-resolver"}`
   and nothing else — no source ids, no count, no port.
2. **The media server does not proxy it.** `/resolver/api/*` returns 404 on the
   public server. There is no route that forwards to the resolver.
3. **The public health endpoint no longer lists sources.** `/api/v1/health` used
   to name every configured source to anyone who asked; it now returns a bare
   `sourceCount`.

The resolver URL itself must be private. `localhost`, `127.x`, `10.x`,
`172.16–31.x`, `192.168.x`, `100.64–127.x` (Tailscale/WireGuard) and
`*.internal` / `*.local` / `*.lan` are accepted. Anything else is refused at
startup with an explanation, because over the open internet every call would send
the shared token and receive source names back. If you genuinely have a
TLS-protected private link you trust, `ELFURA_RESOLVER_ALLOW_PUBLIC=1` overrides —
it is there deliberately, not by accident.

| Variable | Meaning |
| --- | --- |
| `ELFURA_RESOLVER_AUTOSTART` | `1` starts a resolver from the media server (Layout A+). Ignored if `ELFURA_RESOLVER_URL` is set. |
| `ELFURA_RESOLVER_URL` | Base URL of the resolver (Layout B). Unset means "resolve in this process". Must be a private address. |
| `ELFURA_RESOLVER_LISTEN` | Address the resolver binds. Default `127.0.0.1`. Set to the private IP in Layout B. |
| `ELFURA_RESOLVER_PORT` | Resolver port. Default `SERVER_PORT + 3`. |
| `ELFURA_RESOLVER_TOKEN` | Resolver API token. Falls back to `ELFURA_SECRET`, so usually nothing to set. |
| `ELFURA_RESOLVER_ALLOW_PUBLIC` | `1` permits a public resolver URL. Off by default, on purpose. |
| `ELFURA_RESOLVER_VERBOSE` | `1` makes the resolver log its port and source count (off by default so a shared panel console stays quiet). |

What the split guarantees, and what the suite pins:

- **A broken provider cannot touch a stream that is already playing.** The relay
  reads tickets, not providers. It never asks the resolver on the stream path.
- **A resolver outage is a 503, never a 404.** "No source for this title" and
  "our scraper is down" are different facts and must not look the same.
- **Media serving does not depend on it.** Health, catalogue, embeds and the panel
  keep answering while the resolver is dead, and recover on their own — no restart.
- **A failing source is recorded and displayed, never switched off automatically.**
  Nothing here decides on its own that a provider is finished. Failures appear in
  the dashboard with the error and the streak; removing a source from rotation is
  only ever an operator action, and it is reversible in one click.

Per-source health lives in the **Source health** panel on `/roxy`. Each source
shows whether it is healthy, failing, or switched off by you, with its last error
and consecutive failure count. **Switch off** stops it from being called at all;
**Switch back on** returns it immediately and clears its streak. If the resolver
itself is unreachable the panel says so instead of showing an empty list — zero
sources and an unreachable resolver are not the same thing.

## Roxy operator dashboard

Open `/roxy` on the backend origin and sign in with the existing `ELFURA_SECRET` from `.env`. Configure a strong, non-placeholder secret and use HTTPS. The secret is not copied into the deployment ZIP. The dashboard shows actual embed playback starts, approximate active viewers (last heartbeat within 60 seconds), reported terminal playback failures, embedding origins, on-demand HTTP checks of source websites, and live per-source health with a kill
switch for each source. Counts start from installation, not historical data; SDK and direct API playback are not included. Titles fall back to TMDB IDs when metadata is unavailable. An HTTP response does not guarantee playback.

Analytics are kept for 72 hours and pruned automatically. The clear button deletes analytics immediately but deliberately preserves site bans. Data and bans are persisted in `data/roxy.json` (or in the directory specified by `ROXY_DATA_DIR`), outside the deployment ZIP; keep this directory writable and persistent across deployments. No client IPs, full referrer URLs, stream URLs or playback tokens are stored. Storage errors are shown on the dashboard.

### Recommended: Cloudflare Worker relay (no `.env` editing)

A proxy list costs money per request and gets throttled — discovery alone fires
dozens of requests per page load. A Cloudflare Worker is the better egress: one URL,
one hop, no credential rotation, and the free plan's 100,000 requests/day is far above
what discovery uses.

1. Deploy `cloudflare-worker/worker.js` — see [cloudflare-worker/README.md](./cloudflare-worker/README.md)
   for the browser-only steps and the `TOKEN` secret.
2. In `/roxy`, open **Egress relay**, paste the Worker URL and the token, then **Save**.
3. Press **Test relay**. It answers with Cloudflare's exit address, which should not be
   this server's address.

The boot log then says `discovery requests are relayed through <host>`. If the Worker
ever fails three times in a row it is skipped for a minute and requests go direct, so a
broken relay degrades to the previous behaviour instead of stalling every source. Media
playback never goes through the relay.

The URL and token can also be set as `ELFURA_UPSTREAM_RELAY` / `ELFURA_RELAY_TOKEN`, in
which case the environment or `.env` wins and the panel shows the value as locked.

### Proxy list (no `.env` editing)

If source discovery fails because provider websites refuse this server's IP, upload a proxy list instead of editing files. Open `/roxy`, sign in, and use the **Proxy pool** panel: pick your provider's `.txt` file and press **Upload proxy list**, or paste the lines into the box and press **Save pasted list**. One proxy per line, in any of these shapes:

```
45.38.107.97:6014:username:password     ← Webshare's export format
http://username:password@host:port
username:password@host:port
host:port                                ← open proxy, no login
```

Press **Test all** to check the list. Each reachable proxy shows the exit address the internet sees, and the panel reports how many answered. If none answer, the panel also probes the same endpoint *without* a proxy: when that works, the proxies are the problem; when it also fails, the hosting network is. Working proxies are used for source discovery in rotation, three per request, with automatic failover and a direct fallback, so one dead proxy never removes a source. A proxy that fails three times rests for a minute and is marked `SKIPPED`. Passwords are written to `data/proxies.json` (mode 0600) and are never returned to the browser or written to the log. The uploaded list takes precedence over the single `ELFURA_UPSTREAM_PROXY` `.env` value. Media playback traffic is not routed through the list.

Website attribution and banning use the browser's `Referer` origin on embed requests. This is best-effort, not authentication: referrers can be absent or spoofed, direct API users are not covered, and already-playing streams are not immediately disconnected. Missing referrers appear as unknown. Use proper authenticated, origin-bound integration credentials and network policy if strong access control is required.


### Source 26 retired

MovieBox (Source 26) is not registered, including when an older `.env` contains
`ELFURA_MOVIEBOX_ENABLED=1`. Browser tests showed audio-only playback for the
HEVC streams on browsers without HEVC decoding, and some reported resolutions
were inaccurate. Research adapters remain unregistered until real video playback,
audio switching and episode identity have been verified.

Protocol reference: [MovieBox-TUI](https://github.com/mesamirh/MovieBox-Tui/tree/b901738b56170c278b35468c32ade32b9de1890d/src/providers/moviebox)
(MIT OR Apache-2.0). `.github/workflows/moviebox-direct.yml` checks the adapter
with mocked responses and probes a movie and an episode on a GitHub runner.
The ffprobe test checks media streams, not browser playback or audio switching.
# Multi-audio anime source (Source 28)

Source 28 resolves directly from the anime catalogue to a multi-audio HLS master. It runs only in the resolver and never sends catalogue or player URLs to the client. Audio languages and available quality levels are read from the actual HLS manifest, not assumed from a title or subtitle labels.

The source is enabled by default. Set `ELFURA_ANIME_MULTI_ENABLED=0` on each resolver and restart to disable it. A TMDB API key or configured TMDB mirror is required. To avoid wrong episodes, the source currently supports season 1 only and requires TMDB to identify Japanese animation and provide an episode title that matches the provider's title. Missing metadata, alternate title spellings or numbering differences can cause legitimate episodes to be skipped. Movies and other seasons are not supported by this lane.

The browser audit exercises real discovery, the production registry and relay, video rendering, audio switches, non-silent decoded audio, and two different episode frames for two shows. It uses fixture metadata and a mocked playback response, and does not independently establish the spoken language or episode identity; language names come from upstream HLS metadata. Availability may vary by region or over time.

The deployment ZIP includes `wreq-js` and the native bindings available on the build host (the published bundle is Linux x64). On another architecture, install the optional runtime dependency on the resolver with `npm install --omit=dev` in the extracted application directory and restart it. If the native client is unavailable, this source is skipped; other sources continue to work.

