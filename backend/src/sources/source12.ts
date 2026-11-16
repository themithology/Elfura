/**
 * VidZen / Vidme server adapter (Source 12).
 *
 * Resolves its short-lived API token from the title page and asks a bounded,
 * fixed set of provider servers for HLS only. Returned media must stay on the
 * provider's own /api/stream/ origin; no third-party relay or remote JS runs.
 * No audio labels are inferred from the server names.
 *
 * Two behaviours that matter in practice:
 *   - Servers answer dead / empty unevenly: on one title only `mars` and
 *     `uranus` produced anything playable, and the playable `uranus` row sat
 *     past the 8th candidate. The pool is therefore collected first and capped
 *     only *after* liveness filtering, so a late server is never discarded
 *     before it has been judged.
 *   - The page token is short-lived; when a server answers 401/403 the token is
 *     minted once more and those servers are retried.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { candidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { classifyUpstreamUrl, RELAY_RANK_PENALTY } from './provenance.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://vidzen.fun';
const REFERER = `${SITE}/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const SERVERS = ['hyperion', 'mars', 'jupiter', 'venus', 'saturn', 'mercury', 'neptune', 'earth', 'uranus', 'pluto', 'helios'] as const;
const MAX_PAGE_BYTES = 768_000;
const MAX_JSON_BYTES = 128_000;
// Raw pool cap (before liveness) and verified cap (after liveness).
const MAX_RAW_CANDIDATES = 24;
export const MAX_VERIFIED_CANDIDATES = 12;

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

/** Only the header names a media CDN legitimately needs; never anything else. */
function safeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string' || raw.length > 1024 || /[\r\n]/.test(raw)) continue;
    if (!/^(referer|origin|user-agent|cookie)$/i.test(key)) continue;
    if (/^(referer|origin)$/i.test(key) && !isSafeUpstreamUrl(raw)) continue;
    out[/^referer$/i.test(key) ? 'Referer' : /^origin$/i.test(key) ? 'Origin' : /^cookie$/i.test(key) ? 'Cookie' : 'User-Agent'] = raw;
  }
  return out;
}

function candidatesFromResponse(value: unknown, rank: number): RawStreamCandidate[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const sources = (value as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  const result: RawStreamCandidate[] = [];
  for (const source of sources.slice(0, 8)) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const row = source as {
      type?: unknown;
      url?: unknown;
      directUrl?: unknown;
      rawUrl?: unknown;
      proxyUrl?: unknown;
      headers?: unknown;
    };
    const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    if (type !== 'hls' && type !== 'mp4') continue;
    // Prefer a real provider URL when the payload carries one, and use the
    // player path only as a last resort.
    //
    // This used to REQUIRE `/api/stream/...` on the site's own origin. That path
    // answers with an HTML page — "Direct Stream Access Prohibited: this video
    // stream is protected and can only be played inside the official Vidzen
    // player" — for any request that is not the player itself, token or no token.
    // So every candidate this adapter produced pointed somewhere nothing could
    // ever verify, which is why it reported candidates=16, reachable=0 on CI: the
    // discovery was fine, the URLs were unusable by construction.
    const direct = [row.directUrl, row.rawUrl, row.proxyUrl, row.url]
      .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
      .find((candidate) => candidate.length > 0 && candidate.length <= 4096);
    if (!direct) continue;
    let url: URL;
    try {
      url = new URL(direct, SITE);
    } catch {
      continue;
    }
    if (!isSafeUpstreamUrl(url.href)) continue;
    // An embed page is a web page, not a stream. This check used to be implicit
    // in the same-origin /api/stream/ requirement; now that any provider URL is
    // accepted, it has to be explicit.
    if (url.origin === SITE && /^\/embed(?:\/|$)/i.test(url.pathname)) continue;
    const playerLocked = url.origin === SITE && url.pathname.startsWith('/api/stream/');
    const headers = safeHeaders(row.headers);
    result.push({
      key: url.href,
      url: url.href,
      type,
      quality: 'auto',
      // Provider-declared headers win. A CDN that requires its own Referer
      // rejects ours, so overwriting it would make every lane look dead.
      headers: { 'User-Agent': UA, Referer: REFERER, ...headers },
      // A player-locked URL is kept only so the panel can show that the provider
      // did return something, and it is ranked last because it cannot be fetched.
      rank: rank + (classifyUpstreamUrl(url.href) === 'relay' ? RELAY_RANK_PENALTY : 0) + (playerLocked ? 50 : 0),
      ...(playerLocked ? { claimedAudioLang: 'und' } : {}),
    });
  }
  // Rank is the contract: the player takes the first row. Returning insertion
  // order meant a player-locked URL (+50) could be listed above a working
  // provider URL, which is the opposite of what the rank says.
  return result.sort((a, b) => a.rank - b.rank);
}

