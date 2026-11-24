/**
 * Watchout catalogue lane — TMDB-keyed HLS masters (Source 21)
 * ===========================================================
 * Vidout (https://vidout.pages.dev) is only a player shell; the streams it
 * plays come from a public, continuously updated catalogue keyed by TMDB id:
 *
 *   GET /hls/movie/<tmdbId>            -> "https://<cdn>/.../master.txt"
 *   GET /hls/tv/<tmdbId>/S<season>.json -> { "<episode>": "https://<cdn>/.../master.txt" }
 *
 * The catalogue lives in a git repository that is rewritten every few minutes,
 * so it is read through a CDN mirror first (jsDelivr caches it and has no
 * per-IP limit) and falls back to the raw origin. Never scraped from the player
 * page, never from a browser.
 *
 * The masters are real multi-audio HLS: an `#EXT-X-MEDIA:TYPE=AUDIO` group with
 * per-language renditions (Hindi, Tamil, Telugu, English on the samples read),
 * so the shared liveness probe reports true audio languages instead of claims.
 *
 * Everything stays server-side: the browser receives only `/api/proxy?u=…`
 * tickets. Zero disk, two bounded requests at most, no credentials.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { candidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { classifyUpstreamUrl, RELAY_RANK_PENALTY } from './provenance.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

/** CDN mirror first: cached at the edge, no per-IP rate limit. Raw git is the fallback. */
const CATALOG_MIRRORS = [
  'https://cdn.jsdelivr.net/gh/Watchout2025/api@main',
  'https://raw.githubusercontent.com/Watchout2025/api/main',
] as const;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MAX_CATALOG_BYTES = 128 * 1024;
/**
 * The media CDNs serve 404 to a bare request and a 200 master only when the
 * player origin is presented (verified against the live hosts: plain UA → 404
 * text/html, with this referer → 200 application/vnd.apple.mpegurl). The header
 * rides on the candidate, so the liveness probe and the relay both send it.
 */
const PLAYER_ORIGIN = 'https://vidout.pages.dev';
const FETCH_TIMEOUT_MS = 2600;

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Only https CDN masters are accepted; javascript:/data:/private hosts never are. */
function acceptMasterUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!/^https:\/\//i.test(value)) return null;
  if (value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (!isSafeUpstreamUrl(parsed.href)) return null;
    if (!/\.(?:txt|m3u8)(?:\?|$)/i.test(parsed.pathname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function candidateFrom(url: string, key: string, rank: number): RawStreamCandidate {
  return {
    key,
    fingerprint: key,
    url,
    type: 'hls',
    quality: 'auto',
    headers: {
      'User-Agent': UA,
      Referer: `${PLAYER_ORIGIN}/`,
      Origin: PLAYER_ORIGIN,
    },
    rank: rank + (classifyUpstreamUrl(url) === 'relay' ? RELAY_RANK_PENALTY : 0),
  };
}

/** Parse the catalogue body: a bare URL (movie) or an episode map (season file). */
export function watchoutCandidatesFrom(
  body: string,
  kind: 'movie' | 'tv',
  episode: number,
  keyPrefix: string,
): RawStreamCandidate[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  if (kind === 'movie' || !trimmed.startsWith('{')) {
    const url = acceptMasterUrl(trimmed);
    return url ? [candidateFrom(url, `${keyPrefix}:movie`, 62)] : [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const row = (parsed as Record<string, unknown>)[String(episode)];
  const url = acceptMasterUrl(row);
  return url ? [candidateFrom(url, `${keyPrefix}:e${episode}`, 60)] : [];
}

function catalogPath(query: SourceQuery, season: number, episode: number): string | null {
  if (!/^\d{1,9}$/.test(query.tmdbId)) return null;
  if (query.type === 'movie') return `/hls/movie/${query.tmdbId}`;
  if (!Number.isSafeInteger(season) || season < 0 || season > 60) return null;
  if (!Number.isSafeInteger(episode) || episode < 1) return null;
  return `/hls/tv/${query.tmdbId}/S${season}.json`;
}

export async function fetchFromWatchout(query: SourceQuery): Promise<RawStreamCandidate[]> {
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  const path = catalogPath(query, season, episode);
  if (!path) return [];
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (const mirror of CATALOG_MIRRORS) {
    try {
      const response = await fetch(`${mirror}${path}`, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/plain, application/json',
          Referer: `${PLAYER_ORIGIN}/`,
          Origin: PLAYER_ORIGIN,
        },
        redirect: 'follow',
        signal,
      });
      const body = await readBounded(response, MAX_CATALOG_BYTES);
      if (!body) continue;
      const candidates = watchoutCandidatesFrom(
        body,
        query.type,
        episode,
        `watchout:${query.type}:${query.tmdbId}:${season}:${episode}`,
      );
      if (candidates.length) return candidates;
    } catch {
      /* try the next mirror */
    }
  }
  return [];
}

export function createSource21Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-21',
    label: 'Source 21',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const raw = await fetchFromWatchout(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const usable = checked.candidates.filter((candidate) => !!candidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-21',
        lane: 'W',
        ok: usable.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},reachable=${usable.length}`,
      });
      return {
        candidates: usable.map((candidate) =>
          query.diag ? { ...candidate, diagnosticLane: 'W' } : candidate,
        ),
      };
    },
  };
}
