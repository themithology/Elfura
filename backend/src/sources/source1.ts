/**
 * Elfura Backend — Source 1 Adapter
 * =================================
 * Multi-pipeline server-side stream resolver hardened against real-world
 * payloads verified across Hollywood blockbusters, K-dramas, TV anime, and
 * theatrical anime films:
 *   - Pipeline C: VidRift/Orion boot
 *   - Pipeline D: VidBolt
 *   - Pipeline E: VidRock
 *   - Pipeline F: VidLink
 */

import crypto from 'node:crypto';
import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import { extractManifestAudioLangs } from '../relay.js';
import type {
  RawSourceResult,
  RawStreamCandidate,
  RawTrackRef,
  SourceAdapter,
  SourceQuery,
} from './types.js';

export { normalizeLang } from './lang.js';

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

export async function fetchFromVidBolt(
  origin: string,
  query: SourceQuery,
): Promise<RawStreamCandidate[]> {
  const qs = new URLSearchParams({ type: query.type, id: query.tmdbId, only: 'orion', hevc: '0' });
  if (query.type === 'tv') {
    qs.set('season', String(query.season ?? 1));
    qs.set('episode', String(query.episode ?? 1));
  }
  try {
    const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3800)]) : AbortSignal.timeout(3800);
    const res = await fetch(`${origin}/api/resolve?${qs}`, {
      headers: { Accept: 'application/json', Referer: `${origin}/`, Origin: origin, 'User-Agent': BROWSER_UA },
      signal,
    });
    if (!res.ok) return [];
    const payload = (await res.json()) as { stream?: { sources?: { url?: string; type?: string; master?: unknown }[] } };
    const out: RawStreamCandidate[] = [];
    for (const source of payload.stream?.sources ?? []) {
      if (typeof source.url !== 'string' || !isSafeUpstreamUrl(source.url)) continue;
      const host = new URL(source.url).hostname.toLowerCase();
      const testLoopback = process.env.NODE_ENV === 'test' && process.env.ELFURA_ALLOW_LOOPBACK_TEST === '1' && (host === 'localhost' || host === '127.0.0.1');
      if (!testLoopback && !/(?:^|\.)(?:rousav\.tech|animecurx\.tech)$/.test(host)) continue;
      if (inferStreamType(source.type, source.url) !== 'hls') continue;
      // The API's embedded master is a scheduling hint only. The actual URL
      // still has to pass independent manifest and child-playlist checks.
      const hintedLangs = typeof source.master === 'string' && source.master.length <= 512 * 1024
        ? extractManifestAudioLangs(source.master) : [];
      out.push({ key: source.url, url: source.url, type: 'hls', quality: 'auto', rank: 4,
        ...(new Set(hintedLangs).size > 1 ? {multiAudio:true, availableAudioLangs:hintedLangs} : {}),
        // The movie CDN has served 1080p and 720p bytes under 720p and 480p labels.
        // Keep adaptive playback, but do not advertise untrustworthy manual heights.
        ...(host === 'img.rousav.tech' ? { qualityLabelsUnreliable: true } : {}),
        headers: { Referer: `${origin}/`, Origin: origin, 'User-Agent': BROWSER_UA } });
    }
    return out;
  } catch {
    return [];
  }
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
  const wrapRelay = (target: string, _manifest = false) => target;

  try {
    const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3800)]) : AbortSignal.timeout(3800);
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
      let standbyUrl: string | undefined;
      let standbyHeaders: Record<string, string> | undefined;

      if (streamType === 'mp4' && /^https?:\/\//i.test(s.url)) {
        // Direct progressive MP4 dub (e.g. mb.vidrift.net/.../video.mp4)
        finalUrl = s.url;
        headers = { Referer: `${cfg.riftOrigin}/`, 'User-Agent': BROWSER_UA };
      } else {
        const absTarget = /^https?:\/\//i.test(s.url)
          ? s.url
          : `${cfg.riftOrigin}/api/orion/${hash}/master.m3u8`;
        const relayedTarget = wrapRelay(absTarget, streamType === 'hls');
        const directOrionHeaders: Record<string, string> = {
          Referer: `${cfg.riftOrigin}/`,
          Origin: cfg.riftOrigin,
          'User-Agent': BROWSER_UA,
          ...(riftPlaybackToken ? { 'X-Playback-Token': riftPlaybackToken } : {}),
        };
        if (riftPlaybackToken && isSafeUpstreamUrl(absTarget)) {
          // Prefer direct Orion HLS when boot provided a live playbackToken (avoids paused external relays)
          finalUrl = absTarget;
          headers = directOrionHeaders;
          if (relayedTarget !== absTarget && isSafeUpstreamUrl(relayedTarget)) {
            standbyUrl = relayedTarget;
            standbyHeaders = { 'User-Agent': BROWSER_UA };
          }
        } else {
          finalUrl = relayedTarget;
          if (absTarget !== finalUrl && isSafeUpstreamUrl(absTarget)) {
            standbyUrl = absTarget;
            standbyHeaders = directOrionHeaders;
          }
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
        ...(standbyUrl ? { standbyUrl, standbyHeaders } : {}),
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
    const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(4800)]) : AbortSignal.timeout(4800);
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

