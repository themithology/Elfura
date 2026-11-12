/**
 * VidZen / Vidme server adapter (Source 12).
 *
 * Resolves its short-lived API token from the title page and asks a bounded,
 * fixed set of provider servers for HLS only. Returned media must stay on the
 * provider's own /api/stream/ origin; no third-party relay or remote JS runs.
 * No audio labels are inferred from the server names.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://vidzen.fun';
const REFERER = `${SITE}/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const SERVERS = ['hyperion', 'mars', 'jupiter', 'venus', 'saturn', 'mercury', 'neptune', 'earth', 'uranus', 'pluto', 'helios'] as const;
const MAX_PAGE_BYTES = 768_000;
const MAX_JSON_BYTES = 128_000;
const MAX_CANDIDATES = 8;

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > maxBytes) {
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
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function extractVidZenToken(html: string): string | null {
  // The site's RSC payload escapes quotes as `\\"`; tolerate either raw or
  // escaped JSON without executing any page-provided JavaScript.
  const match = /\\?"apiToken\\?"\s*:\s*\\?"([\w.-]{8,4096})\\?"/.exec(html);
  return match?.[1] ?? null;
}

function watchPath(query: SourceQuery): string | null {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return null;
  if (query.type === 'movie') return `/movie/${query.tmdbId}`;
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1) return null;
  return `/tv/${query.tmdbId}/${season}/${episode}`;
}

function candidatesFromResponse(value: unknown, rank: number): RawStreamCandidate[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const sources = (value as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  const result: RawStreamCandidate[] = [];
  for (const source of sources.slice(0, 8)) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const row = source as { type?: unknown; url?: unknown };
    if (row.type !== 'hls' || typeof row.url !== 'string' || row.url.length > 4096) continue;
    try {
      const url = new URL(row.url, SITE);
      // This implementation's documented stream path is provider-hosted. Keep
      // the origin/path pinned rather than trusting arbitrary API URLs.
      if (url.origin !== SITE || !url.pathname.startsWith('/api/stream/') || !isSafeUpstreamUrl(url.href)) continue;
      const cleanUrl = url.href;
      result.push({
        key: cleanUrl,
        url: cleanUrl,
        type: 'hls',
        quality: 'auto',
        headers: { 'User-Agent': UA, Referer: REFERER },
        rank,
      });
    } catch { /* reject malformed URLs */ }
  }
  return result;
}

export async function fetchFromVidZen(query: SourceQuery): Promise<RawStreamCandidate[]> {
  const path = watchPath(query);
  if (!path) return [];
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(1800)])
    : AbortSignal.timeout(1800);
  const headers = { 'User-Agent': UA, Referer: REFERER, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' };
  try {
    const page = await fetch(`${SITE}${path}`, { headers, redirect: 'error', signal });
    const html = await readBoundedText(page, MAX_PAGE_BYTES);
    if (!html) return [];
    const token = extractVidZenToken(html);
    if (!token) return [];

    const responses = await Promise.all(SERVERS.map(async (server, rank) => {
      try {
        const endpoint = new URL('/api/sources', SITE);
        endpoint.searchParams.set('type', query.type);
        endpoint.searchParams.set('id', query.tmdbId);
        if (query.type === 'tv') {
          endpoint.searchParams.set('season', String(query.season ?? 1));
          endpoint.searchParams.set('episode', String(query.episode ?? 1));
        }
        endpoint.searchParams.set('server', server);
        endpoint.searchParams.set('token', token);
        const response = await fetch(endpoint, {
          headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json' },
          redirect: 'error',
          signal,
        });
        const text = await readBoundedText(response, MAX_JSON_BYTES);
        if (!text) return [];
        let json: unknown;
        try { json = JSON.parse(text) as unknown; } catch { return []; }
        return candidatesFromResponse(json, 12 + rank);
      } catch { return []; }
    }));

    const unique = new Map<string, RawStreamCandidate>();
    for (const candidate of responses.flat()) {
      if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
      if (unique.size >= MAX_CANDIDATES) break;
    }
    return [...unique.values()];
  } catch { return []; }
}

export function createSource12Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-12',
    label: 'Source 12',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const raw = await fetchFromVidZen(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter(candidate => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-12',
        lane: 'VZ',
        ok: candidates.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},reachable=${candidates.length}`,
      });
      return { candidates: candidates.map(candidate => query.diag
        ? { ...candidate, diagnosticLane: 'VZ' }
        : candidate) };
    },
  };
}
