/**
 * Elfura Backend — Source 3 Adapter (VidSync Pro)
 * =================================================
 * Public, separately selectable source backed by VidSync Pro's native
 * `/api/stream` and `/api/core/streams` JSON APIs. The adapter maps only
 * direct HLS/DASH/MP4 candidates into Elfura's uniform relay pipeline;
 * embed/player URLs are never advertised as playable streams.
 */

import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type {
  RawSourceResult,
  RawStreamCandidate,
  SourceAdapter,
  SourceQuery,
} from './types.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function pickBestQualityLabel(primary?: string, list?: string[]): string {
  const candidates = [primary, ...(Array.isArray(list) ? list : [])].filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  let bestHeight = 0;
  for (const q of candidates) {
    if (/4k|2160/i.test(q)) bestHeight = Math.max(bestHeight, 2160);
    else {
      const m = q.match(/(\d{3,4})p/i);
      if (m) bestHeight = Math.max(bestHeight, Number(m[1]));
    }
  }
  if (bestHeight >= 2160) return '2160p';
  if (bestHeight > 0) return `${bestHeight}p`;
  return (primary || 'auto').toLowerCase();
}

function inferStreamType(rawType?: string, url = ''): 'hls' | 'dash' | 'mp4' {
  const t = (rawType || '').toLowerCase();
  if (t === 'dash' || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (t === 'mp4' || t === 'mkv' || t === 'webm' || /\.(?:mp4|webm|mkv)(?:[?#]|$)/i.test(url)) return 'mp4';
  return 'hls';
}

export async function fetchFromVidSyncPro(
  origin: string,
  query: SourceQuery,
  endpoints: { core?: boolean; stream?: boolean } = { core: true, stream: true },
): Promise<RawStreamCandidate[]> {
  const prefAudio = query.preferredLang
    ? normalizeLang(query.preferredLang)
    : null;
  const audioQs =
    prefAudio && prefAudio.code !== 'und'
      ? `&audio=${encodeURIComponent(prefAudio.label.toLowerCase())}&dubLang=${encodeURIComponent(prefAudio.label.toLowerCase())}`
      : '';
  const qs =
    query.type === 'movie'
      ? `type=movie&id=${encodeURIComponent(query.tmdbId)}&season=1&episode=1`
      : `type=tv&id=${encodeURIComponent(query.tmdbId)}&season=${query.season ?? 1}&episode=${query.episode ?? 1}`;
  const streamQs = `${qs}&stage=primary${audioQs}`;

  const grab = async (endpoint: string) => {
    try {
      const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(6500)]) : AbortSignal.timeout(6500);
      const res = await fetch(endpoint, {
        headers: {
          Accept: 'application/json',
          Referer: `${origin}/`,
          'User-Agent': BROWSER_UA,
        },
        signal: sig,
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  interface SyncSourceRow {
    id?: string;
    provider?: { id?: string; name?: string };
    url?: string;
    directUrl?: string;
    rawUrl?: string;
    type?: string;
    quality?: string;
    availableQualities?: string[];
    audioLanguage?: string;
    language?: string;
    audioLabel?: string;
    audioTracks?: { language?: string; label?: string }[];
    subtitles?: { label?: string; lang?: string; url?: string }[];
    headers?: Record<string, string>;
    standbyUrl?: string;
    standbyHeaders?: Record<string, string>;
    permanent_m3u8_url?: string;
  }

  interface SyncResponse {
    sources?: SyncSourceRow[];
    subtitles?: { label?: string; lang?: string; url?: string }[];
  }

  const [coreJson, streamJson] = (await Promise.all([
    endpoints.core === false ? Promise.resolve(null) : grab(`${origin}/api/core/streams?${qs}`),
    endpoints.stream === false ? Promise.resolve(null) : grab(`${origin}/api/stream?${streamQs}`),
  ])) as [SyncResponse | null, SyncResponse | null];

  const rows: SyncSourceRow[] = [...(coreJson?.sources ?? []), ...(streamJson?.sources ?? [])];

  // Detect if multiple distinct audio languages share an identical directUrl
  // (e.g. Castle returning the English rawUrl on Hindi/Japanese rows while
  // row.url `/api/core/proxy?...&defaultAudio=hi` serves the real dub).
  const langsByDirectUrl = new Map<string, Set<string>>();
  for (const r of rows) {
    const rawUrl = r?.directUrl || r?.rawUrl || r?.url;
    const dUrl = typeof rawUrl === 'string' && rawUrl.startsWith('/') ? `${origin}${rawUrl}` : rawUrl;
    if (!dUrl) continue;
    const lang = normalizeLang(r.audioLanguage || r.language || 'und', r.audioLabel).code;
    if (!langsByDirectUrl.has(dUrl)) langsByDirectUrl.set(dUrl, new Set());
    langsByDirectUrl.get(dUrl)!.add(lang);
  }

  rows.sort((a, b) => {
    const aCastle = a?.provider?.id === 'castle' ? 0 : 1;
    const bCastle = b?.provider?.id === 'castle' ? 0 : 1;
    if (aCastle !== bCastle) return aCastle - bCastle;
    // Prefer Auto or 1080p rows first when collapsing duplicate quality rows
    const scoreQ = (q?: string) => (/1080/i.test(q || '') ? 0 : /auto/i.test(q || '') ? 1 : /720/i.test(q || '') ? 2 : 3);
    return scoreQ(a?.quality) - scoreQ(b?.quality);
  });

  const seenGroup = new Set<string>();
  const seenPrimaryUrl = new Set<string>();
  const out: RawStreamCandidate[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const directCandidate = row?.directUrl || row?.rawUrl || '';
    const proxyCandidate =
      typeof row?.url === 'string' && row.url.startsWith('/')
        ? `${origin}${row.url}`
        : typeof row?.url === 'string' && /^https?:\/\//i.test(row.url)
          ? row.url
          : '';

    const norm = normalizeLang(row.audioLanguage || row.language || 'und', row.audioLabel);
    const providerKey = (row.provider?.id || 'sync').toLowerCase();

    // Collapse Castle's 5 quality clones (`1080p`, `720p`, `480p`, `360p`, `Auto`) per language
    const groupKey = `${providerKey}:${norm.code}:${(directCandidate || proxyCandidate).split('?')[0]}`;
    if (seenGroup.has(groupKey)) continue;
    seenGroup.add(groupKey);

    const sharedDirectAcrossLangs =
      (langsByDirectUrl.get(directCandidate || proxyCandidate)?.size ?? 0) > 1;

    // Always prefer vidsync's `/api/core/proxy` whenever provided (prevents 403 rejections
    // on IP-signed `hscow.com` / `fcxmb.com` / `fastcloud.live` URLs and preserves multi-dub routing).
    // An absolute row.url may be a direct CDN URL, not a VidSync proxy.
    // Preserve its upstream media headers instead of replacing its Referer.
    const preferProxy = (() => {
      if (!proxyCandidate) return false;
      try {
        const u = new URL(proxyCandidate);
        return u.origin === new URL(origin).origin && /^\/api\//.test(u.pathname);
      } catch {
        return false;
      }
    })();
    const primaryUrl = preferProxy ? proxyCandidate : directCandidate || proxyCandidate;
    if (!primaryUrl || !isSafeUpstreamUrl(primaryUrl) || seenPrimaryUrl.has(primaryUrl)) continue;
    seenPrimaryUrl.add(primaryUrl);

    const primaryHeaders: Record<string, string> = preferProxy
      ? { Referer: `${origin}/`, 'User-Agent': BROWSER_UA }
      : { 'User-Agent': BROWSER_UA, ...(row.headers ?? {}) };

    let standbyUrl: string | undefined;
    let standbyHeaders: Record<string, string> | undefined;
    if (preferProxy) {
      // Keep the direct CDN lane as a real failover even when its signature
      // looks IP-bound. Server liveness will prune it if this host cannot use
      // it; dropping it here strands working titles when the proxy rewrites
      // malformed child URIs or starts rejecting segment requests.
      if (directCandidate && !sharedDirectAcrossLangs && isSafeUpstreamUrl(directCandidate)) {
        standbyUrl = directCandidate;
        standbyHeaders = { 'User-Agent': BROWSER_UA, ...(row.headers ?? {}) };
      }

    }
    // Do not trust provider standby/permanent URLs as same-language backups:
    // in practice they can point to another dub entirely.

    out.push({
      key: primaryUrl,
      type: inferStreamType(row.type, primaryUrl),
      url: primaryUrl,
      headers: primaryHeaders,
      // availableQualities describes the provider's catalogue, not this
      // particular playlist. Do not claim its highest quality for every row.
      quality: pickBestQualityLabel(row.quality),
      // An unambiguous row label is a single-track hint, not evidence of
      // switchable audio or proof of spoken language. If the same direct URL
      // is labelled as multiple languages, do not assign any label to it.
      ...(!sharedDirectAcrossLangs && norm.code !== 'und' ? {audioLang:norm.code, audioLabel:norm.label} : {}),
      // These are catalogue-wide language labels, not playable audio tracks:
      // each row represents a separate dub. Manifest liveness may promote a
      // candidate to multi-audio when it actually contains multiple tracks.
      multiAudio: false,
      ...(standbyUrl ? { standbyUrl, standbyHeaders } : {}),
      rank: 2 + i,
    });
  }

  return out;
}

export function createSource3Adapter(cfg: BackendConfig['source3']): SourceAdapter {
  const origin = (cfg?.origin || 'https://vidsync.pro').replace(/\/+$/, '');
  return {
    id: 'source-3',
    label: 'Source 3',
    enabled: () => !!cfg?.enabled && !!origin,
    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      let sync: RawStreamCandidate[] = [];
            let settled = 0;
      let release: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const measure = async (lane: string, promise: Promise<RawStreamCandidate[]>) => {
        const startedAt = Date.now();
        const result = await promise;
        sync = result;
        settled++;
        query.diag?.push({adapter:'source-3', lane, ok:result.length > 0, ms:Date.now()-startedAt, detail:`candidates=${result.length}`});
        if (result.length && !timer && !query.diag) timer = setTimeout(() => release?.(), 700);
      };
      const allLanes = Promise.allSettled([
        measure('stream', fetchFromVidSyncPro(origin, query)),
      ]);
      if (query.diag) await allLanes;
      else await Promise.race([allLanes, new Promise<void>((resolve) => { release = resolve; })]);
      if (timer) clearTimeout(timer);
      const result = () => ({ candidates: [...sync] });
      if (!query.diag && settled < 1 && query.onLateResult) void allLanes.then(() => query.onLateResult?.(result()));
      return result();
    },
  };
}
