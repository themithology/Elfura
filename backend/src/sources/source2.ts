/**
 * Elfura Backend — Source 2 Adapter
 * =================================
 * Multi-CDN 30-server stream & multi-audio resolver verified across Hollywood
 * blockbusters, K-dramas, TV anime, and theatrical anime films:
 *   - Enriches `/api/extract` with TMDB `title`, `year`, `date`, `latestDate`,
 *     and `imdbId` (matching upstream client queries so sniper/zxc/vidbolt
 *     providers unlock every regional & anime dub on the first pass).
 *   - Automatically recovers from cold-cache `success: false` responses by
 *     triggering `/api/scan` warm-up and retrying fast alternate provider
 *     families (`atlas`, `alatreon`) without caching empty results.
 *   - Unwraps `/api/proxy-m3u8` and `/api/proxy-segment` wrappers directly to
 *     the underlying CDNs while preserving outer worker query signatures on
 *     `dash-hls-bridge` URLs and injecting required `Referer` + `Origin`
 *     headers server-side on `vidbolt` / `rousav` streams.
 *   - Harvests all 30+ online server nodes sorted by measured upstream edge
 *     latency (`latencyMs` ascending) PLUS every distinct audio dub / quality
 *     variant across all buckets with true minimum group latency.
 */

import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type {
  RawSourceResult,
  RawStreamCandidate,
  RawTrackRef,
  SourceAdapter,
  SourceQuery,
} from './types.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const DEFAULT_STREAM_REFERER = 'https://vidbolt.xyz/';

const PREFERRED_SERVER_ORDER = [
  'rousav',
  'quantum',
  'orion',
  'vidfast',
  'ursa',
  'atlas',
  'indus',
  'centaurus',
  'andromeda',
  'daedalus',
  'vaplayer',
  'bolly',
  'valstrax',
  'kuro',
  'zxc_ursa',
  'alatreon',
  'zenith',
  'callisto',
  'zxc_orion',
  'kronos',
  'zxc_atlas',
  'hyperion',
  'nova',
  'apollo',
  'vega',
  'bharat',
  'resshin',
  'quasar',
  'nebula',
  'pegasus',
];

const HARDSUB_LABEL_RE = /\bsub(?:bed|s)?$/i;
const HEVC_PATH_RE = /(?:^|[_/.-])(?:h265|hevc|x265)(?:[_/.-]|$)/i;
const WORKER_BRIDGE_HOST_RE = /(?:workers\.dev|hakunaymatata\.com)$/i;
const VIDBOLT_ECOSYSTEM_RE = /(?:vidbolt|rousav)/i;

interface ExtractSourceItem {
  url?: string;
  type?: string;
  resolution?: number | string;
  resolutions?: (number | string)[];
  quality?: string;
  label?: string;
  language?: string;
  audioLanguages?: string[];
  headers?: Record<string, string>;
  originServer?: string;
}

interface ExtractDubItem {
  lanCode?: string;
  lanName?: string;
  original?: boolean;
  dubType?: string | number;
}

interface ExtractSubtitleItem {
  url?: string;
  file?: string;
  src?: string;
  lang?: string;
  language?: string;
  srclang?: string;
  label?: string;
  display?: string;
}

interface ExtractServerBucket {
  sources?: ExtractSourceItem[];
  dubs?: ExtractDubItem[];
  subtitles?: ExtractSubtitleItem[];
  latencyMs?: number;
}

interface ExtractScanReportItem {
  id?: string;
  serverId?: string;
  available?: boolean;
  status?: string;
  latencyMs?: number;
}

interface ExtractApiResponse {
  success?: boolean;
  sources?: ExtractSourceItem[];
  byServer?: Record<string, ExtractServerBucket>;
  scanReport?: ExtractScanReportItem[] | { servers?: ExtractScanReportItem[] };
  dubs?: ExtractDubItem[];
  subtitles?: ExtractSubtitleItem[];
}

interface ExtractMetaHint {
  title?: string;
  year?: string;
  releaseDate?: string;
  latestDate?: string;
  imdbId?: string | null;
}