async function fetchFromVidLink(
  cfg: BackendConfig['source1'],
  query: SourceQuery,
): Promise<RawStreamCandidate[]> {
  const linkOrigin = cfg.vidlinkOrigin;
  const encOrigin = cfg.encDecOrigin;
  if (!linkOrigin || !encOrigin || isSubOriginCoolingDown(linkOrigin) || isSubOriginCoolingDown(encOrigin)) {
    return [];
  }

  try {
    const encSig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
    const encRes = await fetch(
      `${encOrigin}/api/enc-vidlink?text=${encodeURIComponent(query.tmdbId)}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
        signal: encSig,
      },
    );
    if (!encRes.ok) {
      if (encRes.status >= 500) tripSubOriginCooldown(encOrigin);
      return [];
    }
    const encJson = (await encRes.json()) as { result?: string };
    const encId = typeof encJson?.result === 'string' ? encJson.result.trim() : '';
    if (!encId) return [];

    const apiPath =
      query.type === 'movie'
        ? `/api/b/movie/${encodeURIComponent(encId)}?multiLang=0`
        : `/api/b/tv/${encodeURIComponent(encId)}/${query.season ?? 1}/${query.episode ?? 1}?multiLang=0`;

    const apiSig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(4800)]) : AbortSignal.timeout(4800);
    const res = await fetch(`${linkOrigin}${apiPath}`, {
        headers: {
          Accept: 'application/json',
          Referer: `${linkOrigin}/`,
          Origin: linkOrigin,
          'User-Agent': BROWSER_UA,
          // Request the browser DASH delivery lane. Without this, VidLink
          // returns requiresProxy MP4s that rate-limit non-browser relays.
          'X-Playback-Environment': 'webkit',
        },
        signal: apiSig,
    });
    if (!res.ok) {
      if (res.status >= 500) tripSubOriginCooldown(linkOrigin);
      return [];
    }

    const data = (await res.json()) as {
      stream?: {
        type?: 'hls' | 'file' | 'dash';
        playlist?: string;
        playlistHeaders?: Record<string, string>;
        headers?: Record<string, string>;
        qualities?: Record<string, { type?: string; url?: string; requiresProxy?: boolean }>;
        captions?: { url?: string; language?: string; label?: string }[];
      };
    };
    const stream = data?.stream;
    if (!stream) return [];

    const mediaHeaders: Record<string, string> = {
      Referer: `${linkOrigin}/`,
      Origin: linkOrigin,
      'User-Agent': BROWSER_UA,
      // DASH delivery uses CloudFront signed cookies. Preserve them on the
      // manifest and every rewritten child segment, exactly as provided.
      ...(stream.playlistHeaders ?? {}),
      ...(stream.headers ?? {}),
    };

    const subs = mapSubtitles(
      (stream.captions ?? []).map((c) => ({
        url: c.url,
        lang: c.language || c.label,
        label: c.label || c.language,
      })),
      mediaHeaders,
    );

    const out: RawStreamCandidate[] = [];
    if (typeof stream.playlist === 'string' && isSafeUpstreamUrl(stream.playlist)) {
      const playlistType = inferStreamType(stream.type, stream.playlist);
      out.push({
        key: `vlink:${playlistType}:${stream.playlist}`,
        type: playlistType,
        url: stream.playlist,
        headers: mediaHeaders,
        quality: 'auto',
        multiAudio: false,
        subtitles: subs,
        rank: 12,
      });
    }

    if (stream.qualities && typeof stream.qualities === 'object') {
      const rungs = Object.entries(stream.qualities)
        .map(([qKey, qObj]) => ({
          height: parseInt(qKey.replace(/\D+/g, ''), 10) || 0,
          url: String(qObj?.url ?? '').trim(),
          type: qObj?.type,
          requiresProxy: qObj?.requiresProxy === true,
        }))
        .filter((r) => r.url && !r.requiresProxy && isSafeUpstreamUrl(r.url))
        .sort((a, b) => b.height - a.height);

      if (rungs.length > 0) {
        const best = rungs[0];
        const fallbackRung = rungs[1];
        out.push({
          key: `vlink:mp4:${best.url}`,
          type: inferStreamType(best.type || 'mp4', best.url),
          url: best.url,
          headers: mediaHeaders,
          quality: best.height ? `${best.height}p` : 'auto',
          multiAudio: false,
          subtitles: subs,
          ...(fallbackRung ? { standbyUrl: fallbackRung.url, standbyHeaders: mediaHeaders } : {}),
          rank: 18,
        });
      }
    }

    return out;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Source 1 Adapter Factory                                            */
/* ------------------------------------------------------------------ */

export function createSource1Adapter(cfg: BackendConfig['source1'], group: 1 | 2 = 1): SourceAdapter {
  const id = `source-${group}`;
  return {
    id,
    label: `Source ${group}`,
    enabled: () => cfg.enabled,

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      const t0 = performance.now();
      const timed = <T>(p: Promise<T>): Promise<{ val: T; ms: number }> =>
        p.then((val) => ({ val, ms: Math.max(1, Math.round(performance.now() - t0)) }));

      const slots: {
        rift: { val: RawStreamCandidate[]; ms: number } | null;
        sync: { val: RawStreamCandidate[]; ms: number } | null;
        rock: { val: RawStreamCandidate[]; ms: number } | null;
        link: { val: RawStreamCandidate[]; ms: number } | null;
      } = {
        rift: null,
        sync: null,
        rock: null,
        link: null,
      };

      const totalPipelines = 4;
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
      const pSync = timed(group === 2 ? fetchFromVidBolt(cfg.vidboltOrigin || 'https://vidbolt.xyz', query) : Promise.resolve([] as RawStreamCandidate[])).then((r) => {
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
      const pLink = timed(group === 1 ? fetchFromVidLink(cfg, query) : Promise.resolve([])).then((r) => {
        slots.link = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const allLanes = Promise.allSettled([pRift, pSync, pRock, pLink]);
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

      const riftCandidates = slots.rift ? withTiming(slots.rift.val, slots.rift.ms) : [];
      const syncCandidates = slots.sync ? withTiming(slots.sync.val, slots.sync.ms) : [];
      const rockCandidates = slots.rock ? withTiming(slots.rock.val, slots.rock.ms) : [];
      const linkCandidates = slots.link ? withTiming(slots.link.val, slots.link.ms) : [];

      const byUrl = new Map<string, RawStreamCandidate>();
      for (const c of [
        ...syncCandidates,
        ...rockCandidates,
        ...linkCandidates,
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
        if (group === 1) {
          lane('F', slots.link, linkCandidates.length);
        } else {
          lane('C', slots.rift, riftCandidates.length);
          lane('D', slots.sync, syncCandidates.length);
          lane('E', slots.rock, rockCandidates.length);
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
