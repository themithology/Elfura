/** Zenix plugin's direct boot/source API. The plugin also reuses Nxsha and
 * VidRift; those shared backends remain covered by Sources 5/7 and Source 1. */
import { isSafeUpstreamUrl } from '../security.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://zenix.website';
const EMBED = 'https://embed.vidrift.in';
// Public player API key shipped in the upstream web plugin, not a private credential.
const API_KEY = 'k_dd6ed463ad5bbd10301e1eec';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36';
const API_HEADERS = {
  'User-Agent': UA,
  Referer: `${SITE}/`,
  Origin: SITE,
  Accept: 'application/json, text/plain, */*',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-dest': 'empty',
};
const STREAM_HEADERS = { 'User-Agent': UA, Referer: `${EMBED}/` };
const PROVIDERS = ['moviebox', 'vaplayer'] as const;
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

function typeOfStream(url: string, declared: unknown): RawStreamCandidate['type'] | null {
  const type = String(declared || '').toLowerCase().split(';')[0].trim();
  const path = new URL(url).pathname.toLowerCase();
  if (/\.m3u8$/i.test(path) || /^(hls|m3u8|application\/vnd\.apple\.mpegurl)$/.test(type)) return 'hls';
  if (/\.mpd$/i.test(path) || /^(dash|mpd|application\/dash\+xml)$/.test(type)) return 'dash';
  if (/\.mp4$/i.test(path) || /^(mp4|video\/mp4)$/.test(type)) return 'mp4';
  return null;
}

function titlePath(query: SourceQuery): string {
  return query.type === 'tv'
    ? `tv/${query.tmdbId}/${query.season ?? 1}/${query.episode ?? 1}`
    : `movie/${query.tmdbId}`;
}

function qualityOf(stream: Record<string, unknown>): string {
  const rungs = Array.isArray(stream.rungs) ? stream.rungs : [];
  const heights = rungs.flatMap(rung => {
    if (!rung || typeof rung !== 'object' || Array.isArray(rung)) return [];
    const height = Number((rung as Record<string, unknown>).height);
    return Number.isSafeInteger(height) && height > 0 ? [height] : [];
  });
  const maxRes = Number(stream.maxRes);
  const height = Math.max(0, ...heights, Number.isSafeInteger(maxRes) ? maxRes : 0);
  return height ? (height >= 2160 ? '4K' : `${height}p`) : 'auto';
}

export async function fetchFromZenix(query: SourceQuery, fetcher: Fetcher = globalThis.fetch): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return [];
  const season = query.season ?? 1, episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1)) return [];
  const path = titlePath(query);
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(12_000)])
    : AbortSignal.timeout(12_000);
  try {
    const boot = await fetcher(`${EMBED}/api/boot/${path}?key=${encodeURIComponent(API_KEY)}`, {
      headers: API_HEADERS,
      redirect: 'error',
      signal,
    });
    const root = await readJson(boot);
    const meta = root?.meta && typeof root.meta === 'object' && !Array.isArray(root.meta)
      ? root.meta as Record<string, unknown>
      : null;
    if (!meta || meta.unreleased === true || typeof meta.playbackToken !== 'string' || !meta.playbackToken || meta.playbackToken.length > 4096) return [];

    const responses = await Promise.all(PROVIDERS.map(async provider => {
      try {
        const url = `${EMBED}/api/source/${path}?token=${encodeURIComponent(meta.playbackToken as string)}&provider=${provider}`;
        const response = await fetcher(url, { headers: API_HEADERS, redirect: 'error', signal });
        return await readJson(response);
      } catch { return null; }
    }));
    const seen = new Set<string>();
    const candidates: RawStreamCandidate[] = [];
    for (const response of responses) {
      const streams = Array.isArray(response?.streams) ? response.streams.slice(0, 24) : [];
      for (const value of streams) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const stream = value as Record<string, unknown>;
        let rawUrl = typeof stream.url === 'string' ? stream.url.trim() : '';
        let headers: Record<string, string> = STREAM_HEADERS;
        if (rawUrl.startsWith('/api/')) rawUrl = new URL(rawUrl, `${EMBED}/`).href;
        else if (!rawUrl && typeof stream.proxyUrl === 'string') {
          try {
            const proxy = new URL(stream.proxyUrl);
            if (proxy.hostname.toLowerCase() === 'relay.vidrift.net') rawUrl = proxy.href;
            headers = { 'User-Agent': UA };
          } catch { /* invalid proxy URL */ }
        }
        if (!rawUrl || !isSafeUpstreamUrl(rawUrl) || seen.has(rawUrl)) continue;
        const type = typeOfStream(rawUrl, stream.type || stream.mimeType);
        if (!type) continue;
        seen.add(rawUrl);
        candidates.push({
          key: rawUrl,
          url: rawUrl,
          type,
          headers,
          quality: qualityOf(stream),
          qualityLabelsUnreliable: true,
          rank: 45 + candidates.length,
        });
        if (candidates.length >= 24) return candidates;
      }
    }
    return candidates;
  } catch { return []; }
}

export function createSource20Adapter(enabled: () => boolean, fetcher?: Fetcher): SourceAdapter {
  return {
    id: 'source-20',
    label: 'Zenix',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const candidates = await fetchFromZenix(query, fetcher);
      query.diag?.push({ adapter: 'source-20', lane: 'ZX', ok: candidates.length > 0, ms: Date.now() - started, detail: `candidates=${candidates.length}` });
      return { candidates: candidates.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'ZX' } : candidate) };
    },
  };
}
