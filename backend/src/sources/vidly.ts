/**
 * Source 4 — vidly.
 *
 * The media URL is embedded in the watch page. No token, no decryption, no
 * third-party relay:
 *
 *   GET /watch/movie/<tmdb>[/<slug>]        → HTML carrying one manifest URL
 *   GET /watch/tv/<tmdb>/<season>/<episode> → same
 *
 *   <video data-src="https://img.rousav.tech/media/<id>/index.m3u8">  (or gzip.)
 *
 * WHY THIS LANE WAS ALMOST MISSED
 * -------------------------------
 * Every measurement in this repo of vidly before this adapter looked at its
 * SUBTITLE index, and the retired subtitle adapter explicitly refused its stream
 * API, writing down that streams required "a per-session token scraped from the
 * page HTML" plus "a hand-rolled xorshift keystream". Both statements are true
 * of `/api/sources` — and both are irrelevant, because the media URL is already
 * in the page markup. `/api/sources` answers 403 to a runner; the stream plays
 * anyway. Reading an endpoint's gate as the stream's gate cost this board a lane.
 *
 * The same document also claimed vidly's streams were "the same upstreams
 * already reachable through citadel and the Workers bridge". That was never
 * checked and is false: `rousav.tech` appears in no other source's media hosts.
 *
 * MEASURED BY THE CONTRACT (GitHub runner, 2026-11-25)
 * ---------------------------------------------------
 *   movie/550      img.rousav.tech    master 200 → variant 200 → segment 206, 128 KiB
 *   movie/27205    img.rousav.tech    same; master declares TYPE=AUDIO LANGUAGE="eng","hin"
 *   tv/1399/1/1    gzip.rousav.tech   same; master declares "hin","tel","eng","tam","kan"
 *   tv/46260/1/1   bridge             rows on dash-hls-bridge.john1mc.workers.dev → 502
 *
 * The multi-audio evidence is the reason this lane is worth its timeout: those
 * are real `#EXT-X-MEDIA` renditions, not provider labels. The registry's own
 * liveness probe harvests them from the master, so this adapter reports no
 * `availableAudioLangs` of its own — it must not claim what it has not read.
 *
 * WHAT THIS ADAPTER REFUSES
 * -------------------------
 *   - any host that is not `img.rousav.tech` or `gzip.rousav.tech`. That is not a
 *     heuristic: those two are the only media hosts measured behind a working
 *     page. It excludes, by construction, the `dash-hls-bridge.john1mc.workers.dev`
 *     rows that the same pages sometimes embed — the third-party bridge this
 *     board refuses, which answers 502 — and any new relay that appears later.
 *   - embeds and bare pages: a URL without a manifest extension is not a stream.
 *   - non-HTTPS, credentialed, or oversized HTML.
 *
 * The segment's own size rule is Source 1's and applies unchanged: candidates
 * are ranked on measured bytes after the probe, never on the label in the URL.
 */
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';
import { sourceEnv } from './index.js';

const DEFAULT_ORIGIN = 'https://vidly.pro';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/**
 * The only two media hosts observed serving bytes. Measured, not guessed: a page
 * fetch on the runner returned exactly these, and the third host seen next to
 * them (`dash-hls-bridge.john1mc.workers.dev`) is a refused third-party bridge.
 */
const OWN_MEDIA_HOST = /^(?:img|gzip)\.rousav\.tech$/i;

/**
 * A watch page is ~50 KB of HTML. Anything vastly larger is not the page we
 * measured, and reading all of it would be unbounded work per resolve.
 */
const MAX_PAGE_BYTES = 2_000_000;
/**
 * MEASURED on runners 2026-11-25: page fetch for movie/550 answered in roughly
 * 1–2s including TLS. This is one HTML request per resolve, not an aggregation,
 * so the lane does not need an extended discovery budget and does not declare one.
 */
const PAGE_TIMEOUT_MS = 9000;

