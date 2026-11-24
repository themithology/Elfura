/**
 * Elfura Backend — Source 1 Adapter
 * =================================
 * Multi-pipeline server-side stream resolver hardened against real-world
 * payloads verified across Hollywood blockbusters, K-dramas, TV anime, and
 * theatrical anime films:
 *   - Pipeline C: VidRift/Orion boot
 *   - Pipeline D: VidBolt
 *   - Pipeline E: VidRock
 */

import crypto from 'node:crypto';
import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from '../../src/sources/lang.js';
import { extractManifestAudioLangs } from '../stream-proxy.js';
import { readBoundedText } from './upstream-fetch.js';
import type {
  RawSourceResult,
  RawStreamCandidate,
  RawTrackRef,
  SourceAdapter,
  SourceQuery,
} from '../../src/sources/types.js';

export { normalizeLang } from '../../src/sources/lang.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const VROCK_KEY = Buffer.from(
  '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f',
  'hex',
);

const SUB_ORIGIN_COOLDOWN_MS = 5 * 60_000;
const deadSubOriginUntil = new Map<string, number>();

function isLoopbackOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

function isSubOriginCoolingDown(origin?: string): boolean {
  if (!origin) return true;
  if (isLoopbackOrigin(origin)) return false;
  const until = deadSubOriginUntil.get(origin);
  if (!until) return false;
  if (Date.now() < until) return true;
  deadSubOriginUntil.delete(origin);
  return false;
}

function tripSubOriginCooldown(origin?: string): void {
  if (!origin || isLoopbackOrigin(origin)) return;
  if (deadSubOriginUntil.size >= 64) {
    const oldest = deadSubOriginUntil.keys().next().value;
    if (oldest !== undefined) deadSubOriginUntil.delete(oldest);
  }
  deadSubOriginUntil.set(origin, Date.now() + SUB_ORIGIN_COOLDOWN_MS);
}

