/**
 * Elfura Backend — Source 24 Adapter (VidLink)
 * ============================================
 * A real JSON API, which is the only kind of source worth adding: no HTML to
 * scrape, no browser, no per-redesign maintenance.
 *
 * Measured before writing this (GitHub-runner probe):
 *   https://vidlink.pro/api/b/movie/<id>   HTTP 200  application/json
 *   https://enc-dec.app/api/enc-vidlink?text=<id>   HTTP 200  {status,result}
 *
 * The one non-obvious part: `/api/b/...` does not take a TMDB id. It takes an
 * ENCRYPTED token. Generate the public web-client token locally; if that
 * protocol changes, retain enc-dec.app as a fallback. A successful API reply
 * is not proof that its media can be played.
 */

import nacl from 'tweetnacl';
import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import type { RawSourceResult, RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** Encrypted-token service. Separate host, so it fails independently. */
const ENC_DEC_ORIGIN = 'https://enc-dec.app';

// Public web-player protocol constant; may rotate. Protocol independently
// observed by Nyumat/tvtvme (MIT), and checked against enc-dec and VidLink in
// .github/workflows/research-local-vidlink.yml. This is not an operator secret.
const VIDLINK_KEY = Buffer.from('c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd', 'hex');
export function localVidlinkToken(tmdbId: string, nowMs = Date.now()): string | null {
  if (!/^\d{1,12}$/.test(tmdbId)) return null;
  const id = Buffer.from(tmdbId, 'utf8');
  const message = Buffer.alloc(id.length + 8);
  id.copy(message);
  message.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000) + 480), id.length);
  const nonce = new Uint8Array(24);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(nacl.secretbox(message, nonce, VIDLINK_KEY))]).toString('base64url');
}

/** Only heights we will advertise; anything else falls back to 'auto'. */
function qualityLabel(key: string): string {
  const m = String(key).match(/(\d{3,4})/);
  if (!m) return 'auto';
  const height = Number(m[1]);
  if (height >= 2160) return '2160p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height >= 360) return '360p';
  return 'auto';
}

