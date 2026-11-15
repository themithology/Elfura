/**
 * SubDubAnime — Hindi/English subbed + dubbed anime lane (Source 18)
 * ==================================================================
 * TMDB-keyed JSON catalogue, no scraping and no browser:
 *
 *   GET /api/get.php?tmdbId=<id>                (movie)
 *   GET /api/get.php?id=<season>-<episode>&tmdbId=<id>   (series)
 *     -> { data: { dataId, quality, qid, format, ranges } }
 *
 * Each episode is published as several quality renditions on the provider's own
 * CDN, either as a range-mapped HLS playlist (`ranges` lists every rendition) or
 * as fixed MP4 files (`qid` = highest available code).
 *
 * A title can have several catalogue entries — one per audio language — that
 * share `originalTmdbId` and differ only in the zero-padded `tmdbId`. Those
 * entries are what make separate Hindi / English dub lanes possible, so the
 * catalogue is read (bounded, RAM-cached) when variant discovery is enabled.
 *
 * Lubrication notes: the catalogue snapshot is large, so it is capped and
 * cached in RAM for 30 minutes and skipped entirely when a title cannot be
 * matched; only the two JSON routes above are ever called.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { normalizeLang } from './lang.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://blakiteapi.xyz';
const CDN = 'https://hugh.cdn.rumble.cloud/video/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const MAX_JSON_BYTES = 256 * 1024;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const CATALOG_TTL_MS = 30 * 60_000;
const MAX_CANDIDATES = 6;

/** Provider quality token -> CDN code. */
const QCODES: Record<string, string> = {
  '240p': 'oaa',
  '360p': 'baa',
  '480p': 'caa',
  '720p': 'gaa',
  '1080p': 'haa',
};
const QORDER = ['240p', '360p', '480p', '720p', '1080p'];

/** Provider audio labels are trusted by default; set `ELFURA_SUBDUB_TRUST_LABELS=0` to keep them as claims only. */
const TRUST_LABELS = () => process.env.ELFURA_SUBDUB_TRUST_LABELS !== '0';

interface CatalogEntry {
  tmdbId?: unknown;
  originalTmdbId?: unknown;
  title?: unknown;
  language?: unknown;
  seasons?: unknown;
}

interface Catalog {
  movies: Record<string, CatalogEntry>;
  series: Record<string, CatalogEntry>;
  dramas: Record<string, CatalogEntry>;
}

/**
 * The CDN path segment is provider-issued and may itself contain slashes
 * (`streams/2025/<id>`), so it is validated as a relative path of safe
 * segments rather than a single token — no empty, `.` or `..` segments, no
 * query/fragment characters.
 */
export function isSafeDataId(id: string): boolean {
  if (!id || id.length > 128) return false;
  const segments = id.split('/');
  return segments.every((segment) => /^[A-Za-z0-9._-]{1,64}$/.test(segment) && segment !== '.' && segment !== '..');
}

interface StreamPayload {
  dataId?: unknown;
  quality?: unknown;
  qid?: unknown;
  format?: unknown;
  ranges?: unknown;
}

let catalogCache: { at: number; value: Catalog } | null = null;
let catalogInFlight: Promise<Catalog | null> | null = null;

