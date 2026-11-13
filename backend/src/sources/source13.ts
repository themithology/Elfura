/**
 * Xpass HLS discovery through its signed proxy endpoint (Source 13).
 * Xpass server names are not audio-language evidence; captions are ignored.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://freakyniki.elaxo.lol/';
const PROXY_HOST = 'freakyniki.elaxo.lol';
const PLAYER = 'https://player-4aq.pages.dev/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const TARGET_HOSTS = new Set(['vip.1x2.space', 'tik.1x2.space', 'suprox.xpass.top']);
const MAX_JSON_BYTES = 128_000;
const MAX_ROWS = 8;
const MAX_CANDIDATES = 4;

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

function validProxyUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const proxy = new URL(raw);
    if (proxy.protocol !== 'https:' || proxy.hostname !== PROXY_HOST || proxy.pathname !== '/proxyv2' || proxy.username || proxy.password) return null;
    if (proxy.searchParams.get('provider') !== 'xpass' || !/^[a-f0-9]{64}$/i.test(proxy.searchParams.get('sig') || '')) return null;
    const targetRaw = proxy.searchParams.get('url');
    if (!targetRaw || targetRaw.length > 4096) return null;
    const target = new URL(targetRaw);
    if (target.protocol !== 'https:' || !TARGET_HOSTS.has(target.hostname) || target.username || target.password || !/\.m3u8$/i.test(target.pathname)) return null;
    return isSafeUpstreamUrl(proxy.href) ? proxy.href : null;
  } catch {
    return null;
  }
}

export function xpassCandidates(body: unknown): RawStreamCandidate[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const streams = (body as { streams?: unknown }).streams;
  if (!Array.isArray(streams)) return [];
  const out: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  for (const row of streams.slice(0, MAX_ROWS)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const stream = row as { format?: unknown; url?: unknown };
    if (typeof stream.format !== 'string' || !/^hls$/i.test(stream.format.trim())) continue;
    const url = validProxyUrl(stream.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      key: url,
      url,
      type: 'hls',
      quality: 'auto',
      headers: { 'User-Agent': UA, Referer: PLAYER },
      rank: 30 + out.length,
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export async function fetchFromXpass(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie', 'tv'].includes(query.type)) return [];
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) return [];

  const endpoint = new URL(API);
  endpoint.searchParams.set('tmdb_id', query.tmdbId);
  if (query.type === 'tv') {
    endpoint.searchParams.set('season', String(season));
    endpoint.searchParams.set('episode', String(episode));
  }
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(2200)])
    : AbortSignal.timeout(2200);
  try {
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': UA, Referer: PLAYER, Accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    const body = await readJson(response);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    const root = body as { type?: unknown; season?: unknown; episode?: unknown };
    if (typeof root.type === 'string') {
      const expected = query.type === 'movie' ? /^(movie|film)$/i : /^(tv|series|episode)$/i;
      if (!expected.test(root.type.trim())) return [];
    }
    if (query.type === 'tv' && ((root.season != null && String(root.season) !== String(season)) || (root.episode != null && String(root.episode) !== String(episode)))) return [];
    return xpassCandidates(body);
  } catch {
    return [];
  }
}

export function createSource13Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-13',
    label: 'Source 13',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const raw = await fetchFromXpass(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter(candidate => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-13',
        lane: 'X',
        ok: candidates.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},reachable=${candidates.length}`,
      });
      return { candidates: candidates.map(candidate => query.diag
        ? { ...candidate, diagnosticLane: 'X' }
        : candidate) };
    },
  };
}
