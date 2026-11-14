/**
 * Mapple direct HLS adapter, including TMDB-addressed TV anime episodes when
 * indexed upstream. Stream/server labels are never interpreted as audio
 * languages; languages are attached only when liveness reads them from the
 * returned HLS manifest.
 */
import { createHash } from 'node:crypto';
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://mapple.fun';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const PLAYER_API_KEY = 'mptv_sk_a8f29c4e7b3d1f'; // Public player protocol value, not a private credential.
const SERVERS = [
  { id: 'mapple', name: 'Mapple' },
  { id: 's1', name: 'Nexus' },
  { id: 's2', name: 'Cipher' },
  { id: 's3', name: 'Pulse' },
  { id: 's4', name: 'Vertex' },
  { id: 's10', name: 'Chimp' },
] as const;
const MAX_PAGE_BYTES = 768_000;
const MAX_JSON_BYTES = 96_000;
const MAX_POW_DIFFICULTY = 18;
const MAX_POW_ATTEMPTS = 300_000;
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
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await readBoundedText(response, MAX_JSON_BYTES);
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

export function extractMappleRequestToken(html: string): string | null {
  // The current player token is opaque (not guaranteed to be URL-safe); keep it
  // bounded and quote-delimited rather than assuming a restricted alphabet.
  const match = /window\.__REQUEST_TOKEN__\s*=\s*(["'])([^"'\r\n<>]{8,2048})\1/.exec(html);
  const token = match?.[2]?.trim();
  return token && token.length >= 8 ? token : null;
}

export async function solveMapplePow(
  challenge: string,
  difficulty: number,
  maxAttempts = MAX_POW_ATTEMPTS,
  signal?: AbortSignal,
): Promise<string | null> {
  if (typeof challenge !== 'string' || challenge.length < 1 || challenge.length > 512 ||
      !Number.isSafeInteger(difficulty) || difficulty < 0 || difficulty > MAX_POW_DIFFICULTY ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_POW_ATTEMPTS) return null;
  const fullZeroBytes = Math.floor(difficulty / 8);
  const remainingBits = difficulty % 8;
  const finalMask = remainingBits ? (0xff << (8 - remainingBits)) & 0xff : 0;
  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    if ((nonce & 4095) === 0) {
      if (signal?.aborted) return null;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const digest = createHash('sha256').update(challenge).update(String(nonce)).digest();
    let valid = true;
    for (let i = 0; i < fullZeroBytes; i++) if (digest[i] !== 0) { valid = false; break; }
    if (valid && (!finalMask || (digest[fullZeroBytes] & finalMask) === 0)) return String(nonce);
  }
  return null;
}

function pagePath(query: SourceQuery): string | null {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return null;
  if (query.type === 'movie') return `/watch/movie/${query.tmdbId}`;
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1) return null;
  return `/watch/tv/${query.tmdbId}-${season}-${episode}`;
}

function mappleCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') || ''];
  const cookies = new Set<string>();
  for (const line of setCookies) {
    for (const match of line.matchAll(/(_mapple_site(?:_partitioned)?=[^;,\s]+)/gi)) cookies.add(match[1]);
  }
  return [...cookies].join('; ').slice(0, 4096);
}

function hlsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const url = new URL(raw, SITE);
    if (!isSafeUpstreamUrl(url.href) || url.username || url.password) return null;
    if (!/\.m3u8$/i.test(url.pathname) && url.searchParams.get('format') !== '.m3u8') return null;
    return url.href;
  } catch {
    return null;
  }
}

async function solvePlaybackInit(
  query: SourceQuery,
  mediaType: 'movie' | 'tv',
  requestToken: string,
  pageUrl: string,
  cookie: string,
  signal: AbortSignal,
): Promise<string | null> {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Referer: pageUrl,
    Origin: SITE,
    ...(cookie ? { Cookie: cookie } : {}),
  };
  const body = {
    mediaId: query.tmdbId,
    mediaType,
    requestToken,
  };
  const first = await fetch(`${SITE}/api/playback-init`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal,
  });
  const firstData = await readJson(first);
  if (!firstData || typeof firstData !== 'object' || Array.isArray(firstData)) return null;
  const firstRecord = firstData as { token?: unknown; requiresPow?: unknown; pow?: unknown };
  if (typeof firstRecord.token === 'string' && firstRecord.token.length <= 4096) return firstRecord.token;
  if (firstRecord.requiresPow !== true || !firstRecord.pow || typeof firstRecord.pow !== 'object' || Array.isArray(firstRecord.pow)) return null;
  const pow = firstRecord.pow as { challenge?: unknown; difficulty?: unknown; challengeId?: unknown };
  if (typeof pow.challenge !== 'string' || typeof pow.difficulty !== 'number' ||
      (typeof pow.challengeId !== 'string' && typeof pow.challengeId !== 'number')) return null;
  const nonce = await solveMapplePow(pow.challenge, pow.difficulty, MAX_POW_ATTEMPTS, signal);
  if (nonce === null) return null;
  const second = await fetch(`${SITE}/api/playback-init`, {
    method: 'POST', headers, redirect: 'error', signal,
    body: JSON.stringify({ ...body, pow: { challengeId: pow.challengeId, nonce } }),
  });
  const secondData = await readJson(second);
  if (!secondData || typeof secondData !== 'object' || Array.isArray(secondData)) return null;
  const token = (secondData as { token?: unknown }).token;
  return typeof token === 'string' && token.length <= 4096 ? token : null;
}

