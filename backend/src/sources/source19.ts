/** FMovies plugin's MoviesAPI Vidora direct-HLS endpoint.
 * The companion VixSrc route is already handled by Source 9; Nxsha by 5/7. */
import { isSafeUpstreamUrl } from '../security.js';
import type { RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://moviesapi.to/api/vidora/v1';
const ORIGIN = 'https://moviesapi.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
// Public player key present in the upstream player bundle; not a private account credential.
const PLAYER_KEY = '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json', 'x-player-key': PLAYER_KEY, Referer: `${ORIGIN}/`, Origin: ORIGIN };
type Fetcher = typeof fetch;

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > 1_000_000) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) return null;
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

function mapTracks(value: unknown): RawTrackRef[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const track = item as Record<string, unknown>;
    const url = typeof track.file === 'string' ? track.file : '';
    const label = typeof track.label === 'string' ? track.label : '';
    if (!url || !label || !isSafeUpstreamUrl(url)) return [];
    const path = new URL(url).pathname.toLowerCase();
    const format = path.endsWith('.srt') ? 'srt' : path.endsWith('.ass') ? 'ass' : 'vtt';
    return [{ url, label, lang: label, format, headers: { 'User-Agent': UA, Referer: `${ORIGIN}/` } }];
  });
}

export async function fetchFromMoviesApi(query: SourceQuery, fetcher: Fetcher = globalThis.fetch): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return [];
  const season = query.season ?? 1, episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1)) return [];
  const path = query.type === 'tv'
    ? `/tv/${query.tmdbId}/${season}/${episode}`
    : `/movie/${query.tmdbId}`;
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(7000)])
    : AbortSignal.timeout(7000);
  try {
    const response = await fetcher(`${API}${path}`, { headers: HEADERS, redirect: 'error', signal });
    const root = await readJson(response);
    const sources = Array.isArray(root?.sources) ? root.sources : [];
    const source = sources[0] && typeof sources[0] === 'object' && !Array.isArray(sources[0])
      ? sources[0] as Record<string, unknown>
      : null;
    const url = typeof source?.url === 'string' ? source.url.trim() : '';
    if (!root?.result || !url || !isSafeUpstreamUrl(url)) return [];
    const subtitles = mapTracks(source?.tracks);
    const candidate: RawStreamCandidate = {
      key: url,
      url,
      type: 'hls',
      headers: { 'User-Agent': UA, Referer: `${ORIGIN}/` },
      quality: 'auto',
      qualityLabelsUnreliable: true,
      subtitles,
      rank: 30,
    };
    return [candidate];
  } catch { return []; }
}

export function createSource19Adapter(enabled: () => boolean, fetcher?: Fetcher): SourceAdapter {
  return {
    id: 'source-19',
    label: 'MoviesAPI · FMovies',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const candidates = await fetchFromMoviesApi(query, fetcher);
      query.diag?.push({ adapter: 'source-19', lane: 'MA', ok: candidates.length > 0, ms: Date.now() - started, detail: `candidates=${candidates.length}` });
      return { candidates: candidates.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'MA' } : candidate) };
    },
  };
}
