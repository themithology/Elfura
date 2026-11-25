/**
 * ARCHIVED — never registered. Kept because the adapter is correct and the only
 * thing wrong with the source is somebody else's server.
 *
 * Measured on runners, 2026-11-25 (research/vidlink-verdict.md):
 *   /api/b accepted a locally minted token on all four titles — 3, 3, 4, 2 media
 *   URLs. The protocol is solved and no third party is in the path.
 *   Every media URL then answered 429 from nginx with a text/html body, on the
 *   first fetch of each title, and again after a 15-second wait. A bare request
 *   (no adapter headers) answers 428 Precondition Required — the host wants a
 *   Referer the adapter already sends, then refuses anyway. Zero bytes, four
 *   titles, three fetch strategies.
 *
 * So it cannot pass the contract gate, and separately it serves the same media
 * object as vidora (resource/a58dd00a… on movie/27205), which was never approved.
 * If that host ever serves datacenter IPs, restore this file and run
 * scripts/research/vidlink-bytes.mjs — it is one runner job from proof.
 *
 * Original header follows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Source 3 — vidlink.
 *
 *   GET /api/b/movie/<token>                    → { stream: { playlist, qualities }, streams[] }
 *   GET /api/b/tv/<token>/<season>/<episode>
 *
 * The one non-obvious thing: `/api/b` does not accept a TMDB id. It wants a
 * token it can open with a key that ships in its own public web player:
 *
 *   message = <tmdb id bytes> || uint64be(now_seconds + 480)
 *   token   = base64url( nonce[24] || nacl.secretbox(message, nonce, key) )
 *
 * That key is a public protocol constant, not an operator secret, and the token
 * is minted LOCALLY. The retired adapter used enc-dec.app as a convenience; this
 * one does not need it and never calls it. A third party in the critical path of
 * every resolve is a dependency this board does not want, so if the local token
 * is ever refused the lane reports itself unavailable rather than reaching out.
 *
 * The token carries its own 8-minute expiry, so it is minted per request and
 * never cached.
 */
import nacl from 'tweetnacl';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from '../../src/sources/types.js';
import { sourceEnv } from '../../src/sources/index.js';

const DEFAULT_API = 'https://vidlink.pro/api/b';
const DEFAULT_ORIGIN = 'https://vidlink.pro';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/**
 * Public web-player protocol constant. It is in the client bundle vidlink ships
 * to every browser; it is not a credential, and it can rotate. If it does, the
 * local token is refused and this lane says so — it does not fall back to a
 * third-party token service.
 */
const VIDLINK_KEY = Buffer.from(
  'c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd',
  'hex',
);

const MAX_CANDIDATES = 16;
const MAX_BODY_BYTES = 512_000;
const PROVIDER_TIMEOUT_MS = 6000;

/**
 * The token `/api/b` expects for one TMDB id.
 *
 * Exported because the correctness of this 20 lines is the entire source: if it
 * is wrong, everything downstream is a 400 and the lane looks dead.
 */
export function localToken(tmdbId: string, nowMs = Date.now()): string | null {
  if (!/^\d{1,12}$/.test(tmdbId)) return null;
  const id = Buffer.from(tmdbId, 'utf8');
  const message = Buffer.alloc(id.length + 8);
  id.copy(message);
  // Eight minutes out: long enough for a slow resolve, short enough that a
  // leaked token is worthless by the time anyone finds it.
  message.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000) + 480), id.length);
  // A real nonce, not a zero one. secretbox is only nonce-respecting if the
  // nonce actually varies: with 24 zero bytes, the same id and the same second
  // mint byte-identical tokens, so a captured token is replayable and two
  // concurrent requests are indistinguishable. The retired adapter used zeros,
  // which "works" against the API and is still wrong.
  const nonce = nacl.randomBytes(24);
  return Buffer.concat([
    Buffer.from(nonce),
    Buffer.from(nacl.secretbox(message, nonce, VIDLINK_KEY)),
  ]).toString('base64url');
}

/** Open a token again. Used by the tests to prove the round-trip. */
export function openToken(token: string): { tmdbId: string; expiresAt: number } | null {
  try {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length < 25) return null;
    const plain = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), VIDLINK_KEY);
    if (!plain) return null;
    const body = Buffer.from(plain);
    return {
      tmdbId: body.toString('utf8', 0, body.length - 8),
      expiresAt: Number(body.readBigUInt64BE(body.length - 8)),
    };
  } catch {
    return null;
  }
}

