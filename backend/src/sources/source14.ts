/** Direct RiveStream Citadel HLS discovery. Captions are deliberately ignored. */
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://scrapper.rivestream.app/api/provider';
const ORIGIN = 'https://www.rivestream.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const MAX_JSON_BYTES = 384_000;
const MAX_ROWS = 40;
const MAX_CANDIDATES = 16;

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > MAX_JSON_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseCitadelRow(row: unknown, rank: number): (RawStreamCandidate & { identity: string; lang: string }) | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const item = row as { url?: unknown; quality?: unknown; format?: unknown; source?: unknown };
  if (item.source != null && String(item.source).toLowerCase() !== 'citadel') return null;
  if (typeof item.format !== 'string' || !/^hls$/i.test(item.format.trim())) return null;
  if (typeof item.quality !== 'string' || item.quality.length > 80 || typeof item.url !== 'string' || item.url.length > 8192) return null;
  try {
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || !/^img\d*\.(?:hscow|fcxmb)\.com$/i.test(url.hostname) ||
        !/^\/(?:my)?hls_mps\/.+\/index_[a-z0-9_-]+\.m3u8$/i.test(url.pathname) || !isSafeUpstreamUrl(url.href)) return null;
    const expiry = Number(url.searchParams.get('Expires'));
    const signature = url.searchParams.get('Signature') || '';
    if (!Number.isSafeInteger(expiry) || expiry * 1000 <= Date.now() + 15_000 ||
        url.searchParams.get('KeyName') !== 'Signature' || !/^[A-Za-z0-9_+=/-]{20,256}$/.test(signature)) return null;
    const qualityMatch = /\b(2160|1440|1080|720|540|480|360)p\b/i.exec(item.quality);
    const label = qualityMatch ? item.quality.replace(qualityMatch[0], '').replace(/^[\s|·,:-]+|[\s|·,:-]+$/g, '') : item.quality.trim();
    if (!label || /subtitle|caption|commentary|multi|dual/i.test(label)) return null;
    const lang = normalizeLang(label);
    if (!lang.code || lang.code === 'und') return null;
    // Same path on mirrored CDNs is one media identity. Conflicting language
    // labels for that identity are discarded below rather than guessed.
    const identity = url.pathname.replace(/\/index_[a-z0-9_-]+\.m3u8$/i, '/index.m3u8');
    const quality = qualityMatch ? `${qualityMatch[1]}p` : 'auto';
    return {
      key: `${url.origin}${identity}:${lang.code}`,
      fingerprint: `${identity}:${lang.code}:${quality}`,
      url: url.href,
      type: 'hls',
      quality,
      audioLang: lang.code,
      audioLabel: `${lang.label} · Citadel label`,
      headers: { 'User-Agent': UA, Referer: `${ORIGIN}/`, Origin: ORIGIN },
      rank: 20 + rank,
      identity,
      lang: lang.code,
    };
  } catch {
    return null;
  }
}

export function citadelCandidates(body: unknown): RawStreamCandidate[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const sources = (data as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  const parsed = sources.slice(0, MAX_ROWS).flatMap((row, index) => {
    const candidate = parseCitadelRow(row, index);
    return candidate ? [candidate] : [];
  });
  const langsByIdentity = new Map<string, Set<string>>();
  for (const candidate of parsed) {
    const langs = langsByIdentity.get(candidate.identity) ?? new Set<string>();
    langs.add(candidate.lang);
    langsByIdentity.set(candidate.identity, langs);
  }
  const seen = new Set<string>();
  return parsed.filter(candidate => {
    if ((langsByIdentity.get(candidate.identity)?.size ?? 0) > 1) return false;
    const key = `${candidate.identity}:${candidate.lang}:${candidate.quality}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_CANDIDATES).map(({ identity: _identity, lang: _lang, ...candidate }) => candidate);
}

export async function fetchFromCitadel(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie', 'tv'].includes(query.type)) return [];
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) return [];
  const endpoint = new URL(API);
  endpoint.searchParams.set('provider', 'citadel');
  endpoint.searchParams.set('id', query.tmdbId);
  if (query.type === 'tv') {
    endpoint.searchParams.set('season', String(season));
    endpoint.searchParams.set('episode', String(episode));
  }
  // The provider buckets this cache-buster; a stable short window avoids
  // needless request fan-out while ensuring signed URLs are periodically refreshed.
  endpoint.searchParams.set('cb', String(Math.floor(Date.now() / 3_000_000)));
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(2800)])
    : AbortSignal.timeout(2800);
  try {
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': UA, Referer: `${ORIGIN}/`, Origin: ORIGIN, Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    return citadelCandidates(await readJson(response));
  } catch {
    return [];
  }
}

export function createSource14Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-14',
    label: 'Source 14',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const raw = await fetchFromCitadel(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter(candidate => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-14',
        lane: 'C',
        ok: candidates.length > 0,
        ms: Date.now() - started,
        detail: `languageRows=${raw.length},manifestReachable=${candidates.length}`,
      });
      return { candidates: candidates.map(candidate => query.diag
        ? { ...candidate, diagnosticLane: 'C' }
        : candidate) };
    },
  };
}