/** Manifest URLs already in the page markup. No decryption is involved. */
export function embeddedManifests(html: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi,
    /https?:\/\/[^\s"'<>\\]+?\.mpd[^\s"'<>\\]*/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      // The page embeds JSON-escaped URLs often enough that the literal text can
      // contain a trailing escape; strip it before validation.
      found.add(match[0].replace(/\\+$/, ''));
    }
  }
  return [...found];
}

/** Quality from the path, when the provider has already encoded it. */
export function qualityOf(url: string): string {
  const height = url.match(/\b(2160|1440|1080|720|480|360)p\b/i)?.[1];
  return height ? `${height}p` : 'auto';
}

/**
 * Embedded URLs → candidates, applying every refusal above.
 *
 * Exported because the refusals are the interesting part and deserve a test that
 * needs no network.
 */
export function vidlyCandidates(html: string, pageUrl: string): RawStreamCandidate[] {
  const out: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of embeddedManifests(html)) {
    if (out.length >= 8) break;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    // The allowlist IS the refusal rule. Everything else in this page belongs to
    // somebody else, including the bridge that 502s.
    if (!OWN_MEDIA_HOST.test(url.hostname)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const type = /\.mpd(?:[?#]|$)/i.test(url.href) ? 'dash' : 'hls';
    out.push({
      key: url.href,
      url: url.href,
      type,
      quality: qualityOf(url.href),
      // The page carries media for this title and nothing else; a single row is
      // the normal case. Rank by discovery order, and let measured bytes decide.
      rank: out.length,
      headers: { 'User-Agent': UA, Referer: pageUrl, Origin: DEFAULT_ORIGIN },
      // Scoping the whole relay to the measured media host means an HLS child
      // pointing anywhere else is refused by the proxy itself, not just here.
      restrictedOrigin: `https://${url.hostname}`,
    });
  }
  return out;
}

export interface VidlyOptions {
  origin?: string;
  /** Injected by tests; the real adapter uses global fetch. */
  fetchImpl?: typeof fetch;
}

export function createVidlyAdapter(options: VidlyOptions = {}): SourceAdapter {
  const env = sourceEnv();
  const origin = (options.origin ?? env.ELFURA_VIDLY_ORIGIN?.trim() ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: 'source-4',
    label: 'Source 4',
    enabled: () => (env.ELFURA_VIDLY_ENABLED ?? '1') !== '0',
    async resolve(query: SourceQuery) {
      if (!/^\d{1,12}$/.test(query.tmdbId)) return { candidates: [] };
      const isTv = query.type === 'tv';
      const season = isTv ? query.season ?? 1 : 0;
      const episode = isTv ? query.episode ?? 1 : 0;
      if (isTv && (!Number.isSafeInteger(episode) || episode < 1)) return { candidates: [] };

      // The site routes movies and episodes by different paths and both were
      // measured; building the wrong one is a 404, not an empty title.
      const path = isTv
        ? `/watch/tv/${query.tmdbId}/${season}/${episode}`
        : `/watch/movie/${query.tmdbId}`;
      const pageUrl = `${origin}${path}`;

      const local = new AbortController();
      const timer = setTimeout(() => local.abort(), PAGE_TIMEOUT_MS);
      let html: string;
      try {
        const response = await fetchImpl(pageUrl, {
          headers: { 'User-Agent': UA, Accept: 'text/html', Referer: `${origin}/` },
          redirect: 'follow',
          signal: query.signal ?? local.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { candidates: [] };
        }
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > MAX_PAGE_BYTES) {
          await response.body?.cancel().catch(() => {});
          return { candidates: [] };
        }
        html = await response.text();
        if (html.length > MAX_PAGE_BYTES) return { candidates: [] };
      } catch {
        return { candidates: [] };
      } finally {
        clearTimeout(timer);
      }

      return { candidates: vidlyCandidates(html, pageUrl) };
    },
  };
}