function qualityOf(key: string): string {
  const match = String(key).match(/(\d{3,4})/);
  if (!match) return 'auto';
  const height = Number(match[1]);
  if (height >= 2160) return '2160p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  return 'auto';
}

function typeOf(url: string): 'hls' | 'dash' | 'mp4' {
  if (/\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  return 'mp4';
}

interface Payload {
  stream?: { playlist?: unknown; qualities?: Record<string, { url?: unknown } | string> };
  url?: unknown;
  streams?: { url?: unknown; quality?: unknown }[];
}

/**
 * Read media URLs out of a payload.
 *
 * A quality entry is normally `{url}`, but the API has been seen to put a bare
 * URL string there. Reading only `value.url` silently drops it — the provider
 * returns three renditions and the board reports one, with no error anywhere.
 */
export function payloadCandidates(payload: Payload, headers: Record<string, string>): RawStreamCandidate[] {
  const out: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown, quality: string) => {
    if (typeof raw !== 'string' || !raw) return;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return;
    if (seen.has(url.href)) return;
    seen.add(url.href);
    out.push({
      key: url.href,
      fingerprint: url.href,
      url: url.href,
      type: typeOf(url.href),
      quality,
      headers,
      rank: out.length,
    });
  };

  for (const [key, value] of Object.entries(payload.stream?.qualities ?? {})) {
    const url = typeof value === 'string' ? value : (value as { url?: unknown })?.url;
    push(url, qualityOf(key));
  }
  // The playlist is the adaptive master and is usually the best option.
  push(payload.stream?.playlist, 'auto');
  push(payload.url, 'auto');
  for (const row of payload.streams ?? []) push(row?.url, qualityOf(String(row?.quality ?? '')));

  return out.slice(0, MAX_CANDIDATES);
}

async function readJson(response: Response, max: number): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'));
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function vidlinkUrl(
  query: Pick<SourceQuery, 'type' | 'tmdbId' | 'season' | 'episode'>,
  apiBase = DEFAULT_API,
  nowMs = Date.now(),
): string | null {
  const token = localToken(query.tmdbId, nowMs);
  if (!token) return null;
  const base = apiBase.replace(/\/+$/, '');
  return query.type === 'tv'
    ? `${base}/tv/${encodeURIComponent(token)}/${query.season ?? 1}/${query.episode ?? 1}`
    : `${base}/movie/${encodeURIComponent(token)}`;
}

export interface VidlinkOptions {
  apiBase?: string;
  origin?: string;
}

export function createVidlinkAdapter(options: VidlinkOptions = {}): SourceAdapter {
  const env = sourceEnv();
  const apiBase = options.apiBase ?? env.ELFURA_VIDLINK_API?.trim() ?? DEFAULT_API;
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const headers = {
    Accept: 'application/json,*/*',
    'User-Agent': UA,
    Referer: `${origin}/`,
    Origin: origin,
  };

  return {
    id: 'source-3',
    label: 'Source 3',
    enabled: () => (env.ELFURA_VIDLINK_ENABLED ?? '1') !== '0',

    async resolve(query: SourceQuery) {
      const url = vidlinkUrl(query, apiBase);
      if (!url) return { candidates: [] };
      const signal = query.signal ?? AbortSignal.timeout(PROVIDER_TIMEOUT_MS);

      try {
        const response = await fetch(url, { headers, signal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          // A refused token is the one failure worth naming precisely: it means
          // the protocol constant rotated, not that the title is missing.
          const hint = response.status === 400 || response.status === 401 || response.status === 403
            ? ' (token refused — the public protocol constant has rotated)'
            : '';
          console.warn(`[elfura-vidlink] ${query.type}/${query.tmdbId}: http=${response.status}${hint}`);
          return { candidates: [] };
        }
        const body = (await readJson(response, MAX_BODY_BYTES)) as Payload | null;
        const candidates = body ? payloadCandidates(body, headers) : [];
        if (candidates.length) {
          console.log(`[elfura-vidlink] ${query.type}/${query.tmdbId}: ${candidates.length} row(s)`);
        } else {
          console.warn(`[elfura-vidlink] ${query.type}/${query.tmdbId}: answered without media`);
        }
        return { candidates };
      } catch (error) {
        const reason = (error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.name ?? 'error';
        console.warn(`[elfura-vidlink] ${query.type}/${query.tmdbId}: ${reason}`);
        return { candidates: [] };
      }
    },
  };
}
