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
 * Egress can be moved off this server's address in two ways:
 *
 *   ELFURA_UPSTREAM_RELAY=https://name.account.workers.dev   a Cloudflare Worker
 *       that fetches on our behalf. This is the supported way: one URL, no
 *       credentials, no per-request fan-out, and it costs nothing per request.
 *   ELFURA_UPSTREAM_PROXY=http://user:pass@host:port (or an uploaded list)
 *       a legacy HTTP CONNECT proxy. Kept working for installs that already use
 *       it, but a metered provider bills every request, and discovery is bursty.
 */
import { normalizeFetchInput, rescueLookup, isRescueActive } from './dns-rescue.js';
import { readDotEnvOverlay } from './config.js';
import { proxyPool, type ProxyEntry } from './proxy-pool.js';
import { loadUndici, undiciUnavailableReason } from './undici-loader.js';
import { currentRelayUrl, readRelayToken, setRelayChangeHandler } from './relay-config.js';

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
let relayLogAnnounced = false;
const proxyAgents = new Map<string, import('undici').Dispatcher>();

function releaseProxies(): void {
  for (const dispatcher of proxyAgents.values()) {
    void Promise.resolve((dispatcher as { close?: () => unknown }).close?.()).catch(() => {});
  }
  proxyAgents.clear();
}

/**
 * Live state of the Worker relay, for the panel.
 *
 * A relay is one URL rather than a list, so there is nothing to rotate: what the
 * operator needs to know is simply whether it is set, whether it answered last
 * time, which address the target saw, and the error text when it failed.
 */
export interface RelayStatus {
  configured: boolean;
  /** Host only. Credentials or query strings are never reported. */
  host: string;
  attempts: number;
  successes: number;
  consecutiveFailures: number;
  /** After this many failures the relay is skipped for a minute. */
  pausedUntil: number;
  lastError: string;
  lastIp: string;
  lastMs: number;
  lastChecked: number;
}

const RELAY_PAUSE_AFTER = 3;
const RELAY_PAUSE_MS = 60_000;

const relay: RelayStatus = {
  configured: false,
  host: '',
  attempts: 0,
  successes: 0,
  consecutiveFailures: 0,
  pausedUntil: 0,
  lastError: '',
  lastIp: '',
  lastMs: 0,
  lastChecked: 0,
};

export function relayStatus(): RelayStatus {
  // `configured` and `host` follow the URL that is actually in force right now,
  // not the last one a request happened to see: the panel saves a URL and
  // expects the page to say "relay" immediately, before any source is resolved.
  const url = currentRelayUrl();
  return { ...relay, configured: !!url, host: url ? relayHost(url) : '' };
}

/**
 * Remember what a manual test learned.
 *
 * Deliberately does NOT pause the relay. A test is a diagnosis: if the token is
 * wrong the operator is going to press the button again after fixing it, and
 * three clicks must not leave the relay disabled for a minute with the panel
 * still saying "not tested yet". Pausing is for real traffic only — see the
 * request path in installEgressProfile.
 */
export function reportRelayProbe(ok: boolean, ip: string, ms: number, error: string): void {
  relay.lastChecked = Date.now();
  relay.lastMs = ms;
  if (ok) {
    relay.successes += 1;
    relay.consecutiveFailures = 0;
    relay.pausedUntil = 0;
    relay.lastError = '';
    if (ip) relay.lastIp = ip;
    return;
  }
  relay.consecutiveFailures += 1;
  relay.lastError = error;
}

/** Test hook: forget everything a previous install or probe learned. */
export function resetRelayForTest(): void {
  Object.assign(relay, {
    configured: false,
    host: '',
    attempts: 0,
    successes: 0,
    consecutiveFailures: 0,
    pausedUntil: 0,
    lastError: '',
    lastIp: '',
    lastMs: 0,
    lastChecked: 0,
  });
  relayLogAnnounced = false;
}

// Saving a URL or token resets what the previous value taught us, so the panel
// reflects the new one immediately instead of showing a stale pause or a stale
// error from the old token.
setRelayChangeHandler(() => {
  relay.consecutiveFailures = 0;
  relay.pausedUntil = 0;
  relay.lastError = '';
});

function relayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
}

/**
 * Preserve the shape of a real `fetch` response.
 *
 * `Response.url` is read-only and empty for a constructed response, but six
 * call sites in the adapters use `res.url || fallback` to discover the URL a
 * redirect settled on. Under a relay that list would silently become "the URL
 * we asked for", so the field is filled in from what the Worker reports.
 */