async function serverCandidate(
  server: typeof SERVERS[number],
  query: SourceQuery,
  mediaType: 'movie' | 'tv',
  pageUrl: string,
  requestToken: string,
  streamToken: string,
  cookie: string,
  signal: AbortSignal,
  rank: number,
): Promise<RawStreamCandidate | null> {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Referer: pageUrl,
    Origin: SITE,
    ...(cookie ? { Cookie: cookie } : {}),
  };
  const encryptResponse = await fetch(`${SITE}/api/encrypt`, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal,
    body: JSON.stringify({ data: {
      mediaId: query.tmdbId,
      mediaType,
      tv_slug: mediaType === 'tv' ? `${query.season ?? 1}-${query.episode ?? 1}` : '',
      source: server.id,
      apikey: PLAYER_API_KEY,
    } }),
  });
  const encryptData = await readJson(encryptResponse);
  if (!encryptData || typeof encryptData !== 'object' || Array.isArray(encryptData)) return null;
  const encrypted = (encryptData as { encrypted?: unknown }).encrypted;
  if (typeof encrypted !== 'string' || encrypted.length < 8 || encrypted.length > 8192) return null;
  const endpoint = new URL('/api/stream-encrypted', SITE);
  endpoint.searchParams.set('data', encrypted);
  endpoint.searchParams.set('requestToken', requestToken);
  endpoint.searchParams.set('token', streamToken);
  const streamResponse = await fetch(endpoint, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: pageUrl, Origin: SITE, ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'error',
    signal,
  });
  const streamData = await readJson(streamResponse);
  if (!streamData || typeof streamData !== 'object' || Array.isArray(streamData)) return null;
  const root = streamData as { success?: unknown; data?: unknown };
  if (root.success !== true || !root.data || typeof root.data !== 'object' || Array.isArray(root.data)) return null;
  const rawUrl = (root.data as { stream_url?: unknown }).stream_url;
  const url = hlsUrl(rawUrl);
  if (!url) return null;
  return {
    key: url,
    url,
    type: 'hls',
    quality: 'auto',
    headers: { 'User-Agent': UA, Referer: `${SITE}/`, Origin: SITE },
    rank: 35 + rank,
  };
}

export async function fetchFromMapple(query: SourceQuery): Promise<RawStreamCandidate[]> {
  const path = pagePath(query);
  if (!path) return [];
  const mediaType = query.type;
  const pageUrl = `${SITE}${path}`;
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(4200)])
    : AbortSignal.timeout(4200);
  try {
    const pageResponse = await fetch(pageUrl, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', Referer: `${SITE}/` },
      redirect: 'error',
      signal,
    });
    const html = await readBoundedText(pageResponse, MAX_PAGE_BYTES);
    if (!html) return [];
    const requestToken = extractMappleRequestToken(html);
    if (!requestToken) return [];
    const cookie = mappleCookies(pageResponse);
    const streamToken = await solvePlaybackInit(query, mediaType, requestToken, pageUrl, cookie, signal);
    if (!streamToken) return [];
    const results = await Promise.all(SERVERS.map((server, index) => serverCandidate(
      server, query, mediaType, pageUrl, requestToken, streamToken, cookie, signal, index,
    ).catch(() => null)));
    const unique = new Map<string, RawStreamCandidate>();
    for (const candidate of results) {
      if (!candidate || unique.has(candidate.url)) continue;
      unique.set(candidate.url, candidate);
      if (unique.size >= MAX_CANDIDATES) break;
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

export function createSource15Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-15',
    label: 'Source 15',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const raw = await fetchFromMapple(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter(candidate => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-15',
        lane: 'M',
        ok: candidates.length > 0,
        ms: Date.now() - started,
        detail: `hlsCandidates=${raw.length},manifestReachable=${candidates.length}`,
      });
      return { candidates: candidates.map(candidate => query.diag
        ? { ...candidate, diagnosticLane: 'M' }
        : candidate) };
    },
  };
}