function unwrapUpstreamUrl(
  rawUrl: string,
  embedOrigin: string,
  explicitHeaders?: Record<string, string>,
): { url: string; headers: Record<string, string> } | null {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return null;

  let resolvedOuter: URL;
  try {
    resolvedOuter = new URL(trimmed, embedOrigin);
  } catch {
    return null;
  }

  let targetUrl = resolvedOuter.toString();
  let unwrappedProxy = false;
  let proxyRefParam = '';

  // Only unwrap `/api/proxy-m3u8` and `/api/proxy-segment`; NEVER unwrap external
  // worker bridges like `dash-hls-bridge.*.workers.dev/?url=...&Policy=...`
  // whose CloudFront Policy/Signature/Key-Pair-Id live on the outer query string.
  if (
    resolvedOuter.pathname === '/api/proxy-m3u8' ||
    resolvedOuter.pathname === '/api/proxy-segment'
  ) {
    const inner = resolvedOuter.searchParams.get('url')?.trim();
    if (!inner) return null;
    targetUrl = inner;
    unwrappedProxy = true;
    proxyRefParam = resolvedOuter.searchParams.get('ref')?.trim() || '';
  }

  if (!isSafeUpstreamUrl(targetUrl)) return null;

  let targetParsed: URL | null = null;
  try {
    targetParsed = new URL(targetUrl);
  } catch {
    /* ignore */
  }

  const isWorkerBridge = targetParsed ? WORKER_BRIDGE_HOST_RE.test(targetParsed.hostname) : false;
  const isVidboltOrRousav = targetParsed
    ? VIDBOLT_ECOSYSTEM_RE.test(targetParsed.hostname) ||
      (targetParsed.pathname.startsWith('/m/') && targetParsed.searchParams.get('f') === '.m3u8')
    : false;

  const referer =
    explicitHeaders?.Referer ||
    explicitHeaders?.referer ||
    proxyRefParam ||
    (unwrappedProxy || isVidboltOrRousav
      ? DEFAULT_STREAM_REFERER
      : isWorkerBridge
        ? ''
        : DEFAULT_STREAM_REFERER);

  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    ...(explicitHeaders ?? {}),
  };
  if (referer && !headers.Referer && !headers.referer) {
    headers.Referer = referer;
  }
  const activeRef = headers.Referer || headers.referer;
  if (activeRef && !headers.Origin && !headers.origin) {
    try {
      headers.Origin = new URL(activeRef).origin;
    } catch {
      /* ignore malformed referer */
    }
  }

  return { url: targetUrl, headers };
}

