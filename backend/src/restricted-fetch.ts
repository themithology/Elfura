import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { isPublicMediaUrl, matchesRestrictedOrigin } from './security.js';

/** Conservative IPv4-only egress for untrusted media references. */
export function isPublicMediaAddress(address: string): boolean {
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

/**
 * Resolve and validate at socket-connect time. This request path must never use
 * an upstream proxy: DNS must be resolved here so a rebinding answer cannot
 * redirect a source-controlled URL into the container's private network.
 */
const guardedLookup = ((
  hostname: string,
  options: unknown,
  callback: (...args: any[]) => void,
) => {
  dns.lookup(hostname, { family: 4, all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    if (!addresses.length || addresses.some(({ address }) => !isPublicMediaAddress(address))) {
      callback(Object.assign(new Error('blocked media DNS'), { code: 'EACCES' }));
      return;
    }
    const wantsAll = typeof options === 'object' && options !== null &&
      'all' in options && Boolean((options as { all?: boolean }).all);
    callback(null, wantsAll ? addresses : addresses[0].address, wantsAll ? undefined : 4);
  });
}) as NonNullable<https.RequestOptions['lookup']>;

const safeHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  lookup: guardedLookup,
});
const nativeFetchAtLoad = globalThis.fetch;

function responseHeaders(source: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(source)) {
    if (raw === undefined || ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) headers.append(name, String(value));
  }
  return headers;
}

function decodeBody(source: http.IncomingMessage, headers: Headers): Readable {
  const encoding = (headers.get('content-encoding') || '').trim().toLowerCase();
  let decoder: ReturnType<typeof createGunzip> | ReturnType<typeof createInflate> | ReturnType<typeof createBrotliDecompress> | null = null;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip();
  else if (encoding === 'deflate') decoder = createInflate();
  else if (encoding === 'br') decoder = createBrotliDecompress();
  if (!decoder) return source;
  headers.delete('content-encoding');
  headers.delete('content-length');
  return source.pipe(decoder);
}

/** A small Node HTTP/HTTPS transport used only for validated media URLs. */
function requestRestricted(url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const headers = new Headers(init.headers);
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => { requestHeaders[name] = value; });

    const method = (init.method || 'GET').toUpperCase();
    const body = init.body;
    if (body !== null && body !== undefined) {
      reject(new TypeError('restricted media requests do not accept a request body'));
      return;
    }

    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      signal: init.signal ?? undefined,
      lookup: guardedLookup,
      ...(url.protocol === 'https:' ? { agent: safeHttpsAgent, servername: url.hostname } : {}),
    }, (upstream) => {
      const status = upstream.statusCode || 502;
      const responseHeadersBag = responseHeaders(upstream.headers);
      const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
      const bodyStream = noBody ? null : Readable.toWeb(decodeBody(upstream, responseHeadersBag)) as ReadableStream<Uint8Array>;
      if (noBody) upstream.resume();
      const response = new Response(bodyStream, {
        status,
        statusText: upstream.statusMessage || '',
        headers: responseHeadersBag,
      });
      try {
        Object.defineProperty(response, 'url', { value: url.href, configurable: true, enumerable: true });
      } catch {
        /* optional metadata */
      }
      resolve(response);
    });
    request.once('error', reject);
    request.end();
  });
}

/**
 * Never route this request through a Worker or proxy. Source-controlled media
 * references are resolved and checked locally at the exact socket connection.
 */
export async function restrictedFetch(
  input: string | URL,
  init: RequestInit = {},
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const url = new URL(String(input));
  if (!isPublicMediaUrl(url.href)) throw new Error('blocked media target');
  // Explicit fixtures and tests that replace global fetch stay injectable; the
  // production default is the direct HTTP/HTTPS transport below, not a global
  // dispatcher, proxy, or fetch wrapper.
  const injectedFetch = fetchImpl ?? (globalThis.fetch !== nativeFetchAtLoad ? globalThis.fetch : undefined);
  if (injectedFetch) return injectedFetch(url.href, { ...init, redirect: 'manual' });
  return requestRestricted(url, { ...init, redirect: 'manual' });
}

/** Follow at most three validated hops, never forwarding secrets cross-origin. */
export async function restrictedFetchWithRedirects(
  raw: string,
  init: RequestInit,
  policy: string,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  let current = raw;
  let headers = new Headers(init.headers);
  for (let hop = 0; hop <= 3; hop += 1) {
    if (!matchesRestrictedOrigin(current, policy)) throw new Error('blocked media target');
    const response = await restrictedFetch(current, { ...init, headers }, fetchImpl);
    if (response.status < 300 || response.status >= 400) {
      if (!response.url) {
        try { Object.defineProperty(response, 'url', { value: current, configurable: true }); } catch { /* optional metadata */ }
      }
      return response;
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || hop === 3) throw new Error('media redirect limit');
    const next = new URL(location, current);
    if (!matchesRestrictedOrigin(next.href, policy)) throw new Error('blocked media redirect');
    if (next.origin !== new URL(current).origin) {
      headers = new Headers(headers);
      for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key']) headers.delete(name);
    }
    current = next.href;
  }
  throw new Error('media redirect limit');
}
