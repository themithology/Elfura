/** VidLove server variants used by the CineHD and CineJoy Nuvio plugins.
 * The plugins also use VidRock/Nxsha, already covered by Source 1 and Sources 5/7. */
import { isSafeUpstreamUrl } from '../security.js';
import type { RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://api.vidlove.cc';
const PLAYER = 'https://player.vidlove.cc/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: PLAYER, Accept: 'application/json' };
const VARIANTS = [
  { id: '', label: 'default' },
  { id: 'moviebox', label: 'MovieBox' },
  { id: 'moviebox2', label: 'MovieBox 2' },
  { id: 'warden', label: 'Warden' },
  { id: 'cinefreak', label: 'CineFreak' },
  { id: 'vidapi', label: 'VidAPI' },
  { id: 'ipcloud', label: 'IPCloud' },
  { id: 'tcloud', label: 'TCloud' },
] as const;

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;

async function readJson(response: Response): Promise<JsonObject | null> {
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
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

function hlsQuality(manifest: unknown): string {
  if (typeof manifest !== 'string') return 'auto';
  const heights = [...manifest.matchAll(/RESOLUTION=\d+x(\d+)/gi)].map(match => Number(match[1])).filter(Number.isSafeInteger);
  const height = Math.max(0, ...heights);
  return height ? `${height}p` : 'auto';
}

function subtitles(raw: unknown): RawTrackRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const track = item as Record<string, unknown>;
    const url = typeof track.file === 'string' ? track.file : typeof track.url === 'string' ? track.url : '';
    const label = typeof track.label === 'string' ? track.label : typeof track.language === 'string' ? track.language : '';
    if (!url || !label || !isSafeUpstreamUrl(url)) return [];
    const path = new URL(url).pathname.toLowerCase();
    const format = path.endsWith('.srt') ? 'srt' : path.endsWith('.ass') ? 'ass' : 'vtt';
    return [{ url, label, lang: typeof track.language === 'string' ? track.language : label, format, headers: HEADERS }];
  });
}

function buildApiUrl(query: SourceQuery, variant: string): string {
  const params = new URLSearchParams({ id: query.tmdbId, mode: 'json' });
  if (query.type === 'tv') {
    params.set('season', String(query.season ?? 1));
    params.set('episode', String(query.episode ?? 1));
  }
  if (variant) params.set('sources', variant);
  return `${API}/${query.type}?${params.toString()}`;
}

export async function fetchFromVidLove(query: SourceQuery, fetcher: Fetcher = globalThis.fetch): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return [];
  const season = query.type === 'tv' ? query.season ?? 1 : 0;
  const episode = query.type === 'tv' ? query.episode ?? 1 : 0;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1)) return [];
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(5500)])
    : AbortSignal.timeout(5500);
  const rows = await Promise.all(VARIANTS.map(async (variant, index) => {
    try {
      const response = await fetcher(buildApiUrl(query, variant.id), { headers: HEADERS, redirect: 'error', signal });
      const root = await readJson(response);
      const source = root?.source && typeof root.source === 'object' && !Array.isArray(root.source)
        ? root.source as JsonObject
        : null;
      const url = typeof source?.url === 'string' ? source.url.trim() : '';
      if (!url || !isSafeUpstreamUrl(url) || /embed/i.test(String(source?.type || ''))) return [];
      // VidLove's API returns the HLS master URL; the `manifest` property is
      // quality metadata used by the Nuvio plugin, not trusted audio evidence.
      const candidate: RawStreamCandidate = {
        key: url,
        url,
        type: 'hls',
        headers: HEADERS,
        quality: hlsQuality(source?.manifest),
        qualityLabelsUnreliable: true,
        subtitles: subtitles(source?.tracks),
        rank: 35 + index,
      };
      return [candidate];
    } catch { return []; }
  }));
  const unique = new Map<string, RawStreamCandidate>();
  for (const candidate of rows.flat()) if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  return [...unique.values()].slice(0, 24);
}

export function createSource18Adapter(enabled: () => boolean, fetcher?: Fetcher): SourceAdapter {
  return {
    id: 'source-18',
    label: 'VidLove · CineHD/CineJoy',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const candidates = await fetchFromVidLove(query, fetcher);
      query.diag?.push({ adapter: 'source-18', lane: 'VL', ok: candidates.length > 0, ms: Date.now() - started, detail: `candidates=${candidates.length}` });
      return { candidates: candidates.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'VL' } : candidate) };
    },
  };
}
