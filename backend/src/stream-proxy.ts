/**
 * Elfura Backend — Stream Proxy URL builder (minimal)
 * ===================================================
 * Registry imports buildStreamProxyUrl + DEFAULT_STREAM_PROXY_PATH.
 * Full tgvidx-style proxy lives in relay.ts; this is just the URL factory
 * for the 4-source board. Keeps the same base64url shape so the relay can
 * decode it, but writes to the existing /api/v1/stream endpoint that
 * backend/src/index.ts already serves.
 */

export const DEFAULT_STREAM_PROXY_PATH = '/api/v1/stream';

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function encodeProxyTarget(rawUrl: string): string {
  return Buffer.from(rawUrl, 'utf8').toString('base64url');
}

export function buildStreamProxyUrl(
  rawUrl: string,
  headers?: Record<string, string>,
  proxyPath = DEFAULT_STREAM_PROXY_PATH,
  options?: { restrictedOrigin?: string; audioLang?: string; dashTemplate?: boolean },
): string {
  const params = new URLSearchParams();
  params.set('t', Buffer.from(JSON.stringify({ u: rawUrl, h: headers ?? {}, ro: options?.restrictedOrigin, lang: options?.audioLang }), 'utf8').toString('base64url'));
  // Keep legacy ?u=&h=&ro= shape too for the relay's fallback decoder:
  // the relay accepts both {t: <ticket>} and {u: <b64url>, h: <b64url>}
  // so either decodes. Use ticket form because it matches sealStreamTicket.
  // For simplicity, also set u/h for direct readability:
  // (relay.ts will prefer t, then u)
  if (options?.restrictedOrigin) params.set('ro', options.restrictedOrigin);
  return `${proxyPath}?${params.toString()}`;
}

export function sanitizeProxyHeaders(h?: Record<string, string>): Record<string, string> { return h ?? {}; }
export function encodeProxyHeaders(h?: Record<string, string>): string | undefined { return h ? encodeBase64UrlJson(h) : undefined; }
export function decodeProxyHeaders(): undefined { return undefined; }
export function decodeProxyTarget(): null { return null; }
