/**
 * Xpass HLS discovery through its signed proxy endpoint (Source 13).
 * Xpass server names are not audio-language evidence; captions are ignored.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { candidateEvidence, verifyAndFilterCandidatesDetailed } from '../../src/sources/liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from '../../src/sources/types.js';

const API = 'https://freakyniki.elaxo.lol/';
const PROXY_HOST = 'freakyniki.elaxo.lol';
const PLAYER = 'https://player-4aq.pages.dev/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
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

/** Why an empty result is empty. Same vocabulary as source-5. */
export interface XpassOptions { trace?: string[] }

export async function fetchFromXpass(query: SourceQuery, options: XpassOptions = {}): Promise<RawStreamCandidate[]> {
  const trace = options.trace;
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
      redirect: 'manual',
      signal,
    });
    if (!response.ok) { trace?.push(`http=${response.status}`); await response.body?.cancel().catch(() => {}); return []; }
    const body = await readJson(response);
    if (!body || typeof body !== 'object' || Array.isArray(body)) { trace?.push('not-json'); return []; }
    const root = body as { type?: unknown; season?: unknown; episode?: unknown };
    if (typeof root.type === 'string') {
      const expected = query.type === 'movie' ? /^(movie|film)$/i : /^(tv|series|episode)$/i;
      if (!expected.test(root.type.trim())) { trace?.push(`wrong-type=${root.type.trim().slice(0, 12)}`); return []; }
    }
    if (query.type === 'tv' && ((root.season != null && String(root.season) !== String(season)) || (root.episode != null && String(root.episode) !== String(episode)))) {
      trace?.push(`wrong-episode=${root.season}/${root.episode}`); return [];
    }
    const streams = (body as { streams?: unknown }).streams;
    const rows = xpassCandidates(body);
    if (!rows.length) trace?.push(Array.isArray(streams) ? `streams=${streams.length}/0-usable` : 'no-streams-array');
    return rows;
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).name;
    trace?.push(code === 'TimeoutError' ? 'timeout' : code);
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
      const trace: string[] = [];
      const raw = await fetchFromXpass(query, { trace });
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter(candidate => !!candidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-13',
        lane: 'X',
        ok: candidates.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},reachable=${candidates.length}` +
          (trace.length ? ` ${[...new Set(trace)].slice(0, 4).join(' ')}` : ''),
      });
      return { candidates: candidates.map(candidate => query.diag
        ? { ...candidate, diagnosticLane: 'X' }
        : candidate) };
    },
  };
}