async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function readJson(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
  trace?: string[],
): Promise<unknown> {
  try {
    const response = await fetch(url, {
      // The provider gateway answers 403 unless the referer is its own origin
      // (the site itself never calls this route). Credentials never leave here.
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${API}/`, Origin: API },
      redirect: 'error',
      signal,
    });
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const buffer = await readBounded(response, maxBytes);
    trace?.push(`http=${response.status}${contentType ? `/${contentType}` : ''}${buffer ? '' : '/no-body'}`);
    if (!buffer) return null;
    const text = buffer.toString('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      trace?.push(`body=${text.slice(0, 40).replace(/\s+/g, ' ')}`);
      return null;
    }
  } catch (err) {
    trace?.push(`net=${err instanceof Error ? err.name : 'error'}`);
    return null;
  }
}

/** Catalogue snapshot (bounded, RAM-cached). Returns null when unavailable or oversized. */
export async function loadSubDubCatalog(signal: AbortSignal): Promise<Catalog | null> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = (async () => {
    const body = await readJson(`${API}/api/getAllAnime.php`, signal, MAX_CATALOG_BYTES);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const data = (body as { data?: unknown }).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const root = data as Record<string, unknown>;
    const bucket = (key: string): Record<string, CatalogEntry> => {
      const value = root[key];
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, CatalogEntry>)
        : {};
    };
    const value: Catalog = { movies: bucket('movies'), series: bucket('series'), dramas: bucket('dramas') };
    catalogCache = { at: Date.now(), value };
    return value;
  })()
    .catch(() => null)
    .finally(() => {
      catalogInFlight = null;
    });
  return catalogInFlight;
}

/** Highest-quality renditions published for one payload row. */
export function renditionsFromPayload(payload: unknown): RawStreamCandidate[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const data = payload as StreamPayload;
  const id = typeof data.dataId === 'string' || typeof data.dataId === 'number' ? String(data.dataId).trim() : '';
  if (id.length < 2 || !isSafeDataId(id)) return [];

  const out: RawStreamCandidate[] = [];
  const format = typeof data.format === 'string' ? data.format.trim().toUpperCase() : '';
  if (format === 'M3U8') {
    const lines = typeof data.ranges === 'string' ? data.ranges.split('\n') : [];
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)-(\d+)\s*\(([^)]+)\)/);
      if (!match) continue;
      const quality = match[3].trim().toLowerCase();
      const code = QCODES[quality];
      if (!code) continue;
      const url =
        `${CDN}${id}.${code}.tar?r_file=chunklist.m3u8` +
        `&r_type=application%2Fvnd.apple.mpegurl&r_range=${match[1]}-${match[2]}`;
      if (!isSafeUpstreamUrl(url)) continue;
      out.push({
        key: url,
        url,
        type: 'hls',
        quality,
        headers: { 'User-Agent': UA },
        rank: 60 + (QORDER.length - QORDER.indexOf(quality)),
      });
    }
  } else {
    const declared = typeof data.quality === 'string' ? data.quality.trim().toLowerCase() : '';
    const top =
      Math.max(1, Math.min(QORDER.length, Number.parseInt(String(data.qid ?? ''), 10) || 0)) ||
      QORDER.indexOf(declared) + 1 ||
      3;
    for (let index = 0; index < top; index += 1) {
      const quality = QORDER[index];
      const code = QCODES[quality];
      const url = `${CDN}${id}.${code}.mp4`;
      if (!isSafeUpstreamUrl(url)) continue;
      out.push({
        key: url,
        url,
        type: 'mp4',
        quality,
        headers: { 'User-Agent': UA },
        rank: 60 + (QORDER.length - QORDER.indexOf(quality)),
      });
    }
  }
  return out
    .sort((a, b) => QORDER.indexOf(b.quality.toLowerCase()) - QORDER.indexOf(a.quality.toLowerCase()))
    .slice(0, MAX_CANDIDATES);
}

/** Provider catalogue label ("Hindi Dubbed", "English", …) -> BCP-47 audio tag. */
function audioFromLabel(label: unknown): { code: string; label: string } | null {
  const raw = typeof label === 'string' ? label.trim() : '';
  if (!raw) return null;
  const cleaned = raw.replace(/\b(dub(?:bed)?|sub(?:bed)?|audio|multi)\b/gi, ' ').trim();
  const normalized = normalizeLang(cleaned || raw);
  if (!normalized.code || normalized.code === 'und') return null;
  return { code: normalized.code, label: normalized.label };
}

/** Every catalogue entry that resolves to this TMDB id (one per audio language). */
export function catalogVariants(catalog: Catalog, type: 'movie' | 'tv', tmdbId: string): CatalogEntry[] {
  const wanted = String(tmdbId).replace(/^0+/, '');
  const buckets = type === 'movie' ? [catalog.movies] : [catalog.series, catalog.dramas];
  const found: CatalogEntry[] = [];
  for (const bucket of buckets) {
    for (const entry of Object.values(bucket)) {
      if (!entry || typeof entry !== 'object') continue;
      const original = String(entry.originalTmdbId ?? entry.tmdbId ?? '').replace(/^0+/, '');
      if (original && original === wanted) found.push(entry);
    }
  }
  return found.slice(0, 4);
}

async function fetchPayload(
  query: SourceQuery,
  tmdbId: string,
  signal: AbortSignal,
  trace?: string[],
): Promise<RawStreamCandidate[]> {
  const endpoint = new URL(`${API}/api/get.php`);
  endpoint.searchParams.set('tmdbId', tmdbId);
  if (query.type === 'tv') {
    const season = query.season ?? 1;
    const episode = query.episode ?? 1;
    endpoint.searchParams.set('id', `${season}-${episode}`);
  }
  const body = await readJson(endpoint.href, signal, MAX_JSON_BYTES, trace);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const root = body as { data?: unknown; success?: unknown; error?: unknown };
  const data = root.data;
  const dataShape = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data as Record<string, unknown>).slice(0, 8).join('|')
    : String(data === undefined ? 'undefined' : typeof data);
  trace?.push(`api(tmdb=${tmdbId})=${dataShape}`);
  const rows = renditionsFromPayload(data);
  if (rows.length === 0 && trace && data && typeof data === 'object' && !Array.isArray(data)) {
    // Types only, never values: enough to see which fields the payload carries.
    const record = data as Record<string, unknown>;
    const id = typeof record.dataId === 'string' || typeof record.dataId === 'number' ? String(record.dataId) : '';
    const fmt = typeof record.format === 'string' ? record.format.trim().toUpperCase() : '';
    const ranges = typeof record.ranges === 'string' ? record.ranges : '';
    trace.push(
      `idLen=${id.length} idSafe=${isSafeDataId(id)}` +
        ` fmt=${fmt || 'none'} lines=${ranges ? ranges.split('\n').length : 0} qid=${String(record.qid ?? 'none')}`,
    );
  }
  return rows;
}

export async function fetchFromSubDub(query: SourceQuery, trace?: string[]): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie', 'tv'].includes(query.type)) return [];
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1)) {
    return [];
  }
  const deadline = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(6000)])
    : AbortSignal.timeout(6000);

  const base = await fetchPayload(query, query.tmdbId, deadline, trace);
  const collected = new Map<string, RawStreamCandidate>();
  for (const candidate of base) collected.set(candidate.url, candidate);
  trace?.push(`base=${base.length}`);

  // Separate-language catalogue entries are the only way this provider exposes
  // a Hindi dub and an English dub as distinct streams.
  const catalog = await loadSubDubCatalog(deadline);
  if (!catalog) trace?.push('catalog=unavailable');
  if (catalog) {
    const variants = catalogVariants(catalog, query.type, query.tmdbId);
    trace?.push(`catalog=${query.type === 'movie' ? Object.keys(catalog.movies).length : Object.keys(catalog.series).length + Object.keys(catalog.dramas).length},variants=${variants.length}`);
    for (const variant of variants) {
      const variantId = typeof variant.tmdbId === 'string' ? variant.tmdbId : '';
      if (!/^\d{1,12}$/.test(variantId)) continue;
      const audio = audioFromLabel(variant.language) ?? audioFromLabel(variant.title);
      const rows = await fetchPayload(query, variantId, deadline, trace);
      for (const candidate of rows) {
        const existing = collected.get(candidate.url);
        if (existing) {
          // The plain `get.php?tmdbId=` call already returned this URL without a
          // language. A catalogue variant tells us which language it is, so the
          // label is attached to the existing candidate instead of dropped.
          if (!existing.audioLabel && !existing.claimedAudioLang && audio) {
            collected.set(candidate.url, {
              ...existing,
              claimedAudioLang: audio.code,
              audioLabel: audio.label,
              ...(TRUST_LABELS() ? { audioLang: audio.code } : {}),
            });
          }
          continue;
        }
        const enriched: RawStreamCandidate = audio
          ? {
              ...candidate,
              claimedAudioLang: audio.code,
              audioLabel: audio.label,
              ...(TRUST_LABELS() ? { audioLang: audio.code } : {}),
            }
          : candidate;
        collected.set(candidate.url, enriched);
      }
    }
  }
  return [...collected.values()];
}

export function createSource18Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-18',
    label: 'Source 18',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const trace: string[] = [];
      const raw = await fetchFromSubDub(query, trace);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const usable = checked.candidates.filter((candidate) => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-18',
        lane: 'S',
        ok: usable.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},reachable=${usable.length}${trace.length ? ` ${trace.join(' ')}` : ''}`,
      });
      return {
        candidates: usable.map((candidate) =>
          query.diag ? { ...candidate, diagnosticLane: 'S' } : candidate,
        ),
      };
    },
  };
}
