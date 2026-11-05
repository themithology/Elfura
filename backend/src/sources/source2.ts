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

import crypto from 'node:crypto';
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
  /** Nxsha's current subtitle API uses `uri` instead of `url`/`file`. */
  uri?: string;
  lang?: string;
  lan?: string;
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
    const rawUrl = s?.url || s?.file || s?.src || s?.uri || '';
    if (!rawUrl) continue;
    const unwrapped = unwrapUpstreamUrl(rawUrl, embedOrigin);
    if (!unwrapped) continue;

    const rawLabel = String(s.label || s.display || '').trim();
    const rawLang = String(s.lang || s.lan || s.language || s.srclang || rawLabel).trim();
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

/* ------------------------------------------------------------------ */
/* Live Multi-Cluster Helpers (NXStream 30+ Servers + VidStuck)        */
/* ------------------------------------------------------------------ */

const NX_PASS = 'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3';
const VS_PASS = '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c';

const VS_FIELDS = {
  id: 'a7f39c821d604e5b91e57b',
  type: 'c81306d28147a35632e816b',
  path: '6b491e258392e7561a9384c',
  s: 'd8427b5c382f957c3613e85b',
  e: '91c6ea75d1f785c92346b713d',
  ts: '61d9a5274c8e3b2f38291e6',
  token: 'c492f7a183d01e36c538a716d',
  title: '5e28c9147a06de29f3674b392a1',
  year: 'b731e6c94f867f8341c306e',
  date: 'e16493139e5814b3027',
  latest: 'e953416ad739e5814b3027',
  imdb: 'f35a8194265e871c4933a725f',
} as const;

// Current Nxsha scraper IDs, with native multi-language providers first.
// `/api/servers` remains authoritative; this order only chooses which healthy
// providers fit inside the bounded probe set and provides a fallback if discovery fails.
const NX_PRIORITY_SERVERS = [
  'awsind', // AwsPly
  'nitro', // Nitro
  'watchout', // Multi-bill
  'bdxs', // Multi-blue
  'showbox-online', // Xuhd
  'stvv', // Stvvid
  'vidapi',
  'mhbox',
  'rive-citadel', // Citadel
  'castle', // CastVid
  'streamflix', // StremFx
  'xdownloader', // XDrop
  'purstream', // PureWave
  'vixolity', // Vixo
  'rive-primevids', // Prvibd
  'ophim', // Ophm
  'rive-hindicast', // VidHindi
  'rive-flowcast',
  'rive-guru',
  'rive-quasar',
  'hdhub4u',
  'k4khdhub',
  'em-8',
];

const NX_MAX_PROVIDER_PROBES = 8;

/** Known dead/IP-locked worker lanes and non-media pages returned as sources. */
function isDeadNxshaSourceUrl(rawUrl: string): boolean {
  const lower = rawUrl.trim().toLowerCase();
  if (!lower) return true;
  if (
    lower.includes('nxstreamhub.workers.dev') ||
    lower.includes('worker-inosuke.workers.dev') ||
    lower.includes('silent-math-8425.itsnitrox.tech') ||
    lower.includes('wts.itsnitrox.tech/pitro') ||
    lower.includes('wts.itsnitrox.tech/litro') ||
    lower.includes('husvu445bey.com') ||
    lower.includes('kkphimplayer') ||
    lower.includes('gemma416okl.com/play/')
  ) {
    return true;
  }
  return /\/file\/[a-z0-9]+$/i.test(lower) || /\.(?:mkv|html?|js|exe|swf)(?:[?#]|$)/i.test(lower);
}

const NON_LANG_NOISE_RE =
  /^(?:hguider|sply(?:-\d+)?|pitro|litro|nitro|vidapi|mhbox|castle|bdxs|awsind|dub|dubbed|sub|subbed|subs|hd|sd|fhd|uhd|qhd|hdr|hdr10|sdr|dv|hevc|h264|h265|x264|x265|aac|eac3|ddp|atmos|auto|raw|org|ori|original|original\s+audio|audio|main|backup|vip|server\s*\d*|stream\s*\d*|\d{2,4}[pk]?|\d+(?:\.\d+)?\s*(?:gb|mb|kbps|mbps))$/i;

const S2_ORIGIN_COOLDOWN_MS = 5 * 60_000;
const deadS2OriginUntil = new Map<string, number>();

function isLoopbackHost(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

function isS2OriginCoolingDown(origin?: string): boolean {
  if (!origin) return true;
  if (isLoopbackHost(origin)) return false;
  const until = deadS2OriginUntil.get(origin);
  if (!until) return false;
  if (Date.now() < until) return true;
  deadS2OriginUntil.delete(origin);
  return false;
}

function tripS2OriginCooldown(origin?: string): void {
  if (!origin || isLoopbackHost(origin)) return;
  if (deadS2OriginUntil.size >= 64) {
    const oldest = deadS2OriginUntil.keys().next().value;
    if (oldest !== undefined) deadS2OriginUntil.delete(oldest);
  }
  deadS2OriginUntil.set(origin, Date.now() + S2_ORIGIN_COOLDOWN_MS);
}

function evpBytesToKey(pass: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const passBuf = Buffer.from(pass, 'utf8');
  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    const md5 = crypto.createHash('md5');
    if (block.length > 0) md5.update(block);
    md5.update(passBuf);
    md5.update(salt);
    block = md5.digest();
    derived = Buffer.concat([derived, block]);
  }
  return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) };
}

