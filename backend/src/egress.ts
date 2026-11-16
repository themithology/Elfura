/**
 * Outbound request profile — automatic, no configuration.
 *
 * Several providers sit behind Cloudflare. It answers 403 to requests it does not
 * like the look of, and it judges the shape of the request as much as the address:
 * one Host, one Accept, Node's own TLS settings and no browser hints is not what a
 * player sends. The adapters cannot fix that, so every discovery request leaves
 * through one browser-shaped profile instead: HTTP/2 enabled, the header set a
 * real Chrome sends, and one silent retry with a second profile if the first is
 * refused.
 *
 * Nothing here refuses anything, skips anything or changes what an adapter asks
 * for. Media relay keeps its own path: it is ranged byte traffic and must not be
 * buffered or retried.
 *
 * `ELFURA_UPSTREAM_PROXY` remains supported for an install that wants a different
 * egress address, but it is not needed and nothing breaks without it.
 */
import { normalizeFetchInput, rescueLookup, isRescueActive } from './dns-rescue.js';

/** A ranged request is media, not discovery: never buffered, never retried. */
function isMediaRequest(url: string, init: Record<string, unknown>): boolean {
  if (url.includes('/api/v1/stream')) return true;
  const headers = init.headers as Record<string, unknown> | undefined;
  if (!headers) return false;
  if (Array.isArray(headers)) return headers.some(([k]: [string]) => String(k).toLowerCase() === 'range');
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.has('range');
  return Object.keys(headers).some((key) => key.toLowerCase() === 'range');
}

type HeaderBag = Record<string, string>;

const hasHeader = (headers: HeaderBag, name: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** What a Chrome tab sends when it opens a page or calls a JSON endpoint. */
function browserProfile(headers: HeaderBag, url: string): HeaderBag {
  const out: HeaderBag = { ...headers };
  const set = (name: string, value: string) => {
    if (!hasHeader(out, name)) out[name] = value;
  };
  set('user-agent', CHROME_UA);
  set('accept', 'application/json, text/plain, */*');
  set('accept-language', 'en-US,en;q=0.9,hi;q=0.8');
  set('sec-ch-ua', '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"');
  set('sec-ch-ua-mobile', '?0');
  set('sec-ch-ua-platform', '"Windows"');
  set('sec-fetch-dest', 'empty');
  set('sec-fetch-mode', 'cors');
  set('sec-fetch-site', 'same-site');
  try {
    set('referer', `${new URL(url).origin}/`);
    set('origin', new URL(url).origin);
  } catch {
    /* not a URL we can build a referer for */
  }
  return out;
}

/** A second look, for the case where the refusal was about the fingerprint. */
function alternateProfile(headers: HeaderBag): HeaderBag {
  const out: HeaderBag = { ...headers };
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (lower.startsWith('sec-ch-ua') || lower === 'sec-fetch-dest' || lower === 'sec-fetch-mode' || lower === 'sec-fetch-site') {
      delete out[key];
    }
  }
  out['user-agent'] = CHROME_UA.replace('Chrome/124.0.0.0', 'Chrome/131.0.0.0');
  return out;
}

let installed = false;

export async function installEgressProfile(log: (line: string) => void = console.log): Promise<boolean> {
  if (installed) return true;
  if ((process.env.ELFURA_EGRESS_PROFILE ?? 'browser').toLowerCase() === 'off') return false;

  const undici = await import('undici').catch(() => null);
  if (!undici) return false;

  const connect: Record<string, unknown> = { timeout: 10_000 };
  // Keep the DNS rescue's resolver if it took over: the profile must not undo it.
  if (isRescueActive()) connect.lookup = rescueLookup;

  const proxy = (process.env.ELFURA_UPSTREAM_PROXY ?? '').trim();
  let agent: import('undici').Dispatcher;
  try {
    agent = proxy
      ? new undici.ProxyAgent(proxy)
      : new undici.Agent({ connect: connect as never, allowH2: true, keepAliveTimeout: 10_000 });
  } catch {
    log('[elfura-egress] could not build the outbound agent; leaving fetch untouched');
    return false;
  }

  const previousFetch = globalThis.fetch;
  const profiledFetch = (async (input: unknown, init?: unknown) => {
    const normalized = normalizeFetchInput(input, init);
    const headers = { ...(normalized.init.headers as HeaderBag | undefined) };

    if (isMediaRequest(normalized.url, normalized.init)) {
      return previousFetch(input as never, init as never);
    }

    const firstInit = {
      ...(normalized.init as object),
      headers: browserProfile(headers, normalized.url),
      dispatcher: agent,
    };
    let response = await undici.fetch(normalized.url, firstInit as never);

    // 403 is what Cloudflare answers to a request it dislikes. One retry with a
    // plainer fingerprint costs nothing when it fails and is a source back when
    // it works.
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      const retryInit = {
        ...(normalized.init as object),
        headers: alternateProfile(firstInit.headers as HeaderBag),
        dispatcher: agent,
      };
      response = await undici.fetch(normalized.url, retryInit as never).catch(() => response);
    }
    return response;
  }) as typeof fetch;

  globalThis.fetch = profiledFetch;
  installed = true;
  log(
    `[elfura-egress] discovery requests use a browser profile${proxy ? ` via ${proxy.replace(/\/\/[^@]*@/, '//***@')}` : ' (HTTP/2, Chrome headers, one retry on 403)'}`,
  );
  return true;
}

/** Test hook. */
export function isEgressProfileInstalled(): boolean {
  return installed;
}
