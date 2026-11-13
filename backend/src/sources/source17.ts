/**
 * Generic Stremio-addon bridge for user-configured AIOStreams/MediaFusion-style
 * endpoints. It does not download or execute any third-party add-on code; it
 * consumes only the standard JSON stream resource and accepts direct media URLs.
 */
import { isSafeUpstreamUrl } from '../security.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const MAX_ADDONS = 8;
const MAX_CANDIDATES = 24;
const MAX_JSON_BYTES = 384_000;
const UA = 'Mozilla/5.0 (compatible; Elfura-Stremio-Bridge/1.0)';
const ALLOWED_HEADERS = new Set(['user-agent', 'referer', 'origin', 'authorization']);

function addonBase(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !isSafeUpstreamUrl(url.href)) return null;
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/manifest\.json$/i, '');
    return url;
  } catch {
    return null;
  }
}

function streamEndpoint(base: URL, type: 'movie' | 'series', id: string): URL {
  const endpoint = new URL(base);
  endpoint.pathname = `${base.pathname}/stream/${type}/${id}.json`.replace(/\/{2,}/g, '/');
  return endpoint;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > MAX_JSON_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function safeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!ALLOWED_HEADERS.has(key.toLowerCase()) || typeof raw !== 'string' || raw.length > 2048 || /[\r\n]/.test(raw)) continue;
    if ((key.toLowerCase() === 'referer' || key.toLowerCase() === 'origin') && !isSafeUpstreamUrl(raw)) continue;
    const normalized = key.toLowerCase() === 'user-agent' ? 'User-Agent'
      : key.toLowerCase() === 'referer' ? 'Referer'
        : key.toLowerCase() === 'origin' ? 'Origin' : 'Authorization';
    out[normalized] = raw;
  }
  return out;
}

function inferType(url: URL): RawStreamCandidate['type'] | null {
  if (url.username || url.password) return null;
  if (/\.m3u8$/i.test(url.pathname)) return 'hls';
  if (/\.mpd$/i.test(url.pathname)) return 'dash';
  if (/\.(?:mp4|m4v)$/i.test(url.pathname)) return 'mp4';
  return null;
}

function candidateIdentity(candidate: RawStreamCandidate): string {
  const headers = Object.entries(candidate.headers || {}).sort(([a], [b]) => a.localeCompare(b));
  return `${candidate.url}|${JSON.stringify(headers)}`;
}

function parseCandidates(payload: unknown, addonIndex: number): RawStreamCandidate[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const streams = (payload as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return [];
  const candidates: RawStreamCandidate[] = [];
  for (const [index, entry] of streams.slice(0, 32).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as {
      url?: unknown;
      infoHash?: unknown;
      fileIdx?: unknown;
      drmKeyId?: unknown;
      drmKey?: unknown;
      name?: unknown;
      title?: unknown;
      description?: unknown;
      behaviorHints?: { proxyHeaders?: { request?: unknown } };
    };
    // Torrents and host-specific resolver recipes are not direct HLS candidates.
    if (typeof row.url !== 'string' || row.infoHash || row.fileIdx !== undefined || row.drmKeyId || row.drmKey || !isSafeUpstreamUrl(row.url)) continue;
    let url: URL;
    try { url = new URL(row.url); } catch { continue; }
    if (url.username || url.password) continue;
    const type = inferType(url);
    if (!type) continue;
    const name = [row.name, row.title, row.description].find((x): x is string => typeof x === 'string' && x.length <= 300) || 'Adaptive stream';
    const quality = /\b(2160|1440|1080|720|540|480|360)p\b/i.exec(name)?.[0]?.toLowerCase() || 'auto';
    const requestHeaders = row.behaviorHints?.proxyHeaders?.request;
    candidates.push({
      key: `${addonIndex}:${index}:${url.href}`,
      url: url.href,
      type,
      quality,
      rank: 50 + addonIndex * 40 + index,
      headers: { 'User-Agent': UA, ...safeHeaders(requestHeaders) },
    });
  }
  return candidates;
}

export async function fetchFromStremioAddons(addonUrls: string[], query: SourceQuery): Promise<RawStreamCandidate[]> {
  let imdbId = query.imdbId || '';
  if (!/^tt\d{5,12}$/.test(imdbId) && query.resolveMetaFallback) {
    try { imdbId = (await query.resolveMetaFallback()).imdbId || ''; } catch { /* optional metadata */ }
  }
  if (!/^tt\d{5,12}$/.test(imdbId)) return [];
  if (!/^tt\d{5,12}$/.test(imdbId)) return [];
  const type = query.type === 'tv' ? 'series' : 'movie';
  let id = imdbId;
  if (query.type === 'tv') {
    const season = query.season ?? 1;
    const episode = query.episode ?? 1;
    if (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1) return [];
    id = `${imdbId}:${season}:${episode}`;
  }
  const selected = addonUrls.slice(0, MAX_ADDONS).map(addonBase).filter((x): x is URL => !!x);
  const results = await Promise.all(selected.map(async (base, index) => {
    try {
      const response = await fetch(streamEndpoint(base, type, id), {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        redirect: 'error',
        signal: query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3200)]) : AbortSignal.timeout(3200),
      });
      return parseCandidates(await boundedJson(response), index);
    } catch {
      return [];
    }
  }));
  const unique = new Map<string, RawStreamCandidate>();
  for (const candidate of results.flat()) {
    const identity = candidateIdentity(candidate);
    if (!unique.has(identity)) unique.set(identity, candidate);
    if (unique.size >= MAX_CANDIDATES) break;
  }
  return [...unique.values()];
}

export function createStremioAddonAdapter(addonUrls: string[]): SourceAdapter {
  const configured = addonUrls.slice(0, MAX_ADDONS).filter((url) => !!addonBase(url));
  return {
    id: 'source-17',
    label: 'Source 17',
    enabled: () => configured.length > 0,
    async resolve(query) {
      const started = Date.now();
      const candidates = await fetchFromStremioAddons(configured, query);
      query.diag?.push({ adapter: 'source-17', lane: 'S', ok: candidates.length > 0, ms: Date.now() - started, detail: `configuredAddons=${configured.length},directCandidates=${candidates.length}` });
      return { candidates: candidates.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'S' } : candidate) };
    },
  };
}