export function openSslEncryptBase64Url(plainUtf8: string, pass: string): string {
  const salt = crypto.randomBytes(8);
  const { key, iv } = evpBytesToKey(pass, salt);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plainUtf8, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'utf8'), salt, ct]).toString('base64url');
}

export function openSslDecrypt(b64OrUrlSafe: string, pass: string): string | null {
  try {
    const norm = b64OrUrlSafe.trim().replace(/-/g, '+').replace(/_/g, '/');
    const pad = norm.length % 4 === 0 ? norm : norm + '='.repeat(4 - (norm.length % 4));
    const raw = Buffer.from(pad, 'base64');
    if (raw.length < 17 || raw.subarray(0, 8).toString('utf8') !== 'Salted__') return null;
    const salt = raw.subarray(8, 16);
    const ct = raw.subarray(16);
    const { key, iv } = evpBytesToKey(pass, salt);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function parseNxItemMeta(
  rawLabel?: string,
  rawQuality?: string,
  hints?: { lang?: string; langName?: string; multiLangs?: string[] },
): {
  quality: string;
  singleCode?: string;
  singleLabel?: string;
  discoveredCodes: string[];
  multiAudio: boolean;
  isHardsub: boolean;
} {
  const label = String(rawLabel ?? '').trim();
  const qualStr = String(rawQuality ?? '').trim();
  const combined = `${label} ${qualStr}`;

  let quality = 'auto';
  if (/\b(?:2160p?|4k|uhd)\b/i.test(combined)) quality = '2160p';
  else if (/\b(?:1080p?|fhd)\b/i.test(combined)) quality = '1080p';
  else if (/\b720p?\b/i.test(combined)) quality = '720p';
  else if (/\b480p?\b/i.test(combined)) quality = '480p';
  else if (/\b360p?\b/i.test(combined)) quality = '360p';

  const isHardsub = HARDSUB_LABEL_RE.test(label);
  const codes: string[] = [];
  const labelsByCode = new Map<string, string>();

  if (!isHardsub && label) {
    // Strip trailing `: 1080,720,480` resolution ladders before splitting tokens
    const stripped = label.replace(/:\s*\d{3,4}(?:\s*,\s*\d{3,4})+\b/g, ' ');
    const tokens = stripped
      .split(/[|:•·,/+()[\]]+/)
      .map((t) => t.replace(/\bdub(?:bed)?\b/gi, '').trim())
      .filter(Boolean);

    for (const tok of tokens) {
      if (NON_LANG_NOISE_RE.test(tok) || HARDSUB_LABEL_RE.test(tok)) continue;
      // Guard against random alphanumeric server IDs like `SPLY-1` or `Server 2`
      if (/\d/.test(tok) && !/^(?:es|pt)[-_\s]?(?:419|la|br)$/i.test(tok)) continue;
      const norm = normalizeLang(tok, tok);
      if (norm.code && norm.code !== 'und') {
        if (!codes.includes(norm.code)) {
          codes.push(norm.code);
          labelsByCode.set(norm.code, norm.label);
        }
      }
    }
  }

  // Newer Nxsha providers expose language metadata separately from the label.
  // Prefer those explicit values instead of trying to infer audio from server names.
  const addExplicitLang = (rawCode: string, rawName = '') => {
    const norm = normalizeLang(rawCode, rawName || rawCode);
    if (!norm.code || norm.code === 'und' || codes.includes(norm.code)) return;
    codes.push(norm.code);
    labelsByCode.set(norm.code, norm.label);
  };
  for (const rawCode of Array.isArray(hints?.multiLangs) ? hints.multiLangs : []) {
    if (typeof rawCode === 'string' && rawCode.trim()) addExplicitLang(rawCode.trim());
  }
  if (hints?.lang?.trim()) addExplicitLang(hints.lang.trim(), hints.langName?.trim() || '');

  const multiAudio = !isHardsub && (codes.length > 1 || /multi[- ]?audio/i.test(label));
  if (!isHardsub && !multiAudio && codes.length === 1) {
    return {
      quality,
      singleCode: codes[0],
      singleLabel: labelsByCode.get(codes[0]),
      discoveredCodes: codes,
      multiAudio: false,
      isHardsub: false,
    };
  }

  return {
    quality,
    discoveredCodes: codes,
    multiAudio,
    isHardsub,
  };
}

interface NxRawSource {
  id?: string;
  provider?: string;
  url?: string;
  org_uri?: string;
  headers?: Record<string, string>;
  quality?: string | number;
  label?: string;
  lang?: string;
  langName?: string;
  multiLangs?: string[];
  isEmbed?: boolean;
  type?: string;
  subtitles?: ExtractSubtitleItem[];
  tracks?: ExtractSubtitleItem[];
}

async function fetchFromNxsha(
  cfg: BackendConfig['source2'],
  query: SourceQuery,
  imdbId?: string | null,
): Promise<RawStreamCandidate[]> {
  const nxOrigin = cfg.nxshaOrigin;
  if (!nxOrigin || isS2OriginCoolingDown(nxOrigin)) return [];

  const nxHeaders: Record<string, string> = {
    Accept: 'application/json',
    Referer: `${nxOrigin}/`,
    Origin: nxOrigin,
    'User-Agent': BROWSER_UA,
  };

  const makeSignedQuery = (extra: Record<string, unknown>): string => {
    const payload = {
      ...extra,
      _req_ts: Date.now(),
      _req_salt: crypto.randomBytes(6).toString('hex'),
    };
    return openSslEncryptBase64Url(JSON.stringify(payload), NX_PASS);
  };

  const callNx = async <T>(pathName: string, body: Record<string, unknown>, timeoutMs: number): Promise<T | null> => {
    try {
      const q = makeSignedQuery(body);
      const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await fetch(`${nxOrigin}${pathName}?q=${encodeURIComponent(q)}`, {
        headers: nxHeaders,
        signal: sig,
      });
      if (!res.ok) {
        if (res.status >= 500) tripS2OriginCooldown(nxOrigin);
        return null;
      }
      const json = (await res.json()) as { _hash?: string };
      if (!json?._hash) return null;
      const dec = openSslDecrypt(json._hash, NX_PASS);
      return dec ? (JSON.parse(dec) as T) : null;
    } catch {
      return null;
    }
  };

  const baseReq = {
    ex_lang: true,
    tmdbId: String(query.tmdbId),
    imdb_id: imdbId || query.imdbId || '',
    type: query.type,
    ...(query.type === 'tv'
      ? { season: String(query.season ?? 1), episode: String(query.episode ?? 1) }
      : {}),
  };

  const serverPromise = callNx<{
    servers?: {
      id?: string;
      provider?: string;
      scraper?: string;
      status?: string;
      web_support?: boolean;
      isDisable?: boolean;
      types?: string[];
      high_priority?: number;
      position?: number;
    }[];
  }>('/api/servers', baseReq, 2800);
  // Subtitle discovery is independent of server probing; start it concurrently so
  // current `language` + `uri` tracks do not add another serial playback delay.
  const subtitlePromise = callNx<
    { subtitles?: ExtractSubtitleItem[] } | ExtractSubtitleItem[]
  >('/api/subtitles', baseReq, 3000);
  const srvResp = await serverPromise;

  let activeIds: string[] = [];
  if (Array.isArray(srvResp?.servers) && srvResp.servers.length > 0) {
    activeIds = srvResp.servers
      .filter(
        (s) =>
          s &&
          s.web_support !== false &&
          s.isDisable !== true &&
          (!Array.isArray(s.types) || s.types.length === 0 || s.types.includes('web')) &&
          s.status !== 'error' &&
          s.status !== 'offline' &&
          s.status !== 'disabled',
      )
      .sort((a, b) => {
        const ap = Number(a.high_priority ?? a.position ?? 999);
        const bp = Number(b.high_priority ?? b.position ?? 999);
        return ap - bp;
      })
      .map((s) => String(s.scraper || s.id || s.provider || '').trim())
      .filter(Boolean);
  }
  if (!activeIds.length) {
    activeIds = NX_PRIORITY_SERVERS.slice(0, 8);
  }

  // Keep fan-out bounded: current multi-language scrapers sort ahead of legacy
  // single-language lanes, while unknown future IDs retain upstream list order.
  const orderedProviders = [...new Set(activeIds)]
    .sort((a, b) => {
      const ia = NX_PRIORITY_SERVERS.indexOf(a);
      const ib = NX_PRIORITY_SERVERS.indexOf(b);
      return (ia >= 0 ? ia : 999) - (ib >= 0 ? ib : 999);
    })
    .slice(0, NX_MAX_PROVIDER_PROBES);

  const nowSec = Math.floor(Date.now() / 1000);
  const providerResultsPromise = Promise.all(
    orderedProviders.map(async (provider, pIdx) => {
      const t0 = performance.now();
      const data = await callNx<{ sources?: NxRawSource[]; subtitles?: ExtractSubtitleItem[] }>(
        '/api/sources',
        { ...baseReq, provider },
        4200,
      );
      const ms = Math.max(1, Math.round(performance.now() - t0));
      return { provider, pIdx, ms, data };
    }),
  );
  const [providerResults, dedicatedSubtitleResp] = await Promise.all([
    providerResultsPromise,
    subtitlePromise,
  ]);

  const rawSubs: ExtractSubtitleItem[] = [];
  if (Array.isArray(dedicatedSubtitleResp)) {
    rawSubs.push(...dedicatedSubtitleResp);
  } else if (Array.isArray(dedicatedSubtitleResp?.subtitles)) {
    rawSubs.push(...dedicatedSubtitleResp.subtitles);
  }
  for (const r of providerResults) {
    if (Array.isArray(r.data?.subtitles)) rawSubs.push(...r.data!.subtitles!);
    for (const s of r.data?.sources ?? []) {
      if (Array.isArray(s?.subtitles)) rawSubs.push(...s.subtitles);
      if (Array.isArray(s?.tracks)) rawSubs.push(...s.tracks);
    }
  }
  const sharedSubs = mapSubtitles(rawSubs, nxOrigin);

  const seenUrls = new Set<string>();
  const out: RawStreamCandidate[] = [];

  for (const { provider, pIdx, ms, data } of providerResults) {
    const list = data?.sources;
    if (!Array.isArray(list) || !list.length) continue;

    for (let sIdx = 0; sIdx < list.length; sIdx++) {
      const s = list[sIdx];
      if (!s || s.isEmbed) continue;
      const rawUrl = String(s.url ?? '').trim();
      if (
        !rawUrl ||
        !isSafeUpstreamUrl(rawUrl) ||
        isDeadNxshaSourceUrl(rawUrl) ||
        seenUrls.has(rawUrl)
      ) {
        continue;
      }

      try {
        const parsedUrl = new URL(rawUrl);
        let expRaw = '';
        for (const [key, value] of parsedUrl.searchParams) {
          if (['expire', 'expires', 'exp'].includes(key.toLowerCase())) {
            expRaw = value;
            break;
          }
        }
        let expSec = Number(expRaw);
        if (expSec > 1_000_000_000_000) expSec /= 1000;
        if (expSec > 0 && expSec < nowSec + 30) continue;
      } catch {
        continue;
      }

      seenUrls.add(rawUrl);

      // `/pl/H4sI` master playlists (`vidapi`) work directly without upstream Referer/Origin;
      // worker-proxied streams (`nxstreamhub.workers.dev`, `itsnitrox.tech`) require `nxOrigin` Referer.
      let headers: Record<string, string>;
      if (/\/pl\/H4sI/.test(rawUrl)) {
        headers = { 'User-Agent': BROWSER_UA };
      } else if (s.headers && (s.headers.Referer || s.headers.referer)) {
        headers = { 'User-Agent': BROWSER_UA, ...s.headers };
      } else {
        headers = {
          'User-Agent': BROWSER_UA,
          Referer: `${nxOrigin}/`,
          Origin: nxOrigin,
          ...(s.headers ?? {}),
        };
      }

      const meta = parseNxItemMeta(
        s.label,
        s.quality !== undefined ? String(s.quality) : undefined,
        { lang: s.lang, langName: s.langName, multiLangs: s.multiLangs },
      );
      const streamType = inferStreamType(s.type, rawUrl);
      const qualityBonus = meta.quality === '2160p' || meta.quality === '1080p' ? 0 : meta.quality === '720p' ? 2 : 4;
      const rankBase = meta.isHardsub
        ? 85
        : meta.multiAudio
          ? 1 + qualityBonus
          : 6 + pIdx * 1.5 + qualityBonus + sIdx * 0.1;

      out.push({
        key: `nx:${provider}:${sIdx}:${rawUrl}`,
        fingerprint: `nx:${provider}:${meta.multiAudio ? `mul:${meta.discoveredCodes.join(',')}` : meta.singleCode || 'und'}:${rawUrl.split('?')[0]}`,
        type: streamType,
        url: rawUrl,
        headers,
        quality: meta.quality,
        ...(meta.singleCode ? { audioLang: meta.singleCode, audioLabel: meta.singleLabel } : {}),
        ...(meta.discoveredCodes.length ? { availableAudioLangs: meta.discoveredCodes } : {}),
        multiAudio: meta.multiAudio,
        subtitles: sharedSubs,
        rank: rankBase + Math.min(ms, 4000) / 1000,
      });
    }
  }

  return out;
}

const MAX_VS_CACHE = 128;
const VS_CACHE_TTL_MS = 5 * 60_000;
const vidstuckCache = new Map<string, { expiresAt: number; candidates: RawStreamCandidate[] }>();

async function fetchFromVidStuck(
  cfg: BackendConfig['source2'],
  query: SourceQuery,
  metaHint: ExtractMetaHint,
): Promise<RawStreamCandidate[]> {
  const vsOrigin = cfg.vidstuckOrigin;
  if (!vsOrigin || isS2OriginCoolingDown(vsOrigin)) return [];

  const prefCode = query.preferredLang ? normalizeLang(query.preferredLang).code : '';
  const prefPrimary = prefCode && prefCode !== 'und' ? prefCode.split('-')[0] : '';
  const cacheKey = `${vsOrigin}|${query.type}|${query.tmdbId}|${query.season ?? 0}|${query.episode ?? 0}|${prefPrimary}`;
  const cached = vidstuckCache.get(cacheKey);
  if (cached) {
    if (Date.now() <= cached.expiresAt) return cached.candidates;
    vidstuckCache.delete(cacheKey);
  }

  const embedPath =
    query.type === 'movie'
      ? `/embed/movie/${encodeURIComponent(query.tmdbId)}`
      : `/embed/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;

  const apiHeaders: Record<string, string> = {
    Accept: 'application/json',
    Origin: vsOrigin,
    Referer: `${vsOrigin}${embedPath}`,
    'User-Agent': BROWSER_UA,
  };

  const mintRaider = async (serverId: string): Promise<{ token: string; ts: number | string } | null> => {
    try {
      const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3200)]) : AbortSignal.timeout(3200);
      const body: Record<string, string | number> = {
        [VS_FIELDS.id]: Number(query.tmdbId),
        [VS_FIELDS.type]: query.type,
        [VS_FIELDS.path]: serverId,
      };
      if (query.type === 'tv') {
        body[VS_FIELDS.s] = Number(query.season ?? 1);
        body[VS_FIELDS.e] = Number(query.episode ?? 1);
      }
      const res = await fetch(`${vsOrigin}/backend/raider`, {
        method: 'POST',
        headers: { ...apiHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: sig,
      });
      if (res.status === 429 || res.status >= 500) {
        tripS2OriginCooldown(vsOrigin);
        return null;
      }
      if (!res.ok) return null;
      const j = (await res.json()) as { token?: string; ts?: number | string };
      return j?.token && j?.ts !== undefined ? { token: j.token, ts: j.ts } : null;
    } catch {
      return null;
    }
  };

  const buildVsParams = (
    tok: { token: string; ts: number | string },
    serverId: string,
    extra: Record<string, string> = {},
  ): URLSearchParams => {
    const p = new URLSearchParams();
    p.set(VS_FIELDS.id, String(query.tmdbId));
    p.set(VS_FIELDS.type, query.type);
    p.set(VS_FIELDS.path, serverId);
    if (query.type === 'tv') {
      p.set(VS_FIELDS.s, String(query.season ?? 1));
      p.set(VS_FIELDS.e, String(query.episode ?? 1));
    }
    p.set(VS_FIELDS.ts, String(tok.ts));
    p.set(VS_FIELDS.token, tok.token);
    if (metaHint.title) p.set(VS_FIELDS.title, metaHint.title);
    if (metaHint.year) p.set(VS_FIELDS.year, metaHint.year);
    if (metaHint.releaseDate) p.set(VS_FIELDS.date, metaHint.releaseDate);
    if (metaHint.latestDate || metaHint.releaseDate) {
      p.set(VS_FIELDS.latest, metaHint.latestDate || metaHint.releaseDate || '');
    }
    if (metaHint.imdbId) p.set(VS_FIELDS.imdb, metaHint.imdbId);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  };

  interface VsLinkItem {
    link?: string;
    type?: string;
    resolution?: string | number;
    quality?: string;
    label?: string;
    lang?: string;
    langName?: string;
    multiLangs?: string[];
    onlyHevc?: boolean;
  }
  interface VsDubItem {
    lanCode?: string;
    lanName?: string;
    dubType?: string | number;
    /** Current direct API aliases. */
    lang?: string;
    name?: string;
    type?: string | number;
  }
  interface VsServerPayload {
    success?: boolean;
    links?: VsLinkItem[];
    dubs?: VsDubItem[];
    subtitles?: ExtractSubtitleItem[];
    data?: {
      links?: VsLinkItem[];
      dubs?: VsDubItem[];
      subtitles?: ExtractSubtitleItem[];
    };
  }

  const fetchServer = async (srv: string, extra: Record<string, string> = {}): Promise<VsServerPayload | null> => {
    const tok = await mintRaider(srv);
    if (!tok) return null;
    try {
      const qs = buildVsParams(tok, srv, extra).toString();
      const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(4800)]) : AbortSignal.timeout(4800);
      const res = await fetch(`${vsOrigin}/backend/servers/${srv}?${qs}`, {
        headers: apiHeaders,
        signal: sig,
      });
      if (res.status === 429) {
        tripS2OriginCooldown(vsOrigin);
        return null;
      }
      return res.ok ? ((await res.json()) as VsServerPayload) : null;
    } catch {
      return null;
    }
  };

  const fetchVsSubs = async (): Promise<RawTrackRef[]> => {
    try {
      const tok = await mintRaider('subtitle');
      if (!tok) return [];
      const p = buildVsParams(tok, 'subtitle');
      const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
      const res = await fetch(`${vsOrigin}/backend/subtitle?${p.toString()}`, {
        headers: apiHeaders,
        signal: sig,
      });
      if (!res.ok) return [];
      const raw = (await res.json()) as
        | ExtractSubtitleItem[]
        | { captions?: ExtractSubtitleItem[]; subtitles?: ExtractSubtitleItem[]; data?: ExtractSubtitleItem[] };
      const arr = Array.isArray(raw) ? raw : raw?.captions ?? raw?.subtitles ?? raw?.data ?? [];
      return mapSubtitles(arr, vsOrigin);
    } catch {
      return [];
    }
  };

  const [orionRes, andromedaRes, atlasRes, daedalusRes, ursaRes, vsSubs] = await Promise.all([
    fetchServer('orion'),
    fetchServer('andromeda'),
    fetchServer('atlas'),
    fetchServer('daedalus'),
    fetchServer('ursa'),
    fetchVsSubs(),
  ]);

  // Unlock Orion regional dubs (Hindi + preferredLang) dynamically when advertised.
  const advertisedDubs = orionRes?.dubs ?? orionRes?.data?.dubs ?? [];
  const wantedDubItems: { rawCode: string; normCode: string; normLabel: string; dubType: string }[] = [];
  for (const d of advertisedDubs) {
    const rawCode = String(d?.lanCode ?? d?.lang ?? '').trim();
    const rawName = String(d?.lanName ?? d?.name ?? '').trim();
    if (!rawCode || HARDSUB_LABEL_RE.test(rawName)) continue;
    const norm = normalizeLang(rawName || rawCode, rawName || rawCode);
    if (!norm.code || norm.code === 'und') continue;
    const primary = norm.code.split('-')[0];
    if (primary === prefPrimary || primary === 'hi' || wantedDubItems.length < 2) {
      if (!wantedDubItems.some((w) => w.normCode === norm.code)) {
        wantedDubItems.push({
          rawCode,
          normCode: norm.code,
          normLabel: norm.label,
          dubType: String(d?.dubType ?? d?.type ?? '0'),
        });
      }
    }
  }

  const dubPayloads = await Promise.all(
    wantedDubItems.slice(0, 2).map(async (d) => ({
      dub: d,
      resp: await fetchServer('orion', { dubCode: d.rawCode, dubType: d.dubType }),
    })),
  );

  const mediaHeaders: Record<string, string> = {
    Referer: `${vsOrigin}/`,
    Origin: vsOrigin,
    'User-Agent': BROWSER_UA,
  };

  const out: RawStreamCandidate[] = [];
  const seen = new Set<string>();

  const collectLinks = (
    srvId: string,
    payload: VsServerPayload | null,
    rankBase: number,
    explicitLang?: { code: string; label: string },
  ) => {
    const links = payload?.links ?? payload?.data?.links;
    if (!Array.isArray(links)) return;
    for (let i = 0; i < links.length; i++) {
      const item = links[i];
      // HEVC-only DASH/MP4 responses are not reliable browser playback sources;
      // keep compatible H.264/HLS candidates instead of advertising a broken option.
      if (item?.onlyHevc === true) continue;
      const rawLink = String(item?.link ?? '').trim();
      if (!rawLink) continue;
      const decrypted = /^https?:\/\//i.test(rawLink) ? rawLink : openSslDecrypt(rawLink, VS_PASS)?.trim() || '';
      let url = decrypted;
      if (decrypted && !/^https?:\/\//i.test(decrypted)) {
        try {
          url = new URL(decrypted, `${vsOrigin}/`).toString();
        } catch {
          url = '';
        }
      }
      if (!url || !isSafeUpstreamUrl(url) || seen.has(url)) continue;
      seen.add(url);

      const resNum = Number(String(item?.resolution || item?.quality || '').replace(/\D+/g, '')) || 0;
      const detectedQuality = resNum >= 2160 ? '2160p' : resNum > 0 ? `${resNum}p` : 'auto';
      const meta = parseNxItemMeta(item?.label, detectedQuality, {
        lang: item?.lang,
        langName: item?.langName,
        multiLangs: item?.multiLangs,
      });
      const quality = detectedQuality === 'auto' ? meta.quality : detectedQuality;
      out.push({
        key: `vs:${srvId}:${explicitLang?.code || 'orig'}:${i}:${url}`,
        type: inferStreamType(item?.type, url),
        url,
        headers: mediaHeaders,
        quality,
        ...(explicitLang
          ? { audioLang: explicitLang.code, audioLabel: explicitLang.label }
          : meta.singleCode
            ? { audioLang: meta.singleCode, audioLabel: meta.singleLabel }
            : {}),
        ...(!explicitLang && meta.discoveredCodes.length
          ? { availableAudioLangs: meta.discoveredCodes }
          : {}),
        multiAudio: explicitLang ? false : meta.multiAudio,
        subtitles: vsSubs,
        rank: rankBase + (!explicitLang && meta.multiAudio ? -4 : 0) + i * 0.2,
      });
    }
  };

  collectLinks('orion', orionRes, 7);
  for (const { dub, resp } of dubPayloads) {
    collectLinks('orion-dub', resp, 8, { code: dub.normCode, label: dub.normLabel });
  }
  collectLinks('andromeda', andromedaRes, 9);
  collectLinks('atlas', atlasRes, 11);
  collectLinks('daedalus', daedalusRes, 13);
  collectLinks('ursa', ursaRes, 15);

  if (out.length > 0) {
    if (vidstuckCache.size >= MAX_VS_CACHE) {
      const oldest = vidstuckCache.keys().next().value;
      if (oldest !== undefined) vidstuckCache.delete(oldest);
    }
    vidstuckCache.set(cacheKey, { expiresAt: Date.now() + VS_CACHE_TTL_MS, candidates: out });
  }

  return out;
}

async function resolveViaExtractApi(
  cfg: BackendConfig['source2'],
  query: SourceQuery,
  initialMetaHint: ExtractMetaHint,
  hasParallelCluster: boolean,
): Promise<RawStreamCandidate[]> {
  if (!cfg.embedOrigin || isS2OriginCoolingDown(cfg.embedOrigin)) return [];
  const isLoopbackMock = isLoopbackHost(cfg.embedOrigin);
  let metaHint = { ...initialMetaHint };

  let fetched = await fetchExtractPayload(
    cfg,
    query,
    cfg.defaultServer,
    metaHint,
    hasParallelCluster && !isLoopbackMock ? 3400 : 6000,
  );

  if (!fetched && !isLoopbackMock) {
    tripS2OriginCooldown(cfg.embedOrigin);
    return [];
  }

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

    if (!isLoopbackMock && !hasParallelCluster) {
      triggerScanWarmup(cfg, query, metaHint);
      const retryServers = [...new Set(['atlas', 'alatreon', cfg.defaultServer])];
      for (let attempt = 0; attempt < retryServers.length && !hasAnySources(fetched?.payload); attempt++) {
        if (query.signal?.aborted) break;
        await abortableDelay(attempt === 0 ? 850 : 950, query.signal);
        if (query.signal?.aborted) break;
        fetched = await fetchExtractPayload(cfg, query, retryServers[attempt], metaHint, 5000);
      }
    } else if (isLoopbackMock && metaHint.title) {
      fetched = await fetchExtractPayload(cfg, query, cfg.defaultServer, metaHint);
    }
  }

  if (!fetched || !hasAnySources(fetched.payload)) {
    return [];
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
      .map((item) =>
        parseItem(
          item,
          entry.latencyMs,
          entry.bucket.dubs?.length ? entry.bucket.dubs : payload.dubs,
        ),
      )
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

  return emittedCandidates;
}

export function createSource2Adapter(cfg: BackendConfig['source2']): SourceAdapter {
  return {
    id: 'source-2',
    label: 'Source 2',
    enabled: () => cfg.enabled,

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      // Give TMDB metadata a fast 260ms head-start window (0ms if cached in RAM)
      // so `/api/extract`, `nxsha`, and `vidstuck` receive `title`, `year`, `date`, and `imdbId`.
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

      const hasLiveClusters = !!(cfg.nxshaOrigin || cfg.vidstuckOrigin);

      const [extractList, nxList, vsList] = await Promise.all([
        resolveViaExtractApi(cfg, query, metaHint, hasLiveClusters),
        fetchFromNxsha(cfg, query, metaHint.imdbId),
        fetchFromVidStuck(cfg, query, metaHint),
      ]);

      const merged = [...nxList, ...vsList, ...extractList];
      if (!merged.length) return { candidates: [] };

      // Share pooled subtitles across Source 2 candidates lacking inline subtitle tracks
      const pooledSubs: RawTrackRef[] = [];
      const seenSub = new Set<string>();
      for (const c of merged) {
        for (const s of c.subtitles ?? []) {
          const sk = `${s.lang}:${s.url}`;
          if (!seenSub.has(sk)) {
            seenSub.add(sk);
            pooledSubs.push(s);
          }
        }
      }
      if (pooledSubs.length) {
        for (const c of merged) {
          if (!c.subtitles || c.subtitles.length === 0) {
            c.subtitles = pooledSubs;
          }
        }
      }

      const prefCode = query.preferredLang ? normalizeLang(query.preferredLang).code : '';
      const prefPrimary = prefCode && prefCode !== 'und' ? prefCode.split('-')[0] : '';

      const langScore = (c: RawStreamCandidate): number => {
        if (!prefPrimary) return 0;
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

      const candidates = merged.sort((a, b) => {
        if (prefPrimary) {
          const diff = langScore(a) - langScore(b);
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