function inferStreamType(rawType?: string, url = ''): 'hls' | 'dash' | 'mp4' {
  const t = (rawType || '').toLowerCase();
  if (t === 'dash' || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (t === 'mp4' || t === 'mkv' || t === 'webm' || /\.(?:mp4|webm|mkv)(?:[?#]|$)/i.test(url)) return 'mp4';
  return 'hls';
}

function parseQualityHeight(item: ExtractSourceItem): number {
  const nums: number[] = [];
  const pushVal = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      nums.push(v);
      return;
    }
    const s = String(v ?? '');
    if (/4k|2160/i.test(s)) nums.push(2160);
    else {
      const m = s.match(/(\d{3,4})p?/i);
      if (m) nums.push(Number(m[1]));
    }
  };
  pushVal(item.resolution);
  pushVal(item.quality);
  if (Array.isArray(item.resolutions)) {
    for (const r of item.resolutions) pushVal(r);
  }
  return nums.length ? Math.max(...nums) : 0;
}

function canonicalDedupeIdentity(
  targetUrl: string,
  langKey: string,
  qualityLabel: string,
  ladderKey: string,
): { groupKey: string; host: string; allowMirrorStandby: boolean } {
  let u: URL;
  try {
    u = new URL(targetUrl);
  } catch {
    return { groupKey: targetUrl, host: '', allowMirrorStandby: false };
  }

  // 1) Cloudflare worker DASH-HLS bridges wrapping `sacdn.hakunaymatata.com/dash/<dir>/master.m3u8`
  const bridgedInner = u.searchParams.get('url');
  if (bridgedInner) {
    try {
      const innerU = new URL(bridgedInner);
      return {
        groupKey: `bridge:${innerU.origin}${innerU.pathname}:${langKey}`,
        host: u.host.toLowerCase(),
        allowMirrorStandby: true,
      };
    } catch {
      /* fall through */
    }
  }

  // 2) `hls_mps/<hash>/<res>/index_*.m3u8` multi-CDN mirrors (`hscow.com`, `fcxmb.com`, etc.)
  const hlsMpsMatch = u.pathname.match(/^\/hls_mps\/([A-Za-z0-9_-]+)\/(\d+)\//i);
  if (hlsMpsMatch) {
    return {
      groupKey: `hls_mps:${hlsMpsMatch[1]}:${hlsMpsMatch[2]}:${langKey}`,
      host: u.host.toLowerCase(),
      allowMirrorStandby: true,
    };
  }

  // 3) Re-encrypted per-server tokens on `/m/<token>?f=.m3u8` (`proxy.vidbolt.xyz`, etc.)
  if (
    u.pathname.startsWith('/m/') &&
    (u.searchParams.get('f') === '.m3u8' || /vidbolt/i.test(u.hostname))
  ) {
    return {
      groupKey: `vidbolt_m:${u.host.toLowerCase()}:${langKey}:${qualityLabel}:${ladderKey}`,
      host: u.host.toLowerCase(),
      allowMirrorStandby: false,
    };
  }

  // 4) Direct media paths (`img.rousav.tech/media/<id>/index.m3u8`, etc.)
  return {
    groupKey: `direct:${u.origin}${u.pathname}:${langKey}`,
    host: u.host.toLowerCase(),
    allowMirrorStandby: false,
  };
}

function mapSubtitles(
  items: ExtractSubtitleItem[],
  embedOrigin: string,
): RawTrackRef[] {
  const seen = new Set<string>();
  const out: RawTrackRef[] = [];
  for (const s of items) {
    const rawUrl = s?.url || s?.file || s?.src || '';
    if (!rawUrl) continue;
    const unwrapped = unwrapUpstreamUrl(rawUrl, embedOrigin);
    if (!unwrapped) continue;

    const rawLabel = String(s.label || s.display || '').trim();
    const rawLang = String(s.lang || s.language || s.srclang || rawLabel).trim();
    const norm = normalizeLang(rawLang, rawLabel);
    const dedupKey = `${norm.code}:${unwrapped.url}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    out.push({
      lang: norm.code,
      label: norm.label,
      url: unwrapped.url,
      headers: unwrapped.headers,
    });
  }
  return out;
}

function buildSearchParams(
  query: SourceQuery,
  serverId: string,
  meta?: ExtractMetaHint,
): URLSearchParams {
  const params = new URLSearchParams({
    tmdbId: String(query.tmdbId),
    mediaType: query.type,
    server: serverId,
    season: String(query.type === 'tv' ? (query.season ?? 1) : 1),
    episode: String(query.type === 'tv' ? (query.episode ?? 1) : 1),
  });
  if (meta?.title) params.set('title', meta.title);
  if (meta?.year) params.set('year', String(meta.year));
  if (meta?.releaseDate) params.set('date', meta.releaseDate);
  if (meta?.latestDate) params.set('latestDate', meta.latestDate);
  if (meta?.imdbId) params.set('imdbId', meta.imdbId);
  return params;
}

async function fetchExtractPayload(
  cfg: BackendConfig['source2'],
  query: SourceQuery,
  serverId: string,
  metaHint?: ExtractMetaHint,
  timeoutMs = 6000,
): Promise<{ payload: ExtractApiResponse; requestLatencyMs: number } | null> {
  const params = buildSearchParams(query, serverId, metaHint);
  const embedPath =
    query.type === 'movie'
      ? `/embed/movie/${encodeURIComponent(query.tmdbId)}`
      : `/embed/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;

  try {
    const sig = query.signal
      ? AbortSignal.any([query.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    const t0 = performance.now();
    const res = await fetch(`${cfg.embedOrigin}/api/extract?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        Origin: cfg.embedOrigin,
        Referer: `${cfg.embedOrigin}${embedPath}`,
        'User-Agent': BROWSER_UA,
      },
      signal: sig,
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) return null;
    const payload = (await res.json()) as ExtractApiResponse;
    return {
      payload,
      requestLatencyMs: Math.max(1, Math.round(performance.now() - t0)),
    };
  } catch {
    return null;
  }
}

function triggerScanWarmup(
  cfg: BackendConfig['source2'],
  query: SourceQuery,
  metaHint?: ExtractMetaHint,
): void {
  const params = buildSearchParams(query, cfg.defaultServer, metaHint);
  params.delete('server');
  const embedPath =
    query.type === 'movie'
      ? `/embed/movie/${encodeURIComponent(query.tmdbId)}`
      : `/embed/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;
  void fetch(`${cfg.embedOrigin}/api/scan?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      Origin: cfg.embedOrigin,
      Referer: `${cfg.embedOrigin}${embedPath}`,
      'User-Agent': BROWSER_UA,
    },
    signal: query.signal
      ? AbortSignal.any([query.signal, AbortSignal.timeout(3500)])
      : AbortSignal.timeout(3500),
  }).catch(() => undefined);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function hasAnySources(payload: ExtractApiResponse | null | undefined): boolean {
  if (!payload) return false;
  if (Array.isArray(payload.sources) && payload.sources.length > 0) return true;
  if (payload.byServer && typeof payload.byServer === 'object') {
    for (const bucket of Object.values(payload.byServer)) {
      if (Array.isArray(bucket?.sources) && bucket.sources.length > 0) return true;
    }
  }
  return false;
}

function extractLabelAudioHints(rawLabel?: string): string[] {
  const label = String(rawLabel ?? '').trim();
  if (!label || !/multi[- ]?audio/i.test(label)) return [];
  const out: string[] = [];
  for (const match of label.matchAll(/[(\[]([^)\]]+)[)\]]/g)) {
    for (const part of match[1].split(/[,+/|&•·]+/)) {
      const cleaned = part.trim();
      if (cleaned && !/^\d{3,4}p?$/i.test(cleaned)) out.push(cleaned);
    }
  }
  return out;
}

interface ParsedCandidateItem {
  groupKey: string;
  host: string;
  allowMirrorStandby: boolean;
  url: string;
  headers: Record<string, string>;
  type: 'hls' | 'dash' | 'mp4';
  quality: string;
  singleCode?: string;
  singleLabel?: string;
  discoveredCodes: string[];
  isMultiAudio: boolean;
  isHardsub: boolean;
  baseRank: number;
  latencyMs: number;
}

export function createSource2Adapter(cfg: BackendConfig['source2']): SourceAdapter {
  return {
    id: 'source-2',
    label: 'Source 2',
    enabled: () => cfg.enabled,

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      const isLoopbackMock = (() => {
        try {
          const h = new URL(cfg.embedOrigin).hostname.toLowerCase();
          return h === '127.0.0.1' || h === 'localhost' || h === '::1';
        } catch {
          return false;
        }
      })();

      // Give self-hosted TMDB metadata a fast 260ms head-start window (0ms if cached in RAM)
      // so `/api/extract` receives `title`, `year`, `date`, and `imdbId` on the first pass.
      let metaHint: ExtractMetaHint = {
        title: query.title,
        year: query.year,
        releaseDate: query.releaseDate,
        latestDate: query.latestDate,
        imdbId: query.imdbId,
      };
      if (!metaHint.title && query.resolveMetaFallback) {
        const quickMeta = await Promise.race([
          query.resolveMetaFallback().catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 260)),
        ]);
        if (quickMeta) {
          metaHint = {
            title: quickMeta.rawTitle || quickMeta.title || metaHint.title,
            year: quickMeta.year || metaHint.year,
            releaseDate: quickMeta.releaseDate || metaHint.releaseDate,
            latestDate: quickMeta.latestDate || metaHint.latestDate,
            imdbId: quickMeta.imdbId ?? metaHint.imdbId,
          };
        }
      }

      let fetched = await fetchExtractPayload(cfg, query, cfg.defaultServer, metaHint);

      // Cold-cache recovery: upstream returns `success: false, sources: []` on an uncached
      // title while warming its 30 providers, then succeeds ~1-2s later on fast nodes (`atlas` / `alatreon`).
      if (!hasAnySources(fetched?.payload) && !query.signal?.aborted) {
        if (!metaHint.title && query.resolveMetaFallback) {
          const fullMeta = await query.resolveMetaFallback().catch(() => null);
          if (fullMeta) {
            metaHint = {
              title: fullMeta.rawTitle || fullMeta.title || metaHint.title,
              year: fullMeta.year || metaHint.year,
              releaseDate: fullMeta.releaseDate || metaHint.releaseDate,
              latestDate: fullMeta.latestDate || metaHint.latestDate,
              imdbId: fullMeta.imdbId ?? metaHint.imdbId,
            };
          }
        }

        if (!isLoopbackMock) {
          triggerScanWarmup(cfg, query, metaHint);
          const retryServers = [...new Set(['atlas', 'alatreon', cfg.defaultServer])];
          for (let attempt = 0; attempt < retryServers.length && !hasAnySources(fetched?.payload); attempt++) {
            if (query.signal?.aborted) break;
            await abortableDelay(attempt === 0 ? 850 : 950, query.signal);
            if (query.signal?.aborted) break;
            fetched = await fetchExtractPayload(cfg, query, retryServers[attempt], metaHint, 5000);
          }
        } else if (metaHint.title) {
          fetched = await fetchExtractPayload(cfg, query, cfg.defaultServer, metaHint);
        }
      }

      if (!fetched || !hasAnySources(fetched.payload)) {
        return { candidates: [] };
      }

      const { payload, requestLatencyMs } = fetched;

      // Build dynamic dub name & non-standard code -> canonical BCP-47 lookup from response metadata
      const dubCodeByName = new Map<string, string>();
      const dubCodeByRawCode = new Map<string, string>();
      let originalLangCode = query.originalLanguage
        ? normalizeLang(query.originalLanguage).code
        : '';

      const registerDubs = (dubs?: ExtractDubItem[]) => {
        if (!Array.isArray(dubs)) return;
        for (const d of dubs) {
          const code = String(d?.lanCode ?? '').trim();
          const name = String(d?.lanName ?? '').trim();
          if (HARDSUB_LABEL_RE.test(name)) continue;
          const resolved = normalizeLang(name || code, name || code);
          if (resolved.code && resolved.code !== 'und') {
            if (name) dubCodeByName.set(name.toLowerCase(), resolved.code);
            if (code) dubCodeByRawCode.set(code.toLowerCase(), resolved.code);
            if (d?.original && (!originalLangCode || originalLangCode === 'und')) {
              originalLangCode = resolved.code;
            }
          }
        }
      };

      registerDubs(payload.dubs);
      const byServer = payload.byServer && typeof payload.byServer === 'object' ? payload.byServer : {};
      for (const bucket of Object.values(byServer)) {
        registerDubs(bucket?.dubs);
      }

      // Gather subtitles from top-level and all server buckets
      const rawSubs: ExtractSubtitleItem[] = [...(payload.subtitles ?? [])];
      for (const bucket of Object.values(byServer)) {
        if (Array.isArray(bucket?.subtitles)) rawSubs.push(...bucket.subtitles);
      }
      const sharedSubs = mapSubtitles(rawSubs, cfg.embedOrigin);

      // Build server latency map from both array and `{ servers: [...] }` scanReport formats
      const scanLatencyByServer = new Map<string, number>();
      const scanRows: ExtractScanReportItem[] = Array.isArray(payload.scanReport)
        ? payload.scanReport
        : Array.isArray(payload.scanReport?.servers)
          ? payload.scanReport.servers
          : [];
      for (const row of scanRows) {
        const id = String(row?.id || row?.serverId || '').trim();
        const ms = Number(row?.latencyMs);
        if (id && Number.isFinite(ms) && ms > 0) {
          scanLatencyByServer.set(id, Math.round(ms));
        }
      }

      const preferredOrderIndex = (srvId: string): number => {
        const idx = PREFERRED_SERVER_ORDER.indexOf(srvId);
        return idx >= 0 ? idx : PREFERRED_SERVER_ORDER.length + 50;
      };

      const serverEntries = Object.entries(byServer)
        .filter(([, bucket]) => Array.isArray(bucket?.sources) && bucket.sources.length > 0)
        .map(([srvId, bucket], idx) => {
          const bucketMs = Number(bucket?.latencyMs);
          const scanMs = scanLatencyByServer.get(srvId);
          const latencyMs =
            Number.isFinite(bucketMs) && bucketMs > 0
              ? Math.round(bucketMs)
              : scanMs !== undefined
                ? scanMs
                : requestLatencyMs;
          const hasExplicitLatency =
            (Number.isFinite(bucketMs) && bucketMs > 0) || scanMs !== undefined;
          return {
            srvId,
            bucket,
            latencyMs,
            sortLatency: hasExplicitLatency ? latencyMs : 600 + preferredOrderIndex(srvId),
            prefIdx: preferredOrderIndex(srvId),
            origIdx: idx,
          };
        })
        .sort(
          (a, b) =>
            a.sortLatency - b.sortLatency ||
            a.prefIdx - b.prefIdx ||
            a.origIdx - b.origIdx,
        );

      const resolveTokenLang = (rawToken: string): { code: string; label: string } => {
        const trimmed = rawToken.trim();
        if (!trimmed) return { code: 'und', label: 'Original' };
        if (/\([^)]+\)/.test(trimmed)) {
          return normalizeLang(trimmed, trimmed);
        }
        const lower = trimmed.toLowerCase();
        const hintedCode = dubCodeByName.get(lower) || dubCodeByRawCode.get(lower);
        return normalizeLang(hintedCode || trimmed, trimmed);
      };

      const parseItem = (
        item: ExtractSourceItem,
        latencyMs: number,
        bucketDubs?: ExtractDubItem[],
      ): ParsedCandidateItem | null => {
        if (!item?.url) return null;
        const unwrapped = unwrapUpstreamUrl(item.url, cfg.embedOrigin, item.headers);
        if (!unwrapped) return null;

        const rawPrimaryLang = String(item.language ?? '').trim();
        const rawLabel = String(item.label ?? '').trim();
        const isHardsub =
          HARDSUB_LABEL_RE.test(rawPrimaryLang) ||
          HARDSUB_LABEL_RE.test(rawLabel) ||
          (Array.isArray(item.audioLanguages) &&
            item.audioLanguages.length === 1 &&
            HARDSUB_LABEL_RE.test(String(item.audioLanguages[0] ?? '')));

        const discoveredCodes: string[] = [];
        const addAudioToken = (tok?: string) => {
          if (!tok || HARDSUB_LABEL_RE.test(tok)) return;
          const norm = resolveTokenLang(tok);
          if (norm.code && norm.code !== 'und' && !discoveredCodes.includes(norm.code)) {
            discoveredCodes.push(norm.code);
          }
        };

        if (!isHardsub) {
          if (Array.isArray(item.audioLanguages)) {
            for (const rawAudio of item.audioLanguages) addAudioToken(rawAudio);
          }
          for (const hinted of extractLabelAudioHints(rawLabel)) {
            addAudioToken(hinted);
          }
        }

        const isMultiAudio =
          !isHardsub &&
          (discoveredCodes.length > 1 || /multi[- ]?audio/i.test(rawLabel));

        if (isMultiAudio && discoveredCodes.length <= 1 && Array.isArray(bucketDubs)) {
          for (const bd of bucketDubs) {
            if (bd?.lanName && !HARDSUB_LABEL_RE.test(bd.lanName)) {
              addAudioToken(bd.lanName);
            } else if (bd?.lanCode) {
              addAudioToken(bd.lanCode);
            }
          }
        }

        let singleCode: string | undefined;
        let singleLabel: string | undefined;
        if (!isHardsub && !isMultiAudio) {
          if (rawPrimaryLang) {
            const n = resolveTokenLang(rawPrimaryLang);
            singleCode = n.code;
            singleLabel = n.label;
          } else if (discoveredCodes.length === 1) {
            const n = normalizeLang(discoveredCodes[0], discoveredCodes[0]);
            singleCode = n.code;
            singleLabel = n.label;
          }
        }

        const height = parseQualityHeight(item);
        const quality = height >= 2160 ? '2160p' : height > 0 ? `${height}p` : 'auto';
        const ladderNums = Array.isArray(item.resolutions)
          ? [...new Set(item.resolutions.map((r) => Number(r)).filter((n) => Number.isFinite(n) && n > 0))].sort(
              (a, b) => b - a,
            )
          : [];
        const ladderKey = ladderNums.join(',') || quality;
        const langKey = isHardsub
          ? `hardsub:${(rawPrimaryLang || rawLabel).toLowerCase()}`
          : isMultiAudio
            ? `mul:${discoveredCodes.join(',')}`
            : singleCode || 'und';

        const ident = canonicalDedupeIdentity(unwrapped.url, langKey, quality, ladderKey);

        const innerCheck = (() => {
          try {
            return new URL(unwrapped.url).searchParams.get('url') || unwrapped.url;
          } catch {
            return unwrapped.url;
          }
        })();
        const isHevc = HEVC_PATH_RE.test(unwrapped.url) || HEVC_PATH_RE.test(innerCheck);
        const hasAbrLadder = ladderNums.length > 1;
        const qualityPenalty = height >= 1080 ? 0 : height >= 720 ? 3 : height >= 480 ? 6 : 9;
        const origBonus =
          !isMultiAudio && singleCode && (singleCode === originalLangCode || singleCode === 'en') ? 0 : 2;

        let baseRank: number;
        if (isHardsub) {
          baseRank = 90 + qualityPenalty;
        } else if (isMultiAudio) {
          baseRank = 1 + qualityPenalty;
        } else if (!isHevc) {
          baseRank = 10 + (hasAbrLadder ? 0 : 2) + qualityPenalty + origBonus;
        } else {
          baseRank = 35 + qualityPenalty + origBonus;
        }

        return {
          groupKey: ident.groupKey,
          host: ident.host,
          allowMirrorStandby: ident.allowMirrorStandby,
          url: unwrapped.url,
          headers: unwrapped.headers,
          type: inferStreamType(item.type, unwrapped.url),
          quality,
          singleCode,
          singleLabel,
          discoveredCodes,
          isMultiAudio,
          isHardsub,
          baseRank,
          latencyMs,
        };
      };

      const parsedByServer = serverEntries.map((entry) => ({
        ...entry,
        items: (entry.bucket.sources ?? [])
          .map((item) => parseItem(item, entry.latencyMs, entry.bucket.dubs))
          .filter((x): x is ParsedCandidateItem => x !== null),
      }));
      const fastestOverallLatency =
        serverEntries.length > 0 ? serverEntries[0].latencyMs : requestLatencyMs;
      const parsedTopLevel = (payload.sources ?? [])
        .map((item) => {
          const originSrv = item?.originServer ? scanLatencyByServer.get(item.originServer) : undefined;
          return parseItem(item, originSrv ?? fastestOverallLatency, payload.dubs);
        })
        .filter((x): x is ParsedCandidateItem => x !== null);

      // Track the fastest server latency & cross-host mirror standby per canonical groupKey
      const minLatencyByGroup = new Map<string, number>();
      const primaryHostByGroup = new Map<string, { host: string; url: string }>();
      const standbyByGroup = new Map<string, { url: string; headers: Record<string, string> }>();
      for (const p of [...parsedByServer.flatMap((s) => s.items), ...parsedTopLevel]) {
        const prevMin = minLatencyByGroup.get(p.groupKey);
        if (prevMin === undefined || p.latencyMs < prevMin) {
          minLatencyByGroup.set(p.groupKey, p.latencyMs);
        }
        const first = primaryHostByGroup.get(p.groupKey);
        if (!first) {
          primaryHostByGroup.set(p.groupKey, { host: p.host, url: p.url });
        } else if (
          p.allowMirrorStandby &&
          !standbyByGroup.has(p.groupKey) &&
          p.host &&
          p.host !== first.host &&
          p.url !== first.url
        ) {
          standbyByGroup.set(p.groupKey, { url: p.url, headers: p.headers });
        }
      }

      const prefCode = query.preferredLang ? normalizeLang(query.preferredLang).code : '';
      const prefPrimary = prefCode && prefCode !== 'und' ? prefCode.split('-')[0] : '';

      const langMatchScore = (
        singleCode: string | undefined,
        codes: string[] | undefined,
        isMulti: boolean,
      ): number => {
        if (!prefPrimary) return 0;
        if (singleCode === prefCode || codes?.includes(prefCode)) return 0;
        if (
          singleCode?.split('-')[0] === prefPrimary ||
          codes?.some((l) => l.split('-')[0] === prefPrimary)
        ) {
          return 1;
        }
        if (isMulti && !codes?.length) return 2;
        return 3;
      };

      const toCandidate = (
        p: ParsedCandidateItem,
        key: string,
        tieOffset: number,
        useGroupMinLatency = false,
      ): RawStreamCandidate => {
        const standby =
          p.allowMirrorStandby && standbyByGroup.get(p.groupKey)?.url !== p.url
            ? standbyByGroup.get(p.groupKey)
            : undefined;
        const effectiveLatency = useGroupMinLatency
          ? (minLatencyByGroup.get(p.groupKey) ?? p.latencyMs)
          : p.latencyMs;
        const latencyPenalty = Math.min(effectiveLatency, 5000) / 1000;
        return {
          key,
          fingerprint: p.groupKey,
          latencyMs: effectiveLatency,
          type: p.type,
          url: p.url,
          headers: p.headers,
          quality: p.quality,
          ...(p.singleCode ? { audioLang: p.singleCode } : {}),
          ...(p.singleLabel ? { audioLabel: p.singleLabel } : {}),
          ...(p.discoveredCodes.length ? { availableAudioLangs: p.discoveredCodes } : {}),
          multiAudio: p.isMultiAudio,
          subtitles: sharedSubs,
          ...(standby ? { standbyUrl: standby.url, standbyHeaders: standby.headers } : {}),
          rank: p.baseRank + latencyPenalty + tieOffset,
        };
      };

      const emittedCandidates: RawStreamCandidate[] = [];
      const emittedGroups = new Set<string>();

      // Pass 1: Emit the best primary stream from EVERY online server in `byServer` (all 30+ servers!)
      for (let sIdx = 0; sIdx < parsedByServer.length; sIdx++) {
        const srv = parsedByServer[sIdx];
        if (!srv.items.length) continue;

        const bestForServer = [...srv.items].sort((a, b) => {
          const lm =
            langMatchScore(a.singleCode, a.discoveredCodes, a.isMultiAudio) -
            langMatchScore(b.singleCode, b.discoveredCodes, b.isMultiAudio);
          if (lm !== 0) return lm;
          return a.baseRank - b.baseRank;
        })[0];

        emittedGroups.add(bestForServer.groupKey);
        emittedCandidates.push(
          toCandidate(bestForServer, `srv:${srv.srvId}:primary`, sIdx * 0.01, false),
        );
      }

      // Pass 2: Emit every remaining distinct language dub / resolution / stream across all buckets & top-level sources
      // inheriting the fastest server latency among all nodes serving that canonical group.
      const allRemaining = [...parsedByServer.flatMap((s) => s.items), ...parsedTopLevel];
      let extraIdx = 0;
      for (const p of allRemaining) {
        if (emittedGroups.has(p.groupKey)) continue;
        emittedGroups.add(p.groupKey);
        emittedCandidates.push(
          toCandidate(p, `group:${p.groupKey}`, 0.25 + extraIdx++ * 0.01, true),
        );
      }

      const candidates = emittedCandidates.sort((a, b) => {
        if (prefPrimary) {
          const diff =
            langMatchScore(a.audioLang, a.availableAudioLangs, !!a.multiAudio) -
            langMatchScore(b.audioLang, b.availableAudioLangs, !!b.multiAudio);
          if (diff !== 0) return diff;
        } else if (!!a.multiAudio !== !!b.multiAudio) {
          return a.multiAudio ? -1 : 1;
        }
        return a.rank - b.rank;
      });

      return { candidates };
    },
  };
}