function inferStreamType(rawType?: string, url = ''): 'hls' | 'dash' | 'mp4' {
  const t = (rawType || '').toLowerCase();
  if (t === 'dash' || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (t === 'mp4' || t === 'mkv' || t === 'webm' || /\.(?:mp4|webm|mkv)(?:[?#]|$)/i.test(url)) return 'mp4';
  return 'hls';
}

function mapSubtitles(
  subs: { label?: string; lang?: string; url?: string }[] | undefined,
  baseHeaders?: Record<string, string>,
): RawTrackRef[] {
  if (!Array.isArray(subs)) return [];
  const seen = new Set<string>();
  const out: RawTrackRef[] = [];
  for (const s of subs) {
    if (!s?.url || !isSafeUpstreamUrl(s.url)) continue;
    const cleanLabel = String(s.label ?? '').replace(/\s*·\s*Orion\s*$/i, '').trim();
    const norm = normalizeLang(s.lang || cleanLabel, cleanLabel);
    const dedupKey = `${norm.code}:${s.url}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      lang: norm.code,
      label: norm.label,
      url: s.url,
      ...(baseHeaders ? { headers: baseHeaders } : {}),
    });
  }
  return out;
}

/**
 * Hosts that serve a vidbolt master behind a hotlink gate.
 *
 * Measured, not guessed (GitHub-runner probe, run 44039400814): the API returns
 * `img.rousav.tech` for movies and `gzip.rousav.tech` for TV. The old allowlist
 * was `(?:^|\.)(?:rousav\.tech|animecurx\.tech)$` — which matches the movie host
 * and NOT the TV host, so every TV request produced zero candidates while movie
 * requests quietly worked. That is why this lane looked half-alive on a movie
 * test and dead on a series. A `rousav.tech` apex-or-subdomain match covers both,
 * and proxy.vidbolt.xyz stays listed for the unwrapped-proxy shape.
 */
const VIDBOLT_GATED_HOST = /(?:^|\.)(?:rousav\.tech|animecurx\.tech|proxy\.vidbolt\.xyz)$/i;

/**
 * VidBolt — `/api/resolve`.
 *
 * This lane was written from a guess and the guess was wrong in three places,
 * each of which alone was enough to return zero candidates:
 *
 *  1. It sent `only=orion&hevc=0`. Neither parameter exists. Three independent
 *     scrapers that work against this API send exactly `type`, `id`, and for TV
 *     `season`/`episode` — nothing else.
 *  2. It sent `Referer: <origin>/` (the marketing homepage). The player is only
 *     served from a *title page*: `Reference: <origin>/movie/<tmdb>` or
 *     `<origin>/tv/<tmdb>/<s>/<e>`. VidBolt deliberately refuses a bare page
 *     load ("Opening the same URL in a new tab won't play"), which is why
 *     probing the title page out of band 404s while the embed plays.
 *  3. It allowlisted `rousav.tech` / `animecurx.tech` and dropped everything
 *     else. Those are one mirror pair; the API also hands back CDN hosts and
 *     `proxy.vidbolt.xyz`. The working scrapers validate the returned master
 *     playlist instead of trusting a host list, which is the right test: it
 *     measures the thing that matters (is this a real manifest) and cannot go
 *     stale when a mirror rotates.
 *
 * The 3 s timeout also had to go: this path resolves a manifest server-side and
 * regularly needs longer than a JSON head request.
 */
export async function fetchFromVidBolt(
  origin: string,
  query: SourceQuery,
  diag?: { push: (entry: Record<string, unknown>) => void },
): Promise<RawStreamCandidate[]> {
  const type = query.type === 'tv' ? 'tv' : 'movie';
  // No `only`, no `hevc`: the API takes type/id/season/episode and nothing else.
  const qs = new URLSearchParams({ type, id: String(query.tmdbId) });
  if (type === 'tv') {
    qs.set('season', String(query.season ?? 1));
    qs.set('episode', String(query.episode ?? 1));
  }
  const base = origin.replace(/\/+$/, '');
  // The player only answers when referred from its own title page.
  const referer =
    type === 'tv'
      ? `${base}/tv/${query.tmdbId}/${query.season ?? 1}/${query.episode ?? 1}`
      : `${base}/movie/${query.tmdbId}`;

  const startedAt = Date.now();
  try {
    const signal = query.signal
      ? AbortSignal.any([query.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    const res = await fetch(`${base}/api/resolve?${qs}`, {
      headers: {
        Accept: 'application/json, */*',
        Referer: referer,
        Origin: base,
        'User-Agent': BROWSER_UA,
      },
      signal,
    });
    if (!res.ok) {
      diag?.push({ adapter: 'source-1', lane: 'D', ok: false, ms: Date.now() - startedAt, detail: `vidbolt http=${res.status}` });
      return [];
    }
    const payload = (await res.json()) as {
      stream?: { sources?: { url?: string; type?: string; master?: unknown }[] };
      streamUrl?: unknown;
      url?: unknown;
      source?: { url?: unknown };
    };
    // New shape is stream.sources[].url; older deployments used a bare
    // streamUrl/url/source.url. Read both so a server on either shape works.
    type VidBoltRow = { url?: string; type?: string; master?: unknown };
    const rawRows: VidBoltRow[] = payload.stream?.sources?.length
      ? payload.stream.sources
      : [payload.streamUrl, payload.url, payload.source?.url]
          .filter((value): value is string => typeof value === 'string')
          .map((url): VidBoltRow => ({ url, type: 'hls' }));
    const out: RawStreamCandidate[] = [];
    for (const source of rawRows) {
      if (typeof source.url !== 'string' || !isSafeUpstreamUrl(source.url)) continue;
      if (inferStreamType(source.type, source.url) !== 'hls') continue;
      const host = new URL(source.url).hostname.toLowerCase();
      const testLoopback =
        process.env.NODE_ENV === 'test' &&
        process.env.ELFURA_ALLOW_LOOPBACK_TEST === '1' &&
        (host === 'localhost' || host === '127.0.0.1');
      // A gated mirror (rousav/animecurx/proxy.vidbolt.xyz) needs vidbolt's own
      // Referer/Origin to play. The working scrapers attach those to exactly
      // these hosts, so a bare CDN keeps its own headers and is not poisoned
      // with someone else's Origin.
      const headers: Record<string, string> = { 'User-Agent': BROWSER_UA };
      if (VIDBOLT_GATED_HOST.test(host) || testLoopback) {
        headers.Referer = `${base}/`;
        headers.Origin = base;
      }
      // The API's embedded master is a scheduling hint only. The actual URL
      // still has to pass independent manifest and child-playlist checks.
      const hintedLangs =
        typeof source.master === 'string' && source.master.length <= 512 * 1024
          ? extractManifestAudioLangs(source.master)
          : [];
      out.push({
        key: source.url,
        url: source.url,
        type: 'hls',
        quality: 'auto',
        rank: 4,
        ...(new Set(hintedLangs).size > 1
          ? { multiAudio: true, availableAudioLangs: hintedLangs }
          : {}),
        // The movie CDN has served 1080p and 720p bytes under 720p and 480p labels.
        // Keep adaptive playback, but do not advertise untrustworthy manual heights.
        ...(host === 'img.rousav.tech' ? { qualityLabelsUnreliable: true } : {}),
        headers,
      });
    }
    diag?.push({
      adapter: 'source-1',
      lane: 'D',
      ok: out.length > 0,
      ms: Date.now() - startedAt,
      detail: out.length ? `vidbolt candidates=${out.length}` : `vidbolt no-playable-hls rows=${rawRows.length}`,
    });
    return out;
  } catch (error) {
    diag?.push({
      adapter: 'source-1',
      lane: 'D',
      ok: false,
      ms: Date.now() - startedAt,
      detail: `vidbolt ${(error as Error).name}`,
    });
    return [];
  }
}
/** Optional direct Orion API, alongside (never replacing) the existing lanes.
 * Credentials are operator supplied and are never logged. Provider responses
 * and all subsequent media still go through normal safety/liveness checks. */
export async function fetchFromDirectOrion(cfg: BackendConfig['source1'], query: SourceQuery): Promise<RawStreamCandidate[]> {
  const key = query.type === 'tv' ? cfg.orionTvKey : cfg.orionMovieKey;
  if (!key || !/^\d{1,12}$/.test(query.tmdbId)) return [];
  const season = query.season ?? 1, episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) return [];
  const api = query.type === 'tv'
    ? `https://img.animecurx.tech/api/tv/${query.tmdbId}/${season}/${episode}`
    : `https://api.movy.lol/api/source/${query.tmdbId}`;
  const endpoint = new URL(api);
  endpoint.searchParams.set('api_key', key);
  endpoint.searchParams.set('apikey', key);
  const origin = (cfg.vidboltOrigin || 'https://vidbolt.xyz').replace(/\/+$/, '');
  const headers = { 'User-Agent': BROWSER_UA, Referer: `${origin}/`, Origin: origin, Accept: 'application/json, */*' };
  try {
    const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    const res = await fetch(endpoint, { headers, signal, redirect: 'error' });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return []; }
    const text = await readBoundedText(res, 1_048_576);
    if (!text) return [];
    const data = JSON.parse(text) as { sources?: { url?: unknown; file?: unknown; type?: string; master?: unknown }[]; m3u8_path?: unknown } | null;
    if (!data || typeof data !== 'object') return [];
    const rows = Array.isArray(data.sources) ? data.sources.slice(0, 20) : [];
    if (!rows.length && typeof data.m3u8_path === 'string' && /^[a-zA-Z0-9_./-]{1,2048}$/.test(data.m3u8_path) && !data.m3u8_path.split('/').includes('..')) {
      const url = new URL('/' + data.m3u8_path.replace(/^\/+/, ''), 'https://img.rousav.tech');
      url.searchParams.set('api_key', key);
      rows.push({ url: url.href });
    }
    const out: RawStreamCandidate[] = [];
    for (const row of rows) {
      const url = typeof row?.url === 'string' ? row.url : typeof row?.file === 'string' ? row.file : '';
      if (!isSafeUpstreamUrl(url) || inferStreamType(row?.type, url) !== 'hls') continue;
      const host = new URL(url).hostname.toLowerCase();
      const mediaHeaders: Record<string, string> = { 'User-Agent': BROWSER_UA };
      if (VIDBOLT_GATED_HOST.test(host)) { mediaHeaders.Referer = `${origin}/`; mediaHeaders.Origin = origin; }
      const hintedLangs = typeof row.master === 'string' && row.master.length <= 512 * 1024 ? extractManifestAudioLangs(row.master) : [];
      out.push({ key: url, url, type: 'hls', quality: 'auto', rank: 3, headers: mediaHeaders,
        ...(new Set(hintedLangs).size > 1 ? { multiAudio: true, availableAudioLangs: hintedLangs } : {}),
        ...(host === 'img.rousav.tech' ? { qualityLabelsUnreliable: true } : {}) });
    }
    return out;
  } catch { return []; }
}

async function fetchFromRiftBoot(
  cfg: BackendConfig['source1'],
  query: SourceQuery,
): Promise<RawStreamCandidate[]> {
  if (isSubOriginCoolingDown(cfg.riftOrigin)) return [];
  const bootPath =
    query.type === 'movie'
      ? `/api/boot/movie/${encodeURIComponent(query.tmdbId)}`
      : `/api/boot/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;
  const bootQuery = new URLSearchParams({ type: query.type, id: query.tmdbId, source: '0', provider: '', shell: '1' });
  const bootUrl = `${cfg.riftOrigin}${bootPath}?${bootQuery}`;
  try {
    const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
    const res = await fetch(bootUrl, {
      headers: {
        Accept: 'application/json',
        Referer: `${cfg.riftOrigin}/`,
        Origin: cfg.riftOrigin,
        'User-Agent': BROWSER_UA,
      },
      signal: sig,
    });
    if (!res.ok) {
      if (res.status === 404 || res.status >= 500) tripSubOriginCooldown(cfg.riftOrigin);
      return [];
    }

    const payload = (await res.json()) as {
      meta?: {
        evionUrl?: string;
        playbackToken?: string;
        orionStreams?: {
          url?: string;
          type?: string;
          name?: string;
          rungs?: { height?: number }[];
          subtitleListUrl?: string;
        }[];
      };
    };
    const meta = payload?.meta;
    if (!meta) return [];
    const riftPlaybackToken = typeof meta.playbackToken === 'string' ? meta.playbackToken.trim() : '';

    const orion = (meta.orionStreams ?? []).filter(
      (s) => typeof s?.url === 'string' && s.url.includes('/api/orion/'),
    );

    // Provider subtitles are deliberately not requested.

    const out: RawStreamCandidate[] = [];
    for (let i = 0; i < orion.length; i++) {
      const s = orion[i];
      if (!s.url) continue;
      const hash = s.url.split('/api/orion/')[1]?.split('/')[0];
      if (!hash) continue;

      const maxHeight = Math.max(0, ...(s.rungs ?? []).map((r) => Number(r.height || 0)));
      const streamType = inferStreamType(s.type, s.url);

      let finalUrl: string;
      let headers: Record<string, string> = { 'User-Agent': BROWSER_UA };
      if (streamType === 'mp4' && /^https?:\/\//i.test(s.url)) {
        // Direct progressive MP4 dub (e.g. mb.vidrift.net/.../video.mp4)
        finalUrl = s.url;
        headers = { Referer: `${cfg.riftOrigin}/`, 'User-Agent': BROWSER_UA };
      } else {
        const absTarget = /^https?:\/\//i.test(s.url)
          ? s.url
          : `${cfg.riftOrigin}/api/orion/${hash}/master.m3u8`;
        const directOrionHeaders: Record<string, string> = {
          Referer: `${cfg.riftOrigin}/`,
          Origin: cfg.riftOrigin,
          'User-Agent': BROWSER_UA,
          ...(riftPlaybackToken ? { 'X-Playback-Token': riftPlaybackToken } : {}),
        };
        if (riftPlaybackToken && isSafeUpstreamUrl(absTarget)) {
          // Prefer direct Orion HLS when boot provided a live playbackToken.
          finalUrl = absTarget;
          headers = directOrionHeaders;
        } else {
          // No playback token from boot: the Orion target is the stream.
          finalUrl = absTarget;
          headers = directOrionHeaders;
        }
      }

      if (!isSafeUpstreamUrl(finalUrl)) continue;

      // Orion exposes separate single-language servers. Preserve only an
      // explicit language label as a hint; never claim these are multi-audio.
      const namedLanguage = typeof s.name === 'string' ? s.name.split('·').pop()?.trim() : undefined;
      const language = namedLanguage ? normalizeLang(namedLanguage) : undefined;
      out.push({
        key: `orion:${hash}:${streamType}`,
        ...(language && language.code !== 'und' ? { audioLang: language.code, audioLabel: language.label } : {}),
        type: streamType,
        url: finalUrl,
        headers,
        quality: maxHeight ? `${maxHeight}p` : 'auto',
        // Language must come from manifest evidence, not the provider's stream name.
        multiAudio: false,
        rank: (streamType === 'hls' ? 15 : 35) + i,
      });
    }

    if (typeof meta.evionUrl === 'string' && isSafeUpstreamUrl(meta.evionUrl)) {
      out.push({
        key: meta.evionUrl,
        type: inferStreamType('hls', meta.evionUrl),
        url: meta.evionUrl,
        headers: {
          Referer: `${cfg.riftOrigin}/`,
          'User-Agent': BROWSER_UA,
        },
        quality: 'auto',
        rank: 45,
      });
    }

    return out;
  } catch {
    return [];
  }
}

const GENERIC_VROCK_SERVER_RE =
  /^(?:nova|atlas|orion|astra|luna|lyra|vega|hydra|alpha|beta|delta|omega|server\s*\d*|auto|main|backup|vip\s*\d*)$/i;

function decryptVidRockToken(token: string): string | null {
  try {
    const clean = token.trim();
    if (!clean || clean.length < 40) return null;
    const raw = Buffer.from(clean, 'base64url');
    if (raw.length <= 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', VROCK_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8').trim();
  } catch {
    return null;
  }
}

async function fetchFromVidRock(
  cfg: BackendConfig['source1'],
  query: SourceQuery,
): Promise<RawStreamCandidate[]> {
  const origin = cfg.vidrockOrigin;
  if (!origin || isSubOriginCoolingDown(origin)) return [];

  const apiPath =
    query.type === 'movie'
      ? `/api/movie/${encodeURIComponent(query.tmdbId)}`
      : `/api/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;

  try {
    const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3200)]) : AbortSignal.timeout(3200);
    const res = await fetch(`${origin}${apiPath}`, {
      headers: {
        Accept: 'application/json',
        Referer: `${origin}/`,
        Origin: origin,
        'User-Agent': BROWSER_UA,
      },
      signal: sig,
    });
    if (!res.ok) {
      if (res.status >= 500) tripSubOriginCooldown(origin);
      return [];
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object') return [];

    // VidRock's ngcorp media hosts reject real browser user agents and any
    // vidrock.net Referer. Their accepted stream contract is a single-space
    // UA with no Origin/Referer; the API request above intentionally uses
    // different headers from the media requests.
    const mediaHeaders: Record<string, string> = { 'User-Agent': ' ' };

    const out: RawStreamCandidate[] = [];
    const seen = new Set<string>();
    let idx = 0;

    for (const [srvName, rawVal] of Object.entries(body)) {
      let streamUrl = '';
      let subs: RawTrackRef[] = [];

      if (typeof rawVal === 'string') {
        const dec = /^https?:\/\//i.test(rawVal) ? rawVal : decryptVidRockToken(rawVal);
        if (!dec) continue;
        if (dec.startsWith('{')) {
          try {
            const parsed = JSON.parse(dec) as {
              url?: string;
              file?: string;
              subtitles?: { label?: string; lang?: string; url?: string }[];
            };
            streamUrl = String(parsed.url || parsed.file || '').trim();
            subs = mapSubtitles(parsed.subtitles, mediaHeaders);
          } catch {
            continue;
          }
        } else {
          streamUrl = dec;
        }
      } else if (rawVal && typeof rawVal === 'object') {
        const obj = rawVal as {
          url?: string;
          token?: string;
          hash?: string;
          subtitles?: { label?: string; lang?: string; url?: string }[];
        };
        const candidateStr = String(obj.url || obj.token || obj.hash || '').trim();
        const dec = /^https?:\/\//i.test(candidateStr) ? candidateStr : decryptVidRockToken(candidateStr);
        if (dec) streamUrl = dec;
        subs = mapSubtitles(obj.subtitles, mediaHeaders);
      }

      if (!streamUrl || !isSafeUpstreamUrl(streamUrl) || seen.has(streamUrl)) continue;
      try {
        const mediaHost = new URL(streamUrl).hostname.toLowerCase();
        // Workers lanes are TLS/browser-gated and return a placeholder rather
        // than an HLS manifest to the backend. Never advertise them as playable.
        //
        // I tried removing this (TG FROST serves DASH through
        // `cinemaos-relay.*.workers.dev`, and "maximum sources" argues against
        // dropping anything by hostname). Reverted on evidence: the same GitHub
        // runner that plays those streams fine inside a real browser gets a
        // TypeError for them from a plain fetch, with browser headers mirrored
        // exactly. It is TLS-fingerprint gating, not a header gap, so a backend
        // fetch cannot read these manifests at all. The guard is correct.
        if (mediaHost === 'workers.dev' || mediaHost.endsWith('.workers.dev')) continue;
      } catch {
        continue;
      }
      seen.add(streamUrl);

      let audioLang: string | undefined;
      let audioLabel: string | undefined;
      if (!GENERIC_VROCK_SERVER_RE.test(srvName.trim())) {
        const norm = normalizeLang(srvName, srvName);
        if (norm.code && norm.code !== 'und') {
          audioLang = norm.code;
          audioLabel = norm.label;
        }
      }

      out.push({
        key: `vrock:${srvName}:${streamUrl}`,
        type: inferStreamType('hls', streamUrl),
        url: streamUrl,
        headers: mediaHeaders,
        quality: 'auto',
        ...(audioLang ? { audioLang, audioLabel } : {}),
        multiAudio: false,
        subtitles: subs,
        rank: 8 + idx++,
      });
    }

    return out;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Source 1 Adapter Factory                                            */
/* ------------------------------------------------------------------ */

export function createSource1Adapter(
  cfg: BackendConfig['source1'],
  group: 1 | 2 = 2,
  options: { includeVidBolt?: boolean; id?: string; label?: string } = {},
): SourceAdapter {
  // `group` selects which upstreams to run (2 = vidrift + vidrock + vidbolt);
  // it must NOT decide the adapter's identity. Deriving the id from it is how
  // this adapter ended up registered as `source-2` while a different file
  // owned that name, which made every lane it produced unattributable.
  const id = options.id ?? `source-${group}`;
  return {
    id,
    label: options.label ?? (options.id ? `Source ${options.id.replace(/\D/g, '')}` : `Source ${group}`),
    enabled: () => cfg.enabled,

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      const t0 = performance.now();
      const timed = <T>(p: Promise<T>): Promise<{ val: T; ms: number }> =>
        p.then((val) => ({ val, ms: Math.max(1, Math.round(performance.now() - t0)) }));

      const slots: {
        rift: { val: RawStreamCandidate[]; ms: number } | null;
        sync: { val: RawStreamCandidate[]; ms: number } | null;
        rock: { val: RawStreamCandidate[]; ms: number } | null;
        orion: { val: RawStreamCandidate[]; ms: number } | null;
      } = {
        rift: null,
        sync: null,
        rock: null,
        orion: null,
      };

      const useOrion = group === 2 && options.includeVidBolt !== false && !!(query.type === 'tv' ? cfg.orionTvKey : cfg.orionMovieKey);
      const totalPipelines = useOrion ? 4 : 3;
      let settledCount = 0;
      let liveSourcePipelines = 0;
      let releaseEarly: (() => void) | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const checkFastSettle = () => {
        if (settledCount >= totalPipelines) {
          releaseEarly?.();
          return;
        }
        // Start a short grace window once any pipeline returns candidates.
        if (liveSourcePipelines >= 1 && !graceTimer) {
          // Allow concurrent lanes a brief chance to finish, never wait for
          // multiple providers just because one is slow or unavailable.
          graceTimer = setTimeout(() => releaseEarly?.(), 700);
        }
      };

      const pRift = timed(group === 2 ? fetchFromRiftBoot(cfg, query) : Promise.resolve([])).then((r) => {
        slots.rift = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const pSync = timed(group === 2 && options.includeVidBolt !== false ? fetchFromVidBolt(cfg.vidboltOrigin || 'https://vidbolt.xyz', query) : Promise.resolve([] as RawStreamCandidate[])).then((r) => {
        slots.sync = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const pRock = timed(group === 2 ? fetchFromVidRock(cfg, query) : Promise.resolve([])).then((r) => {
        slots.rock = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const pOrion = useOrion ? timed(fetchFromDirectOrion(cfg, query)).then((r) => {
        slots.orion = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      }) : null;
      const allLanes = Promise.allSettled([pRift, pSync, pRock, ...(pOrion ? [pOrion] : [])]);
      // A diagnostic must measure every lane, even those skipped by the fast
      // playback race. Normal playback retains its short grace window.
      if (query.diag) await allLanes;
      else await Promise.race([
        allLanes,
        new Promise<void>((r) => { releaseEarly = r; }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);

      const buildResult = (): RawSourceResult => {
      // Do NOT stamp upstream JSON-scraper RPC duration onto `latencyMs`: leave `latencyMs`
      // unset unless known so `liveness.ts` populates the true measured CDN manifest RTT!
      const withTiming = (list: RawStreamCandidate[], ms: number): RawStreamCandidate[] =>
        list.map((c) => ({
          ...c,
          fingerprint: c.fingerprint || c.key,
          ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
          rank: c.rank + Math.min(ms, 5000) / 1000,
        }));

      const riftCandidates = slots.rift ? withTiming(slots.rift.val, slots.rift.ms).map(c => query.diag ? { ...c, diagnosticLane: 'C' } : c) : [];
      const syncCandidates = slots.sync ? withTiming(slots.sync.val, slots.sync.ms).map(c => query.diag ? { ...c, diagnosticLane: 'D' } : c) : [];
      const rockCandidates = slots.rock ? withTiming(slots.rock.val, slots.rock.ms).map(c => query.diag ? { ...c, diagnosticLane: 'E' } : c) : [];
      const orionCandidates = slots.orion ? withTiming(slots.orion.val, slots.orion.ms).map(c => query.diag ? { ...c, diagnosticLane: 'O' } : c) : [];

      const byUrl = new Map<string, RawStreamCandidate>();
      for (const c of [
        ...orionCandidates,
        ...syncCandidates,
        ...rockCandidates,
        ...riftCandidates,
      ]) {
        const existing = byUrl.get(c.key);
        if (!existing) {
          byUrl.set(c.key, c);
        } else {
          if (c.latencyMs !== undefined && (existing.latencyMs === undefined || c.latencyMs < existing.latencyMs)) {
            existing.latencyMs = c.latencyMs;
          }
          if (c.subtitles?.length) {
            const mergedSubs = [...(existing.subtitles ?? [])];
            for (const sub of c.subtitles) {
              if (!mergedSubs.some((x) => x.lang === sub.lang && x.url === sub.url)) mergedSubs.push(sub);
            }
            existing.subtitles = mergedSubs;
          }
        }
      }

      const pooledSubs: RawTrackRef[] = [];
      const seenSubKey = new Set<string>();
      for (const c of byUrl.values()) {
        for (const sub of c.subtitles ?? []) {
          const sk = `${sub.lang}:${sub.url}`;
          if (!seenSubKey.has(sk)) {
            seenSubKey.add(sk);
            pooledSubs.push(sub);
          }
        }
      }
      if (pooledSubs.length) {
        for (const c of byUrl.values()) {
          if (!c.subtitles || c.subtitles.length === 0) {
            c.subtitles = pooledSubs;
          }
        }
      }

      const prefCode = query.preferredLang ? normalizeLang(query.preferredLang).code : '';
      const prefPrimary = prefCode && prefCode !== 'und' ? prefCode.split('-')[0] : '';
      const candidates = [...byUrl.values()].sort((a, b) => {
        if (prefPrimary) {
          const score = (c: RawStreamCandidate) => {
            if (c.audioLang === prefCode || c.availableAudioLangs?.includes(prefCode)) return 0;
            if (
              c.audioLang?.split('-')[0] === prefPrimary ||
              c.availableAudioLangs?.some((l) => l.split('-')[0] === prefPrimary)
            ) {
              return 1;
            }
            if (c.multiAudio && !c.availableAudioLangs?.length) return 2;
            return 3;
          };
          const diff = score(a) - score(b);
          if (diff !== 0) return diff;
        } else {
          if (!!a.multiAudio !== !!b.multiAudio) return a.multiAudio ? -1 : 1;
        }
        return a.rank - b.rank;
      });

      if (query.diag) {
        const lane = (name: string, slot: { ms: number } | null, count: number) =>
          query.diag!.push({
            adapter: id,
            lane: name,
            ok: !!slot && count > 0,
            ms: slot?.ms ?? 0,
            detail: !slot ? 'not-settled' : `candidates=${count}`,
          });
        if (group === 2) {
          lane('C', slots.rift, riftCandidates.length);
          if (options.includeVidBolt !== false) lane('D', slots.sync, syncCandidates.length);
          lane('E', slots.rock, rockCandidates.length);
          if (useOrion) lane('O', slots.orion, orionCandidates.length);
        }
      }

      return {
        candidates,
      };
      };
      const initial = buildResult();
      if (!query.diag && settledCount < totalPipelines && query.onLateResult) {
        void allLanes.then(() => { query.onLateResult?.(buildResult()); });
      }
      return initial;
    },
  };
}