function withUrl(response: Response, url: string): Response {
  if (!url || response.url === url) return response;
  try {
    Object.defineProperty(response, 'url', { value: url, configurable: true, enumerable: true });
  } catch {
    /* a platform that forbids it keeps its empty url; the callers have fallbacks */
  }
  return response;
}

export async function installEgressProfile(log: (line: string) => void = console.log): Promise<boolean> {
  if (installed) return true;
  const env = { ...readDotEnvOverlay(), ...process.env };
  if ((env.ELFURA_EGRESS_PROFILE ?? 'browser').toLowerCase() === 'off') {
    installProblem = 'ELFURA_EGRESS_PROFILE=off, so the browser profile and the relay are disabled on purpose.';
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
  // Called per request below rather than captured here: the panel can save a
  // relay URL at any time, and waiting for a restart would look broken.
  let relayUrl = currentRelayUrl();
  relay.attempts = 0;
  relay.successes = 0;
  relay.consecutiveFailures = 0;
  relay.pausedUntil = 0;
  relay.lastError = '';
  relay.configured = !!relayUrl;
  relay.host = relayUrl ? relayHost(relayUrl) : '';


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

  /**
   * One discovery request through the Worker. The target URL and the method go
   * in headers because the Worker is a different origin and the URL carries the
   * provider's own query string (tokens, signatures) that must survive verbatim.
   *
   * `redirect: manual` keeps undici from rewriting our request to the Worker's
   * 302 ourselves: the Worker has already resolved the chain, so a 3xx reaching
   * this point is the target's real answer.
   */
  /**
   * Loop guard. In production the Worker is a separate service, but when the relay
   * is reachable from this same process — a test harness, or an operator pointing
   * it at their own server — the hop to the Worker goes through this patched
   * global fetch, which relays again, forever. While the relay hop is in flight the
   * flag makes the wrapper pass everything straight to undici.
   */
  let relayInFlight = 0;

  const relayFetch = async (base: string, url: string, init: unknown, timeoutMs = 20_000): Promise<FetchResult> => {
    const options = (init ?? {}) as {
      method?: string;
      body?: unknown;
      redirect?: string;
      headers?: HeaderBag;
    };
    // The browser profile built for the target must travel *with* the request to
    // the Worker. Passing only x-elfura-* made undici fill in its own defaults
    // (`user-agent: undici`, `accept: *\/*`), and the Worker then relayed those to
    // the provider — which is the exact fingerprint Cloudflare refuses. The
    // profile headers are copied and the relay's own headers are added on top.
    const headers: HeaderBag = { ...(options.headers ?? {}) };
    headers['x-elfura-target'] = url;
    // The Worker's shared secret. Read per request so a token saved in the panel
    // applies without a restart, and never logged: a leaked token is an open relay.
    const token = readRelayToken();
    if (token) headers['x-elfura-token'] = token;
    if (options.method) headers['x-elfura-method'] = String(options.method).toUpperCase();
    const unchanged = options.redirect === 'manual';
    if (unchanged) headers['x-elfura-redirect'] = 'manual';
    if (typeof options.body === 'string' || options.body instanceof Uint8Array) {
      // Discovery APIs are usually GETs; when an adapter does POST JSON through
      // the relay the body has to survive, and it is small enough to inline.
      headers['x-elfura-body'] = Buffer.from(options.body as string).toString('base64').slice(0, 8192);
    }
    relayInFlight += 1;
    let response: FetchResult;
    try {
      response = (await fetch(base, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      } as never)) as FetchResult;
    } finally {
      relayInFlight -= 1;
    }
    // The Worker answers its own failures with a JSON body and this header. It is
    // the difference between "the provider refused the Worker" (a 403 with no
    // marker: try the next egress) and "this Worker rejected us" (a bad token:
    // retrying every source probe with it is pointless noise).
    const ownError = response.headers.get('x-elfura-error') || '';
    if (ownError) {
      await response.body?.cancel().catch(() => {});
      throw new Error(ownError);
    }
    const seen = response.headers.get('x-elfura-url') || '';
    const decoded = seen ? decodeURIComponent(seen) : url;
    return withUrl(response, decoded) as FetchResult;
  };

  const previousFetch = globalThis.fetch;
  const profiledFetch = (async (input: unknown, init?: unknown) => {
    if (relayInFlight > 0) return previousFetch(input as never, init as never);
    const normalized = normalizeFetchInput(input, init);
    const headers = { ...(normalized.init.headers as HeaderBag | undefined) };

    if (isMediaRequest(normalized.url, normalized.init)) {
      return previousFetch(input as never, init as never);
    }

    const firstInit = {
      ...(normalized.init as object),
      headers: browserProfile(headers, normalized.url),
    };

    /**
     * Which egress to use, in order of preference:
     *
     *   1. the Worker relay — one request, one hop, no credential, no cost per call
     *   2. an uploaded proxy from the pool — the older path, still honoured
     *   3. a direct connection
     *
     * The relay is skipped while it is paused (three failures in a row), because
     * a dead relay must not add a timeout to every one of the twenty-one source
     * probes a resolve fires.
     */
    const activeRelay = currentRelayUrl();
    if (activeRelay !== relayUrl) {
      // Saved from the panel mid-flight: adopt it, and clear the pause that
      // belonged to the previous URL.
      relayUrl = activeRelay;
      relay.configured = !!activeRelay;
      relay.host = activeRelay ? relayHost(activeRelay) : '';
      relay.pausedUntil = 0;
      relay.consecutiveFailures = 0;
    }
    if (relayUrl && relay.pausedUntil <= Date.now()) {
      try {
        relay.attempts += 1;
        const response = await relayFetch(relayUrl, normalized.url, firstInit);
        relay.successes += 1;
        relay.consecutiveFailures = 0;
        relay.lastError = '';
        relay.lastChecked = Date.now();
        if (!relayLogAnnounced) {
          relayLogAnnounced = true;
          log(`[elfura-egress] discovery requests are relayed through ${relay.host}`);
        }
        // A 502/504 from the Worker's own fetch means the provider refused the
        // Worker too, not that the relay is broken: fall through to the retry
        // below rather than counting it against the relay.
        if (response.status !== 403) return response;
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        relay.consecutiveFailures += 1;
        relay.lastError = (error as Error)?.message ?? String(error);
        relay.lastChecked = Date.now();
        // Real traffic failing three times in a row means the relay is not
        // working at all, so it rests instead of adding a timeout to every one
        // of the twenty-one source probes a resolve fires. A manual test never
        // pauses: see reportRelayProbe.
        if (relay.consecutiveFailures >= RELAY_PAUSE_AFTER) relay.pausedUntil = Date.now() + RELAY_PAUSE_MS;
      }
    }

    // The legacy path: uploaded proxies take precedence over the single `.env`
    // proxy, because an operator who uploaded a list asked for that list. Each
    // request starts one proxy further along; a transport failure moves to the
    // next, and when the whole list is unreachable the request still leaves over
    // the direct agent rather than failing the source outright.
    let dispatcher: import('undici').Dispatcher = directAgent;
    let usedProxy: ProxyEntry | null = null;
    let response: FetchResult | null = null;
    // One candidate per request, not three. Twenty-one sources times three
    // dials is how a metered proxy account gets throttled for "1,000 requests
    // in a second" while an operator is only trying to load a page.
    const candidates = proxyPool.nextCandidates(1);
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
      // No proxy answered, so this request is going direct. It gets the same
      // single 403 retry as the pass-through path below; without that a bare
      // install lost its only defence against a Cloudflare refusal.
      response = await fetch(normalized.url, { ...firstInit, dispatcher: directAgent } as never);
    }

    // 403 is what Cloudflare answers to a request it dislikes. One retry with a
    // plainer fingerprint costs nothing when it fails and is a source back when
    // it works. A refusal through a proxy may also be that proxy's reputation,
    // so the retry is attempted over the next proxy when one is available.
    if (response.status === 403) {
      await response.body?.cancel().catch(() => {});
      const retryHeaders = alternateProfile(firstInit.headers as HeaderBag);
      // A relay gives the retry a second address as well as a second
      // fingerprint, which is the combination that actually gets past a refusal.
      if (relayUrl && relay.pausedUntil <= Date.now()) {
        try {
          const viaRelay = await relayFetch(relayUrl, normalized.url, { ...firstInit, headers: retryHeaders });
          if (viaRelay.status !== 403) return viaRelay;
          await viaRelay.body?.cancel().catch(() => {});
        } catch {
          /* fall through to the local retry */
        }
      }
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
  const bootRelay = currentRelayUrl();
  log(
    `[elfura-egress] discovery requests use a browser profile` +
      (bootRelay
        ? ` via relay ${relayHost(bootRelay)}`
        : uploaded
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