function inferType(url: string): 'hls' | 'dash' | 'mp4' {
  if (/\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  return 'mp4';
}

export function createSource24Adapter(
  cfg: BackendConfig['source24'],
): SourceAdapter {
  const apiBase = cfg.origin.replace(/\/+$/, '');
  /**
   * The site origin, which is NOT the API base.
   *
   * `cfg.origin` points at `https://vidlink.pro/api/b`, and using it as the
   * Referer/Origin sends `https://vidlink.pro/api/b` as the origin — which the
   * API treats as a foreign caller. It must be `https://vidlink.pro`. Derive it
   * from the API URL rather than hardcoding, so an override of the origin still
   * produces a correct referer.
   */
  const siteOrigin = (() => {
    try {
      return new URL(apiBase).origin;
    } catch {
      return apiBase;
    }
  })();

  /** TMDB id -> the token `/api/b` expects. Returns null on any failure. */
  async function encryptId(tmdbId: string, signal: AbortSignal): Promise<string | null> {
    try {
      const res = await fetch(
        `${ENC_DEC_ORIGIN}/api/enc-vidlink?text=${encodeURIComponent(tmdbId)}`,
        {
          headers: { Accept: 'application/json,*/*', 'User-Agent': BROWSER_UA },
          signal,
        },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: unknown; status?: unknown };
      return typeof body.result === 'string' && body.result.length > 0 ? body.result : null;
    } catch {
      return null;
    }
  }

  return {
    id: 'source-24',
    label: 'Source 24',

    enabled: () => cfg.enabled,

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      if (!cfg.enabled) return { candidates: [] };

      const startedAt = Date.now();
      const diag = (ok: boolean, detail: string) =>
        query.diag?.push({
          adapter: 'source-24',
          lane: 'V',
          ok,
          ms: Date.now() - startedAt,
          detail,
        });

      const signal = query.signal
        ? AbortSignal.any([query.signal, AbortSignal.timeout(cfg.timeoutMs)])
        : AbortSignal.timeout(cfg.timeoutMs);

      try {
        // `/api/b` is picky about Origin/Referer; both are its own origin.
        const headers = {
          Accept: 'application/json,*/*',
          'User-Agent': BROWSER_UA,
          Referer: `${siteOrigin}/`,
          Origin: siteOrigin,
          Connection: 'keep-alive',
        };

        type Payload = {
          stream?: { playlist?: unknown; qualities?: Record<string, { url?: unknown }> };
          url?: unknown;
          streams?: { url?: unknown; quality?: unknown }[];
        };
        const request = async (token: string): Promise<{ payload?: Payload; status?: number }> => {
          const path = query.type === 'tv'
            ? `/tv/${encodeURIComponent(token)}/${query.season ?? 1}/${query.episode ?? 1}`
            : `/movie/${encodeURIComponent(token)}`;
          const res = await fetch(`${apiBase}${path}`, { headers, signal });
          if (!res.ok) { await res.body?.cancel().catch(() => {}); return { status: res.status }; }
          const payload = await res.json() as Payload | null;
          return { payload: payload && typeof payload === 'object' ? payload : undefined, status: res.status };
        };
        const containsUrls = (payload?: Payload): boolean => !!payload && (
          typeof payload.stream?.playlist === 'string' || typeof payload.url === 'string' ||
          Object.values(payload.stream?.qualities ?? {}).some(value => typeof value === 'string' || typeof value?.url === 'string') ||
          (Array.isArray(payload.streams) && payload.streams.some(row => typeof row?.url === 'string'))
        );
        const local = localVidlinkToken(query.tmdbId);
        let response: { payload?: Payload; status?: number } = {};
        if (local) {
          try { response = await request(local); } catch { /* try the established token service */ }
        }
        // 429/5xx is an outage, not evidence the token is wrong. Avoid
        // amplifying rate limits. For other failures or empty payloads keep the
        // existing service as a compatibility fallback if our key rotates.
        if (!containsUrls(response.payload) && !signal.aborted && response.status !== 429 && !(response.status && response.status >= 500)) {
          const remote = await encryptId(query.tmdbId, signal);
          if (remote) response = await request(remote);
        }
        if (!response.payload) {
          diag(false, response.status ? `vidlink http=${response.status}` : 'encrypt-failed');
          return { candidates: [] };
        }
        const payload = response.payload as {
          stream?: {
            playlist?: unknown;
            qualities?: Record<string, { url?: unknown }>;
          };
          url?: unknown;
          streams?: { url?: unknown; quality?: unknown }[];
        };

        const mediaHeaders = { 'User-Agent': BROWSER_UA, Referer: `${siteOrigin}/`, Origin: siteOrigin };
        const out: RawStreamCandidate[] = [];
        const seen = new Set<string>();

        const push = (rawUrl: unknown, quality: string) => {
          if (typeof rawUrl !== 'string' || !rawUrl) return;
          if (!isSafeUpstreamUrl(rawUrl)) return;
          if (seen.has(rawUrl)) return;
          seen.add(rawUrl);
          out.push({
            key: rawUrl,
            url: rawUrl,
            type: inferType(rawUrl),
            quality,
            rank: cfg.rank,
            headers: mediaHeaders,
          });
        };

        // Highest quality first: a ladder is more useful than 'auto'.
        //
        // A quality entry is normally `{url}`, but the API has been seen to put
        // a bare URL string there instead. Reading only `value.url` then drops
        // it silently — the provider returns three renditions and we report
        // one, with no error anywhere. Accept both shapes.
        for (const [key, value] of Object.entries(payload.stream?.qualities ?? {})) {
          const url = typeof value === 'string' ? value : (value as { url?: unknown })?.url;
          push(url, qualityLabel(key));
        }
        // The playlist is the adaptive master and is usually the best option.
        push(payload.stream?.playlist, 'auto');
        push(payload.url, 'auto');
        for (const row of payload.streams ?? []) {
          push(row?.url, qualityLabel(String(row?.quality ?? '')));
        }

        diag(
          out.length > 0,
          out.length > 0 ? `vidlink candidates=${out.length}` : 'vidlink no-playable-url',
        );
        return { candidates: out };
      } catch (error) {
        diag(false, `vidlink ${(error as Error).name}`);
        return { candidates: [] };
      }
    },
  };
}
