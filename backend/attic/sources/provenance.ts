/**
 * Elfura Backend — Upstream provenance classification
 * ===================================================
 * Some providers hand back a proxy front (a Cloudflare Worker, a `prx-*` edge,
 * a CORS proxy) instead of the CDN object itself. Those streams still play, but
 * every byte then depends on someone else's relay, so they must never outrank a
 * stream served by the origin CDN — and an adapter should not present a relay as
 * if it were a direct source.
 *
 * This is a pure hostname heuristic used for **ranking and diagnostics only**.
 * It never blocks a candidate on its own: liveness still decides playability.
 */

const RELAY_HOST_PATTERNS: RegExp[] = [
  /\.workers\.dev$/i,
  /workerscloud/i,
  /\.pages\.dev$/i,
  /\.vercel\.app$/i,
  /\.netlify\.app$/i,
  /\.deno\.dev$/i,
  /(?:^|\.)cors\./i,
  /(?:^|\.)proxy[-.]/i,
  /(?:^|\.)relay[-.]/i,
  /(?:^|\.)mirror[-.]/i,
  /^prx[-.]/i,
];

export type UpstreamClass = 'direct' | 'relay';

/** Classify a hostname as a direct CDN edge or a third-party relay/proxy front. */
export function classifyUpstreamHost(hostname: string): UpstreamClass {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return 'direct';
  return RELAY_HOST_PATTERNS.some((pattern) => pattern.test(host)) ? 'relay' : 'direct';
}

/** Classify a URL's host (invalid URLs count as direct so callers keep their own checks). */
export function classifyUpstreamUrl(url: string): UpstreamClass {
  try {
    return classifyUpstreamHost(new URL(url).hostname);
  } catch {
    return 'direct';
  }
}

/**
 * Rank penalty applied to relay-fronted candidates: large enough that an
 * origin-CDN stream of any quality wins, small enough that a relay is still
 * used when it is the only playable option.
 */
export const RELAY_RANK_PENALTY = 40;
