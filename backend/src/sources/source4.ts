/** Bingr's official stream API resolver. Only direct media URLs enter the relay. */
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type { RawSourceResult, RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://api.bingr.one/api';
const SITE = 'https://bingr.one';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36';
const SERVERS = [
  { id: 's40', name: 'Aphelion' },
  { id: 's70', name: 'Polaris' },
  { id: 's62', name: 'Bastion' },
  { id: 's63', name: 'Hallyu' },
  { id: 's30', name: 'Nova' },
  { id: 's60', name: 'Vertex' },
  { id: 's61', name: 'Corvus' },
  { id: 's31', name: 'Orion' },
  { id: 's3', name: 'Edmunds' },
] as const;
const MAX_RESPONSE_BYTES = 1_500_000;

type BingrStream = {
  url?: unknown;
  type?: unknown;
  quality?: unknown;
  language?: unknown;
  label?: unknown;
  headers?: unknown;
  embed?: unknown;
};
type BingrResponse = { sources?: BingrStream[] };

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) {
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
      if (size > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { return null; }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function safeHeaders(input: unknown): Record<string, string> {
  const result: Record<string, string> = { 'User-Agent': UA, Referer: `${SITE}/`, Origin: SITE };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    if (!/^(referer|origin|user-agent)$/i.test(key) || typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value)) continue;
    if (/^(referer|origin)$/i.test(key) && !isSafeUpstreamUrl(value)) continue;
    result[/^referer$/i.test(key) ? 'Referer' : /^origin$/i.test(key) ? 'Origin' : 'User-Agent'] = value;
  }
  return result;
}

function streamType(stream: BingrStream, url: string): RawStreamCandidate['type'] | null {
  const type = String(stream.type ?? '').toLowerCase();
  if (/\.m3u8(?:[?#]|$)/i.test(url) || /^(hls|m3u8|application\/vnd\.apple\.mpegurl)$/.test(type)) return 'hls';
  if (/\.(?:mp4|m4v|webm)(?:[?#]|$)/i.test(url) || /^(mp4|file|progressive)$/.test(type)) return 'mp4';
  return null;
}

function candidatesFrom(payload: BingrResponse | null, rank: number): RawStreamCandidate[] {
  if (!Array.isArray(payload?.sources)) return [];
  const result: RawStreamCandidate[] = [];
  for (const stream of payload.sources.slice(0, 40)) {
    if (typeof stream.url !== 'string' || stream.url.length > 8192 || stream.embed === true || /\b(?:embed|iframe)\b/i.test(String(stream.type ?? ''))) continue;
    if (!isSafeUpstreamUrl(stream.url)) continue;
    const type = streamType(stream, stream.url);
    if (!type) continue;
    const lang = normalizeLang(typeof stream.language === 'string' ? stream.language : 'und');
    const quality = typeof stream.quality === 'string' && /^[\w .-]{1,32}$/.test(stream.quality) ? stream.quality : 'auto';
    result.push({
      key: stream.url,
      url: stream.url,
      type,
      quality,
      ...(lang.code !== 'und' ? { audioLang: lang.code, audioLabel: lang.label } : {}),
      headers: safeHeaders(stream.headers),
      rank: rank * 100 + result.length,
    });
  }
  return result;
}

export async function fetchFromBingr(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie', 'tv'].includes(query.type)) return [];
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) return [];

  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(8_500)]) : AbortSignal.timeout(8_500);
  const headers = { 'User-Agent': UA, Accept: 'application/json', Referer: `${SITE}/`, Origin: SITE };
  const getJson = async (url: string): Promise<unknown> => {
    try {
      const response = await fetch(url, { headers, redirect: 'error', signal });
      return await readJson(response);
    } catch { return null; }
  };

  // Details are best-effort; the stream API can also resolve by TMDB ID alone.
  const details = await getJson(`${API}/details/${query.type}/${encodeURIComponent(query.tmdbId)}`) as { title?: unknown; name?: unknown; year?: unknown; release_date?: unknown; first_air_date?: unknown } | null;
  const title = typeof details?.title === 'string' ? details.title : typeof details?.name === 'string' ? details.name : '';
  const date = typeof details?.release_date === 'string' ? details.release_date : typeof details?.first_air_date === 'string' ? details.first_air_date : '';
  const year = typeof details?.year === 'string' || typeof details?.year === 'number' ? String(details.year) : date.slice(0, 4);
  const search: Record<string, unknown> = {
    ...(title ? { title } : {}),
    ...(year ? { year } : {}),
    ...(query.type === 'tv' ? { season, episode } : {}),
  };

  const resolved = await Promise.all(SERVERS.map(async (server, index) => {
    try {
      let payload: unknown;
      if (server.id === 's40' && query.type === 'tv') {
        payload = await getJson(`${API}/stream/aphelion-tv/${encodeURIComponent(query.tmdbId)}/${season}/${episode}`);
      } else {
        const response = await fetch(`${API}/stream`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ srv: server.id, t: query.type, id: query.tmdbId, query: search }),
          redirect: 'error',
          signal,
        });
        payload = await readJson(response);
      }
      return candidatesFrom(payload as BingrResponse | null, index);
    } catch { return []; }
  }));

  const seen = new Set<string>();
  return resolved.flat().filter(candidate => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  }).slice(0, 40);
}

export function createSource4Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-4',
    label: 'Source 4',
    enabled,
    async resolve(query): Promise<RawSourceResult> {
      const start = Date.now();
      const candidates = await fetchFromBingr(query);
      query.diag?.push({ adapter: 'source-4', lane: 'B', ok: candidates.length > 0, ms: Date.now() - start, detail: `candidates=${candidates.length}` });
      return { candidates: candidates.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'B' } : candidate) };
    },
  };
}