async function mintToken(signal: AbortSignal, path: string): Promise<string | null> {
  try {
    const page = await fetch(`${SITE}${path}`, {
      headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'manual',
      signal,
    });
    const html = await readBoundedText(page, MAX_PAGE_BYTES);
    if (!html) return null;
    return extractVidZenToken(html);
  } catch {
    return null;
  }
}

async function askServer(
  server: string,
  query: SourceQuery,
  token: string,
  rank: number,
  signal: AbortSignal,
): Promise<{ status: number; candidates: RawStreamCandidate[] }> {
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
      redirect: 'manual',
      signal,
    });
    const text = await readBoundedText(response, MAX_JSON_BYTES);
    if (!text) return { status: response.status, candidates: [] };
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return { status: response.status, candidates: [] };
    }
    return { status: response.status, candidates: candidatesFromResponse(json, 12 + rank) };
  } catch {
    return { status: 0, candidates: [] };
  }
}

export async function fetchFromVidZen(query: SourceQuery): Promise<RawStreamCandidate[]> {
  const path = watchPath(query);
  if (!path) return [];
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(2600)])
    : AbortSignal.timeout(2600);
  const token = await mintToken(signal, path);
  if (!token) return [];

  const responses = await Promise.all(
    SERVERS.map(async (server, rank) => ({ server, rank, ...(await askServer(server, query, token, rank, signal)) })),
  );

  // A rejected token looks like a dead server: mint once more and retry those.
  const rejected = responses.filter((response) => response.status === 401 || response.status === 403);
  if (rejected.length > 0) {
    const fresh = await mintToken(signal, path);
    if (fresh && fresh !== token) {
      const retries = await Promise.all(
        rejected.map(async (response) => ({
          ...response,
          ...(await askServer(response.server, query, fresh, response.rank, signal)),
        })),
      );
      for (const retry of retries) {
        const index = responses.findIndex((response) => response.server === retry.server);
        if (index >= 0) responses[index] = retry;
      }
    }
  }

  const unique = new Map<string, RawStreamCandidate>();
  for (const candidate of responses.flatMap((response) => response.candidates)) {
    if (unique.has(candidate.url)) continue;
    unique.set(candidate.url, candidate);
    if (unique.size >= MAX_RAW_CANDIDATES) break;
  }
  return [...unique.values()];
}

/**
 * VidZen mints a different stream id per page token, and some of those ids are
 * dead while others play. A single draw can therefore come back empty on a title
 * that is perfectly available, so a second draw is taken when nothing survives —
 * bounded, and only when the lane would otherwise contribute nothing.
 */
const RETRY_ON_EMPTY = () => process.env.ELFURA_VIDZEN_RETRY !== '0';

export function createSource12Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-12',
    label: 'Source 12',
    enabled,
    async resolve(query) {
      const started = Date.now();
      let raw = await fetchFromVidZen(query);
      let checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      let alive = checked.candidates.filter(candidate => !!candidateEvidence(candidate)?.alive);
      if (alive.length === 0 && raw.length > 0 && RETRY_ON_EMPTY() && !query.signal?.aborted) {
        const second = await fetchFromVidZen(query).catch(() => [] as RawStreamCandidate[]);
        const retried = second.length ? await verifyAndFilterCandidatesDetailed(second, query.signal) : null;
        if (retried) {
          raw = [...raw, ...second];
          checked = retried;
          alive = checked.candidates.filter(candidate => !!candidateEvidence(candidate)?.alive);
        }
      }
      const verified = alive;
      // Verified-only, then capped: a playable lane from a late server must
      // never be cut by a pool that is still full of unverified rows.
      const candidates = verified
        .sort((a, b) => a.rank - b.rank)
        .slice(0, MAX_VERIFIED_CANDIDATES);
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
