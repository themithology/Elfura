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
import { readDotEnvOverlay } from './config.js';
import { proxyPool, type ProxyEntry } from './proxy-pool.js';
import { loadUndici, undiciUnavailableReason } from './undici-loader.js';

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

/**
 * Why the proxy layer is not active, for the panel. Empty when it is.
 *
 * The failure paths in `installEgressProfile` all used to end in a bare `false`,
 * so the operator saw "saved, restart to activate" forever with no clue which
 * of the three things went wrong. The panel now prints this instead.
 */
let installProblem = '';

export function egressProblem(): string {
  return installProblem;
}

/** Close cached proxy dispatchers after the operator uploads a different list. */
let cachedGeneration = -1;
let proxyLogAnnounced = false;
const proxyAgents = new Map<string, import('undici').Dispatcher>();

function releaseProxies(): void {
  for (const dispatcher of proxyAgents.values()) {
    void Promise.resolve((dispatcher as { close?: () => unknown }).close?.()).catch(() => {});
  }
  proxyAgents.clear();
}

export async function installEgressProfile(log: (line: string) => void = console.log): Promise<boolean> {
  if (installed) return true;
  const env = { ...readDotEnvOverlay(), ...process.env };
  if ((env.ELFURA_EGRESS_PROFILE ?? 'browser').toLowerCase() === 'off') {
    installProblem = 'ELFURA_EGRESS_PROFILE=off, so the browser profile and the proxy list are disabled on purpose.';
    return false;
  }

  const undici = await loadUndici();
  if (!undici) {
    installProblem = `undici could not be loaded (${undiciUnavailableReason()}).`;
    log(`[elfura-egress] undici could not be loaded (${undiciUnavailableReason()}); using Node's built-in fetch without a proxy`);
    return false;
  }

  const connect: Record<string, unknown> = { timeout: 10_000 };
  // Keep the DNS rescue's resolver if it took over: the profile must not undo it.
  if (isRescueActive()) connect.lookup = rescueLookup;

  const proxy = (env.ELFURA_UPSTREAM_PROXY ?? '').trim();
  let directAgent: import('undici').Dispatcher;
  try {
    directAgent = proxy
      ? new undici.ProxyAgent(proxy)
      : new undici.Agent({ connect: connect as never, allowH2: true, keepAliveTimeout: 10_000 });
  } catch (error) {
    installProblem =
      'the outbound agent could not be created: ' +
      ((error as Error)?.message ?? String(error)) +
      (proxy ? ' Check ELFURA_UPSTREAM_PROXY.' : '');
    log('[elfura-egress] could not build the outbound agent; leaving fetch untouched');
    return false;
  }

  const fetch = undici.fetch;
  type FetchResult = Awaited<ReturnType<typeof fetch>>;

  /** One dispatcher per uploaded proxy, rebuilt when the list changes. */
  const agentFor = (entry: ProxyEntry): import('undici').Dispatcher => {
    if (cachedGeneration !== proxyPool.generation) {
      releaseProxies();
      cachedGeneration = proxyPool.generation;
    }
    const existing = proxyAgents.get(entry.id);
    if (existing) return existing;
    const created = new undici!.ProxyAgent(entry.url);
    proxyAgents.set(entry.id, created);
    return created;
  };

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
    };

    // Uploaded proxies take precedence over the single `.env` proxy, because an
    // operator who uploaded a list asked for that list. Each request starts one
    // proxy further along; a transport failure moves to the next, and when the
    // whole list is unreachable the request still leaves over the direct agent
    // rather than failing the source outright.
    let dispatcher: import('undici').Dispatcher = directAgent;
    let usedProxy: ProxyEntry | null = null;
    let response: FetchResult | null = null;
    const candidates = proxyPool.nextCandidates(3);
    if (candidates.length && !proxyLogAnnounced) {
      proxyLogAnnounced = true;
      log(`[elfura-egress] proxy list active: ${proxyPool.size} uploaded prox${proxyPool.size === 1 ? 'y' : 'ies'}, rotating per request`);
    }
    for (const candidate of candidates) {
      try {
        const candidateDispatcher = agentFor(candidate);
        response = await fetch(normalized.url, { ...firstInit, dispatcher: candidateDispatcher } as never);
        proxyPool.reportSuccess(candidate.id);
        dispatcher = candidateDispatcher;
        usedProxy = candidate;
        break;
      } catch (error) {
        proxyPool.reportFailure(candidate.id, error);
      }
    }
    if (!response) {
      response = await fetch(normalized.url, { ...firstInit, dispatcher: directAgent } as never);
    }

    // 403 is what Cloudflare answers to a request it dislikes. One retry with a
    // plainer fingerprint costs nothing when it fails and is a source back when
    // it works. A refusal through a proxy may also be that proxy's reputation,
    // so the retry is attempted over the next proxy when one is available.
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      const retryHeaders = alternateProfile(firstInit.headers as HeaderBag);
      let retried: FetchResult | null = null;
      if (usedProxy) {
        const next = proxyPool.nextCandidates(1).find((entry) => entry.id !== usedProxy!.id);
        if (next) {
          try {
            retried = await fetch(normalized.url, { ...firstInit, headers: retryHeaders, dispatcher: agentFor(next) } as never);
            proxyPool.reportSuccess(next.id);
            if (retried.status !== 403) return retried;
            await retried.body?.cancel().catch(() => {});
            retried = null;
          } catch (error) {
            proxyPool.reportFailure(next.id, error);
          }
        }
      }
      response = await fetch(normalized.url, { ...firstInit, headers: retryHeaders, dispatcher } as never).catch(
        () => response,
      );
    }
    return response;
  }) as typeof fetch;

  globalThis.fetch = profiledFetch;
  installed = true;
  const uploaded = proxyPool.size;
  log(
    `[elfura-egress] discovery requests use a browser profile` +
      (uploaded
        ? ` via ${uploaded} uploaded prox${uploaded === 1 ? 'y' : 'ies'}`
        : proxy
          ? ' via configured proxy'
          : ' (HTTP/2, Chrome headers, one retry on 403)'),
  );
  return true;
}

/** Test hook. */
export function isEgressProfileInstalled(): boolean {
  return installed;
}
