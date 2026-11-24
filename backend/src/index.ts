/**
 * Elfura Backend — HTTP Server Entrypoint (Part 2)
 * ================================================
 * Zero-dependency Node HTTP server engineered for Pterodactyl + Cloudflare:
 *   - Listens on 0.0.0.0:${SERVER_PORT || PORT || 8787}
 *   - Single uniform resolution endpoint: GET/POST /api/v1/playback
 *   - Single raw-stream proxy: GET/HEAD /api/proxy?u=<upstream-url>
 *   - Session token bootstrap: POST /api/v1/session & SSR-injected /embed/*
 *   - Zero local disk writes, logs, SQLite files, or temp media caches
 */

// Container networks very often advertise IPv6 without routing it. Node then
// hands the AAAA record to the socket first and every request stalls until its
// timeout — which looks exactly like "every source is down". Prefer A records;
// ELFURA_DNS_ORDER=verbatim restores the platform default.
import dns from 'node:dns';

import './compat.js';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  hasConfiguredSecret,
  hydrateProcessEnvFromDotEnv,
  loadBackendConfig,
  readDotEnvOverlay,
  type BackendConfig,
} from './config.js';
import { RoxyStore, siteOrigin } from './roxy-store.js';
import { ALWAYS_AD_FREE, AdSettingsStore, decideAds, popunderSrc, popunderTag } from './ads.js';
import { ROXY_PAGE } from './roxy-page.js';
import { roxySourceWebsites, requestSourceWebsite } from './roxy-source-requests.js';
import { checkRelay, proxyProbeTarget } from './proxy-check.js';
import { collectDiagnostics, probeOutbound, readBuildInfo, reportEgress } from './diagnostics.js';
import { installDnsRescue } from './dns-rescue.js';
import { egressProblem, installEgressProfile, isEgressProfileInstalled, relayStatus, reportRelayProbe } from './egress.js';
import { clearRelayUrl, currentRelayUrl, readRelayToken, relaySource, saveRelayUrl } from './relay-config.js';
import { runtimeSummary } from './compat.js';
import {
  applyCorsHeaders,
  getClientIp,
  isLikelyAutomatedScraper,
  mintPlaybackToken,
  resolveAllowedOrigin,
  sealPlaybackEnvelope,
  setCloudflareCache,
  SlidingWindowLimiter,
  verifyPlaybackToken,
} from './security.js';
import { approvedSourceIds } from './sources/index.js';
import { SourceRegistry } from './sources/registry.js';
import {
  createLocalPlaybackResolver,
  createRefusingPlaybackResolver,
  createResilientPlaybackResolver,
  ResolverBackendDownError,
  resolverConfig,
  resolverFallbackReason,
  resolverIntended,
  ResolverRefusedError,
  type PlaybackResolution,
  type PlaybackResolver,
} from './playback-resolver.js';
import {
  InvalidRequestError,
  RemotePlaybackResolver,
  ResolverUnavailableError,
} from './playback-resolver-remote.js';
import { createResolverServer, resolverPort } from './resolver-server.js';
import { buildDiagnoseBundle } from './diagnose-bundle.js';
import { handleStreamProxy, DEFAULT_STREAM_PROXY_PATH } from './stream-proxy.js';
import { fetchTmdbCatalog, fetchTmdbMetadata, fetchTmdbSeasonEpisodes } from './tmdb.js';
import { fetchSkipMarkers } from './segments.js';
import { describeMemoryPolicy, RAM_CACHE_ENABLED } from './memory-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '../../dist');

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/** Present but no longer valid, as opposed to absent. See the playback route. */
function isStaleTokenReason(reason: string): boolean {
  return reason !== 'missing playback token';
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  allowOrigin = '*',
  cachePolicy: 'no-store' | 'manifest' = 'no-store',
): void {
  applyCorsHeaders(res, allowOrigin);
  setCloudflareCache(res, cachePolicy);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (!total) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

interface ParsedEmbedRoute {
  mediaType?: 'movie' | 'tv';
  tmdbId?: string;
  season?: number;
  episode?: number;
}

export function matchEmbedPath(pathname: string): ParsedEmbedRoute | null {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/embed' || clean === '/embed.html') {
    return {};
  }
  // Bare player path. The deployed site is reached as /player?id=<tmdb>, which
  // 404s on this build - so an embed built on that URL shows nothing at all.
  // Serving the same document here costs nothing and removes a whole class of
  // "works on the site, not in the embed" reports.
  if (clean === '/player' || clean === '/player.html') {
    return {};
  }
  const movieMatch = clean.match(/^(?:\/embed)?\/movie\/([A-Za-z0-9_-]+)$/);
  if (movieMatch) {
    return { mediaType: 'movie', tmdbId: movieMatch[1] };
  }
  const tvMatch = clean.match(/^(?:\/embed)?\/tv\/([A-Za-z0-9_-]+)\/(\d+)\/(\d+)$/);
  if (tvMatch) {
    return {
      mediaType: 'tv',
      tmdbId: tvMatch[1],
      season: Math.max(1, Number(tvMatch[2]) || 1),
      episode: Math.max(1, Number(tvMatch[3]) || 1),
    };
  }
  return null;
}

try {
  if (process.env.ELFURA_DNS_ORDER !== 'verbatim') dns.setDefaultResultOrder('ipv4first');
} catch {
  /* older runtimes: keep the default order */
}

/**
 * Prefer IPv4 for outbound resolves unless an operator says otherwise.
 *
 * A container with an IPv6 route that black-holes is a classic half-broken
 * egress: every host with an AAAA record hangs until the connect attempt times
 * out, while a host that answers only on IPv4 loads instantly. It looks exactly
 * like "some sources just stopped working". IPv4-first removes that class of
 * failure and costs nothing when IPv6 is healthy.
 */
if ((process.env.ELFURA_DNS_ORDER ?? 'ipv4first') === 'ipv4first') {
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    /* older runtime: keep the default */
  }
}

export function createBackendServer(overrides: Partial<BackendConfig> = {}) {
  // Publish .env into process.env BEFORE anything reads it directly. Modules
  // below (resolver split, DNS, runtime toggles) read process.env themselves and
  // used to be blind to the .env file entirely - which is how ELFURA_RESOLVER_URL
  // in .env produced a silent local fallback. Real env vars still win.
  const dotEnv = hydrateProcessEnvFromDotEnv();
  if (dotEnv.applied.length > 0 && process.env.ELFURA_QUIET_ENV !== '1') {
    console.log(`[elfura-backend] .env published to the process: ${dotEnv.applied.join(', ')}`);
  }

  // May set ELFURA_RESOLVER_URL, so it runs before the resolver is chosen below.
  startAutostartResolver(overrides);
  const cfg: BackendConfig = { ...loadBackendConfig(), ...overrides };
  const registry = new SourceRegistry(cfg);
  /**
   * Where stream discovery happens. Either this process scrapes providers, or a
   * separate resolver process does and this one only serves video. The player,
   * the stream proxy and the playback contract are identical in both cases.
   */
  const remote = resolverConfig();
  // A misconfigured resolver must NOT translate into "nothing plays".
  //
  // There was a version of this that refused to resolve locally when a resolver
  // URL was present but unusable. It was wrong, and it was wrong in the worst
  // direction: an operator typo turned into a 503 for every viewer on the site.
  // A visitor does not care where discovery runs; they care that the episode
  // plays. So: resolve remotely when the resolver is genuinely reachable, and
  // otherwise fall back to local, loudly.
  //
  // "Loudly" means three things, none of which cost a viewer a stream:
  //   - a console.error naming the exact reason, on every boot
  //   - resolver.mode = 'degraded' in /roxy/api/sources and the diagnose bundle
  //   - lastResolverFallbackReason() in both, so the panel says why
  const splitIntended = resolverIntended();
  const allowLocalFallback = process.env.ELFURA_RESOLVER_ALLOW_LOCAL !== '0';
  let resolver: PlaybackResolver;
  let resolverFallback: string;
  if (remote) {
    // Remote first; local only if the resolver is genuinely down. A dead
    // resolver must degrade the split, never the site.
    // NOTE: no `local` resolver is passed. With a resolver configured, this node
    // NEVER scrapes - that is the whole point of the split, and a fallback here
    // was what made it start fetching providers mid-stream.
    // One resolver, one connection. There is no round-robin pool, no backup
    // fan-out and no health-weighted node selection in the media path.
    const primaryRemote = new RemotePlaybackResolver(remote.url, remote.token);
    resolver = createResilientPlaybackResolver({
      remote: primaryRemote,
      onFallback: (detail) =>
        console.warn(
          `[elfura-resolver] resolver call failed (${detail}). Reporting the backend offline; ` +
            'NOT retrying and NOT scraping locally - this node only serves video. ' +
            'Check /api/v1/resolver-test if this repeats.',
        ),
      onRecovered: () => console.log('[elfura-resolver] resolver is answering again.'),
    });
    resolverFallback = '';
  } else if (splitIntended && !allowLocalFallback) {
    // Deliberate strict mode, only when explicitly asked for.
    resolver = createRefusingPlaybackResolver(resolverFallbackReason());
    resolverFallback = resolverFallbackReason();
    console.error(
      `[elfura-resolver] resolver URL unusable (${resolverFallback}), and ELFURA_RESOLVER_ALLOW_LOCAL=0 ` +
        'forbids local resolving. Playback will fail until this is fixed.',
    );
  } else {
    resolver = createLocalPlaybackResolver(registry);
    resolverFallback = remote ? '' : resolverFallbackReason();
    if (splitIntended) {
      console.error(
        `[elfura-resolver] DEGRADED: resolver URL unusable (${resolverFallback}). ` +
          'Falling back to local resolving so playback keeps working. The split is NOT active - ' +
          'fix ELFURA_RESOLVER_URL to move discovery off this process.',
      );
    }
  }
  // Viewer-facing rate limiting is OFF by default.
  //
  // It was 120/min per client IP, shared by session, episodes, segments,
  // catalog and analytics. One embed load spends about four of those, so a
  // modest audience — or anyone behind a carrier NAT, where thousands of viewers
  // share one address — exhausted the bucket and saw 429s. The player reports a
  // 429 on /session as "nothing plays", so the limit was quietly costing
  // viewers on the busiest minutes: exactly the wrong moment to refuse traffic.
  //
  // Set RATE_LIMIT_PER_MIN to a positive number to turn it back on. The login
  // limiter below is deliberately NOT part of this switch: it guards the
  // operator panel against brute force, where a cap protects you rather than
  // costing you viewers.
  const rateLimiter = cfg.rateLimitPerMin > 0 ? new SlidingWindowLimiter(cfg.rateLimitPerMin) : null;
  // Artwork and playback are what one page load spends its requests on, and the
  // player reads any non-200 as "this title has no sources". Sharing the 120/min
  // abuse bucket with them meant a viewer who browsed a catalogue — every card
  // asks for artwork — exhausted the bucket and then saw "not available in all
  // sources" for every title until the minute rolled over. They get their own
  // windows, unlimited unless an operator sets a number.
  const artCeiling = Number(process.env.ELFURA_ART_RATE_LIMIT || 0);
  const playbackCeiling = Number(process.env.ELFURA_PLAYBACK_RATE_LIMIT || 0);
  const artLimiter = artCeiling > 0 ? new SlidingWindowLimiter(artCeiling) : null;
  const playbackLimiter = playbackCeiling > 0 ? new SlidingWindowLimiter(playbackCeiling) : null;
  const roxy = new RoxyStore(cfg.secret);
  // Pop-under ads live in the embed player only; this decides per request.
  const ads = new AdSettingsStore();
  const loginLimiter = new SlidingWindowLimiter(5);
  const roxyWebsiteLimiter = new SlidingWindowLimiter(20);
  const proxyCheckLimiter = new SlidingWindowLimiter(20);
  /**
   * What the operator needs to know about the proxy list, with no credential in
   * it: how many entries exist, where they came from, and whether the network
   * layer that would use them is actually installed.
   */
  const proxySummary = () => {
    const envProxy = (
      process.env.ELFURA_UPSTREAM_PROXY ??
      readDotEnvOverlay().ELFURA_UPSTREAM_PROXY ??
      ''
    ).trim();
    return {
      envProxyConfigured: !!envProxy,
      applied: isEgressProfileInstalled(),
      problem: egressProblem(),
      probeTarget: proxyProbeTarget(),
      // The relay is a single URL, so its state is a small object rather than a
      // list: is one set, where did it come from, and did it work last time.
      relay: {
        ...relayStatus(),
        url: currentRelayUrl(),
        source: relaySource(),
        installed: isEgressProfileInstalled(),
        // Whether a token exists, never the token: without this the panel cannot
        // tell "you never saved it" from "you saved the wrong one".
        tokenSaved: !!readRelayToken(),
      },
    };
  };
  const sameOrigin = (req: http.IncomingMessage) => {
    const origin = typeof req.headers.origin === 'string' ? siteOrigin(req.headers.origin) : '';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    try { return !!origin && new URL(origin).host.toLowerCase() === host; } catch { return false; }
  };
  const adminCookie = (exp: number) => {
    const data = String(exp);
    return data + '.' + crypto.createHmac('sha256', cfg.secret).update('roxy-session:' + data).digest('base64url');
  };
  const authenticated = (req: http.IncomingMessage) => {
    const cookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('roxy_session='))?.slice(13) || '';
    const [expiry, sig, extra] = cookie.split('.');
    if (!expiry || !sig || extra || !/^\d{10,16}$/.test(expiry) || Number(expiry) < Date.now()) return false;
    const a = Buffer.from(cookie), b = Buffer.from(adminCookie(Number(expiry)));
    return a.length === b.length && crypto.timingSafeEqual(a,b);
  };
  const cookieFlags = (req: http.IncomingMessage) => {
    const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!(req.socket as {encrypted?: boolean}).encrypted;
    return `Path=/roxy; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  };
  // Diagnostics perform real upstream requests; keep public research bounded.
  const diagnosticLimiter = new SlidingWindowLimiter(6);
  /** 4/min: each call samples for two seconds, so it is a real cost. */
  const diagnoseBundleLimiter = new SlidingWindowLimiter(4);
  // The light egress report is cheap and is exactly what an operator reaches for
  // when sources look dead, so it gets its own per-IP window instead of the
  // process-wide six-a-minute budget the heavy report uses.
  const egressLimiter = new SlidingWindowLimiter(30);

  let cachedEmbedTemplate: string | null = null;
  const getEmbedTemplate = async (): Promise<string | null> => {
    if (cachedEmbedTemplate !== null) return cachedEmbedTemplate;
    try {
      const html = await fs.readFile(path.join(DIST_ROOT, 'embed.html'), 'utf8');
      if (cfg.isProd) cachedEmbedTemplate = html;
      return html;
    } catch {
      return null;
    }
  };

  let cachedLandingTemplate: string | null = null;
  const getLandingTemplate = async (): Promise<string | null> => {
    if (cachedLandingTemplate !== null) return cachedLandingTemplate;
    try {
      const html = await fs.readFile(path.join(DIST_ROOT, 'landing.html'), 'utf8');
      if (cfg.isProd) cachedLandingTemplate = html;
      return html;
    } catch {
      return null;
    }
  };

  /** The routing body below; assigned before anything can reach it. */
  let routeRequest: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;

  /**
   * Every route below is async, and a throw inside an async request handler
   * becomes an unhandled rejection - which Node treats as fatal, so the whole
   * process dies and the panel shows the server as simply offline. One bad
   * request must never be able to take the service down, so the handler is
   * wrapped: unexpected errors are logged with the route and answered with a
   * 500 when the response is still writable.
   */
  const handleRequest = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        console.error(`[elfura-http] ${req.method} ${String(req.url).split('?')[0]} failed: ${detail}`);
      } catch {
        /* logging must never throw either */
      }
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'internal server error' });
      } else {
        try { res.end(); } catch { /* socket already gone */ }
      }
    }
  };
  const server = http.createServer(handleRequest);

  routeRequest = async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'malformed request url' });
      return;
    }

    const pathname = url.pathname;

    // ---- ELFURA_REDIRECT_TO: move the site to a new domain ----------------
    // One setting, one job: replace the host, keep everything after it. So
    // abc.com/embed/movie/550?x=1 arrives as def.com/embed/movie/550?x=1.
    //
    // /api and /roxy are exempt. The API because a redirected fetch is a failed
    // fetch, which breaks playback for anyone still on the old domain; the panel
    // because a migration that hides the admin UI on the old host is one you
    // cannot undo from the panel.
    if (cfg.redirectTo) {
      // Hostname only, port ignored. A port mismatch must never be the reason
      // the new domain "redirects" to itself - that is a loop, and a loop takes
      // the whole site down.
      const hostnameOf = (raw: string) => {
        const value = raw.split(',')[0].trim().toLowerCase();
        const match = /^(\[[^\]]+\]|[^:]+)/.exec(value);
        return (match ? match[1] : value).replace(/\.$/, '');
      };
      const host = hostnameOf(String(req.headers['x-forwarded-host'] || req.headers.host || ''));
      const targetHost = hostnameOf(new URL(cfg.redirectTo).host);
      const exempt = pathname === '/api' || pathname.startsWith('/api/') ||
        pathname === '/roxy' || pathname.startsWith('/roxy/');
      // A framed navigation is never redirected, and this is the whole reason
      // embeds keep working: Chrome re-derives a frame's permissions after a
      // cross-origin redirect and drops `fullscreen`, so every viewer who
      // arrived through the redirect lost fullscreen while direct visitors kept
      // it. Measured, not guessed: an iframe navigated through a 301 reports
      // document.fullscreenEnabled === false and any requestFullscreen is
      // refused with "Disallowed by permissions policy", while the same iframe
      // loaded directly reports true. Nothing in the page can repair that, so
      // the player is served in place instead. The parent page's
      // allow="fullscreen" still grants it, because no redirect happened.
      const framed = /^(iframe|frame)$/i.test(String(req.headers['sec-fetch-dest'] || '').trim());
      if (!exempt && !framed && host && host !== targetHost) {
        const location = cfg.redirectTo + pathname + (url.search || '');
        res.writeHead(301, { Location: location, 'Cache-Control': 'no-store', Vary: 'Host' });
        res.end(method === 'HEAD' ? undefined : `Moved to ${location}`);
        return;
      }
    }

    // Roxy is always same-origin and is deliberately outside the permissive public API CORS policy.
    if (pathname === '/roxy' || pathname === '/roxy/') {
      if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
      res.end(method === 'HEAD' ? undefined : ROXY_PAGE); return;
    }
    if (pathname.startsWith('/roxy/api/')) {
      const reply = (status: number, data: unknown) => { const b=Buffer.from(JSON.stringify(data)); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(b); };
      if (method === 'POST' && !sameOrigin(req)) { reply(403,{error:'Same-origin request required'}); return; }
      if (pathname === '/roxy/api/login' && method === 'POST') {
        if (!loginLimiter.allow(`roxy-login:${getClientIp(req)}`)) { reply(429,{error:'Too many login attempts'}); return; }
        let body: Record<string,unknown>; try { body=await readJsonBody(req,4096); } catch { reply(400,{error:'Invalid request'}); return; }
        if (!hasConfiguredSecret() || typeof body.password !== 'string' || body.password.length > 1024) { reply(401,{error:'Invalid credentials or ELFURA_SECRET is not configured'}); return; }
        const hash=crypto.createHash('sha256').update(body.password.trim()).digest();
        if (!crypto.timingSafeEqual(hash,cfg.secret)) { reply(401,{error:'Invalid credentials'}); return; }
        res.setHeader('Set-Cookie',`roxy_session=${adminCookie(Date.now()+8*60*60_000)}; ${cookieFlags(req)}; Max-Age=28800`);reply(200,{ok:true}); return;
      }
      if (!authenticated(req)) { reply(401,{error:'Sign in required'}); return; }
      if (pathname === '/roxy/api/logout' && method === 'POST') { res.setHeader('Set-Cookie',`roxy_session=; ${cookieFlags(req)}; Max-Age=0`); reply(200,{ok:true}); return; }
      if (pathname === '/roxy/api/overview' && method === 'GET') { reply(200,roxy.snapshot()); return; }
      if (pathname === '/roxy/api/ads' && method === 'GET') {
        reply(200, {
          ...ads.get(),
          src: popunderSrc(),
          alwaysAdFree: ALWAYS_AD_FREE,
          localhostExempt: true,
          sitesSeen: roxy.snapshot().sites.map((row) => row.key).filter((key) => key && key !== '(direct / unknown)'),
        });
        return;
      }
      if (pathname === '/roxy/api/ads' && method === 'POST') {
        try {
          const body = await readJsonBody(req, 4096);
          if (typeof body.enabled === 'boolean') {
            ads.setEnabled(body.enabled);
            reply(200, { ok: true, ...ads.get() });
            return;
          }
          if (typeof body.site === 'string' && typeof body.adFree === 'boolean') {
            const next = ads.setSiteAdFree(body.site, body.adFree);
            reply(200, { ok: true, ...next });
            return;
          }
          reply(400, { ok: false, error: 'expected {enabled} or {site, adFree}' });
        } catch {
          reply(400, { ok: false, error: 'Invalid request' });
        }
        return;
      }
      if (pathname === '/roxy/api/clear' && method === 'POST') { roxy.clear(); const ok=await roxy.flush(); reply(ok?200:500,ok?{ok:true}:{error:'Could not persist deletion'}); return; }
      if (pathname === '/roxy/api/ban' && method === 'POST') {
        try { const b=await readJsonBody(req,4096);if(typeof b.site!=='string'||typeof b.ban!=='boolean'||!roxy.setBan(b.site,b.ban)){reply(400,{error:'Invalid site or action'});return;}const ok=await roxy.flush();reply(ok?200:500,ok?{ok:true}:{error:'Could not persist ban'}); }catch{reply(400,{error:'Invalid request'});} return;
      }
      // ---- Source health & kill switches -------------------------------
      // The control surface the operator asked for: see every source, why it is
      // failing, and turn it off without editing files or restarting.
      if (pathname === '/roxy/api/sources' && method === 'GET') {
        // `sources: null` and `unavailable: true` when the resolver cannot be
        // reached. An empty array would render as "you have no sources", which
        // is the opposite of the truth and the exact confusion this whole split
        // exists to prevent.
        const probe = await resolver.probe();
        const status = probe.reachable ? await resolver.sourceStatus() : null;
        reply(200, {
          resolver: {
            kind: resolver.kind,
            label: resolver.label,
            ...probe,
            // Why the split did not engage. '' when it did. Without this, an
            // unset variable and a refused public URL both read as the same
            // featureless {kind:"local"} and the only clue is that the split
            // "does not help".
            ...(resolver.kind === 'local' || resolver.kind === 'refusing'
              ? {
                  localBecause: resolverFallbackReason(),
                  // 'degraded' = a split was intended but discovery is running
                  // here. Playback still works; the split is not active. Without
                  // this distinction an operator cannot tell a healthy
                  // single-process install from a broken split.
                  degraded: resolverIntended() && !!process.env.ELFURA_RESOLVER_URL,
                }
              : {}),
          },
          unavailable: !probe.reachable,
          sources: status,
        });
        return;
      }
      if (pathname === '/roxy/api/sources' && method === 'POST') {
        try {
          const body = await readJsonBody(req, 4096);
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          if (!id || typeof body.enabled !== 'boolean') { reply(400, { error: 'expected { id, enabled }' }); return; }
          const ok = await resolver.setSourceEnabled(id, body.enabled);
          if (!ok) { reply(502, { error: 'the resolver did not accept the change' }); return; }
          const status = await resolver.sourceStatus();
          reply(200, { ok: true, sources: status ?? [] });
        } catch { reply(400, { error: 'Invalid request' }); }
        return;
      }
      if (pathname === '/roxy/api/sources/reset' && method === 'POST') {
        // Give a source a clean slate after a deploy that might have fixed it.
        try {
          const body = await readJsonBody(req, 4096);
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          if (id) await resolver.setSourceEnabled(id, true);
          const status = await resolver.sourceStatus();
          reply(200, { ok: true, sources: status ?? [] });
        } catch { reply(400, { error: 'Invalid request' }); }
        return;
      }

      if (pathname === '/roxy/api/egress' && method === 'GET') {
        // The one question worth answering before any proxy, relay or header
        // work: can this server reach the internet at all, and is the failure
        // specific to the provider hosts? A network filter that resets by
        // hostname looks exactly like "every source is blocked", which is how an
        // operator ends up buying proxies for a problem that is not theirs.
        if (!proxyCheckLimiter.allow('egress-check')) { reply(429, { error: 'Check limit reached; retry shortly' }); return; }
        try {
          const report = await reportEgress();
          reply(200, report);
        } catch { reply(500, { error: 'Egress check failed' }); }
        return;
      }
      if (pathname === '/roxy/api/relay' && method === 'GET') { reply(200, proxySummary().relay); return; }
      if (pathname === '/roxy/api/relay' && method === 'POST') {
        // The panel is the intended input here: a beginner should not have to
        // learn that the right place is a line in .env.
        try {
          const body = await readJsonBody(req, 4096);
          if ('clear' in body && body.clear) {
            if (relaySource() === 'environment' || relaySource() === 'dotenv') {
              reply(400, { error: 'The relay URL is set in the environment or .env, which takes precedence. Remove it there to use the panel.' });
              return;
            }
            const ok = clearRelayUrl();
            reply(ok ? 200 : 500, { ...proxySummary().relay, ...(ok ? {} : { error: 'Could not save the change' }) });
            return;
          }
          if (typeof body.url !== 'string') { reply(400, { error: 'expected {url}' }); return; }
          const url = body.url.trim().replace(/\/+$/, '');
          if (!url) { reply(400, { error: 'Paste the Worker URL first' }); return; }
          // A real Worker is always https. Loopback http is allowed only so the
          // relay path can be exercised locally; a public http relay would send
          // the token in clear text.
          const loopback = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url);
          if (!/^https:\/\/[^\s]+$/i.test(url) && !loopback) {
            reply(400, { error: 'The URL must start with https:// and contain no spaces' });
            return;
          }
          if (relaySource() === 'environment' || relaySource() === 'dotenv') {
            reply(400, { error: 'The relay URL is set in the environment or .env, which takes precedence. Remove it there to use the panel.' });
            return;
          }
          const token = typeof body.token === 'string' ? body.token.trim() : '';
          if (!saveRelayUrl(url, token)) { reply(500, { error: 'Could not save the relay URL; check the data directory is writable' }); return; }
          reply(200, proxySummary().relay);
        } catch { reply(400, { error: 'Invalid request' }); }
        return;
      }
      if (pathname === '/roxy/api/relay/test' && method === 'POST') {
        if (!proxyCheckLimiter.allow('relay-check')) { reply(429, { error: 'Test limit reached; retry shortly' }); return; }
        const url = currentRelayUrl();
        if (!url) { reply(400, { error: 'No relay URL saved yet' }); return; }
        const result = await checkRelay(url);
        reportRelayProbe(result.ok, result.ip, result.ms, result.error);
        reply(200, { ...result, relay: proxySummary().relay });
        return;
      }
      if (pathname === '/roxy/api/source-websites' && method === 'GET') { reply(200, { sites: roxySourceWebsites(cfg) }); return; }
      if (pathname === '/roxy/api/source-websites/request' && method === 'POST') {
        if (!roxyWebsiteLimiter.allow('global')) { reply(429,{error:'Test limit reached; retry shortly'}); return; }
        try {
          const body = await readJsonBody(req, 4096);
          const sites = roxySourceWebsites(cfg);
          const selected = body.id === 'all' ? sites : sites.filter(site => site.id === body.id);
          if (!selected.length) { reply(400,{error:'Unknown source website'}); return; }
          reply(200,{results: await Promise.all(selected.map(requestSourceWebsite))});
        } catch { reply(400,{error:'Invalid request'}); }
        return;
      }
      reply(404,{error:'Not found'}); return;
    }
    if (pathname === '/api/v1/analytics' && method === 'POST') {
      if (rateLimiter && !rateLimiter.allow(`analytics:${getClientIp(req)}`)) {sendJson(res,429,{ok:false});return;}
      try {const body=await readJsonBody(req,4096);const ok=roxy.record(body.ticket,body.event,body.title);sendJson(res,ok?200:400,{ok});}catch{sendJson(res,400,{ok:false});}return;
    }

    // 1. CORS preflight
    if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
      const origin = resolveAllowedOrigin(req, cfg.allowedOrigins) || '*';
      applyCorsHeaders(res, origin);
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Health probe (lightweight for Pterodactyl / Cloudflare health checks)
    if ((method === 'GET' || method === 'HEAD') && pathname === '/api/v1/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'elfura-backend',
        version: '0.1.0',
        build: readBuildInfo().commit,
        // Emitted by the running code, unlike build-info.json which can be
        // replaced on disk while an older Node process is still running.
        features: { roxy: true },
        // Small, stable readout so RAM can be watched from the panel or a URL
        // without SSH. heapUsed is what the code holds; rss is what the OS
        // reserved. With payload caching off these should both stay flat.
        memory: readMemoryUsage(),
        // Deliberately no source list. This route is unauthenticated so a host can
        // poll it, which means its body is public: naming the providers here would
        // hand out the one thing the whole design hides. Count only, which says
        // "it is configured" without saying what with.
        sourceCount: registry.listPublicSources().length,
      });
      return;
    }

    // 2b. Live public landing-page catalog. Only sanitized TMDB fields are
    // returned; upstream credentials and endpoint URLs stay server-side.
    if (method === 'GET' && pathname === '/api/v1/catalog') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'request forbidden' }, allowOrigin);
        return;
      }
      if (rateLimiter && !rateLimiter.allow(`catalog:${getClientIp(req)}`)) {
        sendJson(res, 429, { ok: false, error: 'rate limit exceeded' }, allowOrigin);
        return;
      }
      const catalog = await fetchTmdbCatalog(cfg.tmdb);
      sendJson(res, 200, { ok: true, ...catalog }, allowOrigin, 'manifest');
      return;
    }

    // 2b-bis. Connection-stage report on its own.
    //
    // The full /diagnose races twenty adapters before it answers, so it takes ten
    // to twenty seconds and it is capped at six requests a minute for the whole
    // process. This answers the one question "can this server open a connection to
    // the hosts the adapters use, and at which stage does it fail" in a couple of
    // seconds, on its own small per-IP window.
    if (method === 'GET' && (pathname === '/diagnose/egress' || pathname === '/api/v1/egress')) {
      if (!egressLimiter.allow(`egress:${getClientIp(req)}`)) {
        sendJson(res, 429, { ok: false, error: 'too many requests; try again in a minute' });
        return;
      }
      try {
        const egress = await reportEgress();
        sendJson(res, 200, {
          ok: true,
          build: readBuildInfo().commit,
          generatedAt: new Date().toISOString(),
          egress,
        });
      } catch (err) {
        sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : 'egress check failed' });
      }
      return;
    }

    // 2c. Operator diagnostics (sanitized JSON: no secrets, URLs, or provider names)
    // One request that answers "why is this box struggling". Unauthenticated on
    // purpose: the operator may be locked out of /roxy when the box is unwell,
    // and this carries no title ids, stream URLs or tokens - only counts and
    // timings. Rate-limited by its own small window so it cannot be used as a
    // load generator (it samples the event loop for two seconds).
    // Test the resolver link FROM HERE, which is the only place the answer
    // matters. The operator can open the resolver's port in a browser and it
    // works, while this process still cannot reach it - a different network
    // path, a different DNS view, a firewall rule that only allows the public
    // address. Opening it on the box you are typing in proves nothing.
    if (method === 'GET' && pathname === '/api/v1/resolver-test') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      const target = resolverConfig();
      if (!target) {
        sendJson(
          res,
          200,
          {
            ok: false,
            configured: false,
            reason: resolverFallbackReason(),
            detail:
              'This node has no usable resolver URL, so it is resolving locally (or refusing to). ' +
              'Fix ELFURA_RESOLVER_URL first - a link test would prove nothing.',
          },
          allowOrigin,
        );
        return;
      }
      const started = Date.now();
      const probe = await resolver.kind === 'remote'
        ? await (resolver as unknown as { probe(): Promise<{ reachable: boolean; detail: string }> }).probe()
        : { reachable: false, detail: 'resolver is not in remote mode' };
      sendJson(
        res,
        200,
        {
          ok: probe.reachable,
          configured: true,
          url: target.url,
          tokenSent: target.token ? `yes (${target.token.length} chars, ends "...${target.token.slice(-4)}")` : 'NO TOKEN - the resolver will answer 401',
          reachable: probe.reachable,
          ms: Date.now() - started,
          detail: probe.detail,
        },
        allowOrigin,
      );
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/diagnose-bundle') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (!diagnoseBundleLimiter.allow(`db:${getClientIp(req)}`)) {
        sendJson(res, 429, { ok: false, error: 'diagnose-bundle is rate limited; try again in a minute' }, allowOrigin);
        return;
      }
      try {
        const bundle = await buildDiagnoseBundle({
          reachedVia: String(req.headers.host ?? ''),
          commit: readBuildInfo().commit,
          limits: { rateLimitPerMin: cfg.rateLimitPerMin, streamProxyPath: cfg.streamProxyPath, host: cfg.host, port: cfg.port },
          ramCacheEnabled: RAM_CACHE_ENABLED,
          probeResolver: resolver.kind === 'remote' ? () => resolver.probe() : undefined,
        });
        sendJson(res, 200, bundle, allowOrigin);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error as Error)?.message ?? error) }, allowOrigin);
      }
      return;
    }

    if (method === 'GET' && ['/api/v1/diagnostics', '/diagnostic', '/diagnose', '/diagnose/'].includes(pathname)) {
      // Global limit avoids title/query variations bypassing the report cache.
      if (!diagnosticLimiter.allow('global')) {
        sendJson(res, 429, { ok: false, error: 'diagnostics rate limit exceeded; try again later' });
        return;
      }
      const anilistRaw = url.searchParams.get('anilist')?.trim() || url.searchParams.get('anilistId')?.trim() || '';
      if (anilistRaw && (!/^\d{1,10}$/.test(anilistRaw) || Number(anilistRaw) < 1)) {
        sendJson(res, 400, { ok: false, error: 'valid anilist parameter is required' });
        return;
      }
      const anilistEpisodeRaw = url.searchParams.get('anilistEpisode')?.trim() || url.searchParams.get('anilist_ep')?.trim() || '';
      const anilistEpisode = Number(anilistEpisodeRaw);
      if (anilistEpisodeRaw && (!/^\d{1,4}$/.test(anilistEpisodeRaw) || !Number.isSafeInteger(anilistEpisode) || anilistEpisode < 1 || anilistEpisode > 5000)) {
        sendJson(res, 400, { ok: false, error: 'valid anilistEpisode parameter must be between 1 and 5000' });
        return;
      }
      const type = (anilistRaw || url.searchParams.get('type') === 'tv') ? 'tv' : 'movie';
      const tmdbRaw = (url.searchParams.get('tmdb') || '693134').replace(/\D/g, '');
      const num = (raw: string | null, fallback: number) => {
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(999, Math.floor(n)) : fallback;
      };
      let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const reportPromise = collectDiagnostics(cfg, registry, {
          type,
          tmdbId: tmdbRaw.slice(0, 12) || '693134',
          season: num(url.searchParams.get('s'), 1),
          episode: num(url.searchParams.get('e'), 1),
          ...(anilistRaw ? { anilist: anilistRaw } : {}),
          ...(anilistEpisodeRaw ? { anilistEpisode } : {}),
          lang: /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(url.searchParams.get('lang') || '')
            ? (url.searchParams.get('lang') || '').slice(0, 12).toLowerCase()
            : undefined,
        }, url.searchParams.get('fresh') === '1');
        const timeoutPromise = new Promise<never>((_, reject) => {
          diagnosticTimer = setTimeout(() => reject(new Error('diagnostics timeout')), 30_000);
        });
        const report = await Promise.race([reportPromise, timeoutPromise]);
        sendJson(res, 200, report, '*', 'no-store');
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const busy = message === 'diagnostics busy';
        const timedOut = message === 'diagnostics timeout';
        sendJson(res, timedOut ? 504 : busy ? 429 : 500, {
          ok: false,
          error: timedOut ? 'diagnostics timed out after 30 seconds; check provider connectivity and server logs' : busy ? 'diagnostics busy; try again shortly' : 'diagnostics failed',
        });
      } finally {
        if (diagnosticTimer) clearTimeout(diagnosticTimer);
      }
      return;
    }

    // 3. Session token bootstrap (for standalone SDK & dev embeds)
    if (method === 'POST' && pathname === '/api/v1/session') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'request forbidden' }, allowOrigin);
        return;
      }
      const clientIp = getClientIp(req);
      if (rateLimiter && !rateLimiter.allow(`sess:${clientIp}`)) {
        sendJson(res, 429, { ok: false, error: 'rate limit exceeded' }, allowOrigin);
        return;
      }
      let body: Record<string, unknown> = {};
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid json body' }, allowOrigin);
        return;
      }
      const mediaType = body.anilist ? 'tv' : body.type === 'tv' ? 'tv' : body.type === 'movie' ? 'movie' : '*';
      const anilistRaw = body.anilist === undefined || body.anilist === null ? '' : String(body.anilist).trim();
      if (anilistRaw && (!/^\d{1,10}$/.test(anilistRaw) || Number(anilistRaw) < 1)) {
        sendJson(res, 400, { ok: false, error: 'valid anilist parameter is required' }, allowOrigin);
        return;
      }
      const tmdbBase = typeof body.tmdb === 'string' && body.tmdb.trim() ? body.tmdb.trim() : '*';
      const tmdbId = anilistRaw ? `tmdb:${tmdbBase}|anilist:${anilistRaw}` : tmdbBase;
      const minted = mintPlaybackToken(cfg.secret, req, {
        mediaType,
        tmdbId,
        bindIp: cfg.bindTokenIp,
      });
      sendJson(res, 200, { ok: true, ...minted }, allowOrigin);
      return;
    }

    // 4. Single Uniform Playback Endpoint
    // Artwork bootstrap. The player needs the backdrop and the title logo in
    // the first few hundred milliseconds; waiting for the whole playback
    // response (which races twenty adapters) is what left the startup screen
    // blank for four seconds. TMDB-only, RAM cached, shares the same cache the
    // later resolve uses, so it costs nothing and warms it.
    if (method === 'GET' && (pathname === '/api/v1/art' || pathname === '/api/v1/metadata')) {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (artLimiter && !artLimiter.allow(`art:${getClientIp(req)}`)) {
        sendJson(res, 429, { ok: false, error: 'rate limit exceeded' }, allowOrigin);
        return;
      }
      const type = (url.searchParams.get('type') || url.searchParams.get('mediaType') || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
      const tmdbId = (url.searchParams.get('tmdb') || url.searchParams.get('tmdbId') || url.searchParams.get('id') || '').trim();
      if (!/^[A-Za-z0-9_-]{1,24}$/.test(tmdbId)) {
        sendJson(res, 400, { ok: false, error: 'valid tmdb parameter is required' }, allowOrigin);
        return;
      }
      const season = type === 'tv' ? Math.max(1, Number(url.searchParams.get('s') || url.searchParams.get('season')) || 1) : undefined;
      const episode = type === 'tv' ? Math.max(1, Number(url.searchParams.get('e') || url.searchParams.get('episode')) || 1) : undefined;
      try {
        const media = await fetchTmdbMetadata(cfg.tmdb, { type, tmdbId, season, episode });
        sendJson(
          res,
          200,
          {
            ok: true,
            media: {
              type,
              tmdbId,
              title: media.title,
              year: media.year,
              logo: media.logo,
              backdrop: media.backdrop,
              poster: media.poster,
            },
          },
          allowOrigin,
        );
      } catch {
        sendJson(res, 200, { ok: false }, allowOrigin);
      }
      return;
    }

    if ((method === 'GET' || method === 'POST') && pathname === '/api/v1/playback') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'request forbidden' }, allowOrigin);
        return;
      }
      const clientIp = getClientIp(req);
      if (playbackLimiter && !playbackLimiter.allow(`pb:${clientIp}`)) {
        sendJson(res, 429, { ok: false, error: 'rate limit exceeded' }, allowOrigin);
        return;
      }

      let body: Record<string, unknown> = {};
      if (method === 'POST') {
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid request body' }, allowOrigin);
          return;
        }
      }

      const pick = (keys: string[]): string => {
        for (const k of keys) {
          const q = url.searchParams.get(k);
          if (q !== null && q.trim() !== '') return q.trim();
          const b = body[k];
          if (b !== undefined && b !== null && String(b).trim() !== '') return String(b).trim();
        }
        return '';
      };

      const rawType = pick(['type', 'mediaType']).toLowerCase();
      const anilistRaw = pick(['anilist', 'anilistId']);
      if (anilistRaw && (!/^\d{1,10}$/.test(anilistRaw) || Number(anilistRaw) < 1)) {
        sendJson(res, 400, { ok: false, error: 'valid anilist parameter is required' }, allowOrigin);
        return;
      }
      const anilistId = anilistRaw || undefined;
      const mediaType: 'movie' | 'tv' = anilistId || rawType === 'tv' ? 'tv' : 'movie';
      const tmdbId = pick(['tmdb', 'tmdbId', 'id']);
      if (!tmdbId || !/^[A-Za-z0-9_-]{1,24}$/.test(tmdbId)) {
        sendJson(res, 400, { ok: false, error: 'valid tmdb parameter is required' }, allowOrigin);
        return;
      }
      const tokenScopeId = anilistId ? `tmdb:${tmdbId}|anilist:${anilistId}` : tmdbId;

      const season = mediaType === 'tv' ? Math.max(1, Number(pick(['s', 'season'])) || 1) : undefined;
      const episode = mediaType === 'tv' ? Math.max(1, Number(pick(['e', 'ep', 'episode'])) || 1) : undefined;
      const anilistEpisodeRaw = pick(['anilistEpisode', 'anilist_ep']);
      const anilistEpisodeNumber = Number(anilistEpisodeRaw);
      if (anilistEpisodeRaw && (!/^\d{1,4}$/.test(anilistEpisodeRaw) || !Number.isSafeInteger(anilistEpisodeNumber) || anilistEpisodeNumber < 1 || anilistEpisodeNumber > 5000)) {
        sendJson(res, 400, { ok: false, error: 'valid anilistEpisode parameter must be between 1 and 5000' }, allowOrigin);
        return;
      }
      const anilistEpisode = anilistEpisodeRaw ? anilistEpisodeNumber : undefined;
      const sourceId = pick(['source']) || undefined;
      const preferredLang = pick(['lang']) || undefined;

      const headerTok = typeof req.headers['x-playback-token'] === 'string' ? req.headers['x-playback-token'] : '';
      const pltoken = headerTok || pick(['pltoken']);
      const nonce = pick(['nonce']) || undefined;

      if (cfg.requireToken) {
        const verified = verifyPlaybackToken(cfg.secret, req, pltoken, nonce, {
          mediaType,
          tmdbId: tokenScopeId,
          bindIp: cfg.bindTokenIp,
        });
        if (!verified.ok) {
          // A stale or mismatched SSR token must not be terminal.
          //
          // The embed ships a token minted when the DOCUMENT was served. If that
          // document was cached by an edge, a proxy or the browser, if the user
          // agent changed (in-app browsers and privacy modes rewrite it), if the
          // token aged out, or if BIND_TOKEN_IP is on and the client address
          // differs, the very first resolution answers 401 and the player shows
          // "couldn't reach sources" - while the main site works, because it
          // mints its token on demand instead of carrying one from page load.
          //
          // Rather than make the viewer reload until a token happens to match,
          // mint one for THIS request and carry on. Everything the token proves
          // (media scope, nonce, fingerprint, configured flags) still applies to
          // the request being served; only the stale provenance is discarded.
          // IP binding is exempt on purpose: that mismatch is typically
          // cross-site leakage, not our own embed.
          // Only a token that is PRESENT but no longer valid is recoverable.
          // An absent token is an anonymous caller, and REQUIRE_PLAYBACK_TOKEN
          // exists to refuse exactly that.
          const present = typeof pltoken === 'string' && pltoken.length > 0;
          const recoverable =
            present &&
            !(cfg.bindTokenIp && /ip mismatch/i.test(verified.reason));
          if (!recoverable) {
            sendJson(res, 401, { ok: false, error: verified.reason }, allowOrigin);
            return;
          }
          console.warn(`[elfura-playback] re-minting token: ${verified.reason}`);
        }
      }

      let resolved: PlaybackResolution | null = null;
      try {
        resolved = await resolver.resolve({
          type: mediaType,
          tmdbId,
          anilistId,
          season,
          episode,
          anilistEpisode,
          sourceId,
          preferredLang,
          late: url.searchParams.get('late') === '1',
          retryMissing: url.searchParams.get('late') === '1' && url.searchParams.get('retryMissing') === '1',
        });
      } catch (error) {
        // A resolver that cannot be reached is an outage, not an answer. Saying
        // "no sources for this title" would send the viewer hunting for a
        // different title when the problem is behind us.
        // The source backend is genuinely down: retried, and health did not
        // answer. The viewer gets something they can act on, and the player uses
        // this flag to point at another server instead of a dead end.
        if (error instanceof ResolverBackendDownError) {
          sendJson(
            res,
            503,
            {
              ok: false,
              error: 'the source backend is down. Please change the streaming server and try again.',
              reason: 'resolver-down',
              suggestSwitchServer: true,
              detail: error.detail,
            },
            allowOrigin,
          );
          return;
        }
        if (error instanceof InvalidRequestError) {
          // The backend is up but could not resolve this title. A different
          // server would not help, so do not send the viewer chasing one.
          sendJson(
            res,
            502,
            { ok: false, error: 'this title could not be resolved right now. Try again in a moment.', reason: 'lookup-failed' },
            allowOrigin,
          );
          return;
        }
        if (error instanceof ResolverUnavailableError) {
          sendJson(res, 503, { ok: false, error: 'source resolver is unreachable; try again shortly' }, allowOrigin);
          return;
        }
        // A configured resolver that we refused to use. Same 503 shape as an
        // outage, but the message says what to fix instead of blaming the network.
        if (error instanceof ResolverRefusedError) {
          sendJson(res, 503, { ok: false, error: `resolver is misconfigured: ${error.detail}` }, allowOrigin);
          return;
        }
        throw error;
      }

      if (!resolved) {
        sendJson(res, 404, { ok: false, error: 'no playable streams available for this title' }, allowOrigin);
        return;
      }

      // When requested by ElfuraPlayer (`X-Elfura-Envelope: 1`), AES-256-GCM seal the response
      // so DevTools Network Preview & copied cURL commands only see opaque ciphertext.
      const wantEnvelope = req.headers['x-elfura-envelope'] === '1' && Boolean(pltoken && nonce);
      const responseBody = wantEnvelope
        ? sealPlaybackEnvelope(resolved, pltoken, nonce!)
        : resolved;

      // Playback JSON carries per-session encrypted tickets -> private no-store
      sendJson(res, 200, responseBody, allowOrigin, 'no-store');
      return;
    }

    // 4b. TV Season & Episode Catalog Endpoint (for Episode Wheel & Instant Binge Pre-Warm)
    if (method === 'GET' && pathname === '/api/v1/episodes') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'request forbidden' }, allowOrigin);
        return;
      }
      const clientIp = getClientIp(req);
      if (rateLimiter && !rateLimiter.allow(`ep:${clientIp}`)) {
        sendJson(res, 429, { ok: false, error: 'rate limit exceeded' }, allowOrigin);
        return;
      }

      const tmdbId = (url.searchParams.get('tmdb') || url.searchParams.get('id') || '').trim();
      if (!tmdbId || !/^[A-Za-z0-9_-]{1,24}$/.test(tmdbId)) {
        sendJson(res, 400, { ok: false, error: 'valid tmdb parameter is required' }, allowOrigin);
        return;
      }
      const season = Math.max(
        1,
        Number(url.searchParams.get('s') || url.searchParams.get('season') || 1) || 1,
      );

      const headerTok =
        typeof req.headers['x-playback-token'] === 'string' ? req.headers['x-playback-token'] : '';
      const pltoken = headerTok || (url.searchParams.get('pltoken') || '').trim();
      const nonce = (url.searchParams.get('nonce') || '').trim() || undefined;

      if (cfg.requireToken) {
        const verified = verifyPlaybackToken(cfg.secret, req, pltoken, nonce, {
          mediaType: 'tv',
          tmdbId,
          bindIp: cfg.bindTokenIp,
        });
        // Same staleness tolerance as /api/v1/playback: the episode wheel is an
        // enrichment, and refusing it over a token minted at page load removes a
        // feature without protecting anything. Only IP binding stays strict.
        if (!verified.ok) {
          const recoverable =
            isStaleTokenReason(verified.reason) &&
            !(cfg.bindTokenIp && /ip mismatch/i.test(verified.reason));
          if (!recoverable) {
            sendJson(res, 401, { ok: false, error: verified.reason }, allowOrigin);
            return;
          }
        }
      }

      const catalog = await fetchTmdbSeasonEpisodes(cfg.tmdb, { tmdbId, season });
      const payload = { ok: true as const, ...catalog };
      const wantEnvelope = req.headers['x-elfura-envelope'] === '1' && Boolean(pltoken && nonce);
      const responseBody = wantEnvelope ? sealPlaybackEnvelope(payload, pltoken, nonce!) : payload;
      sendJson(res, 200, responseBody, allowOrigin, wantEnvelope ? 'no-store' : 'manifest');
      return;
    }

    // Independent, best-effort TV skip markers. Never runs on the playback critical path.
    if (method === 'GET' && pathname === '/api/v1/segments') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (isLikelyAutomatedScraper(req, cfg.isProd)) { sendJson(res, 403, { ok: false }, allowOrigin); return; }
      if (rateLimiter && !rateLimiter.allow(`segments:${getClientIp(req)}`)) { sendJson(res, 429, { ok: false }, allowOrigin); return; }
      const tmdbId = (url.searchParams.get('tmdb') || '').trim();
      const season = Number(url.searchParams.get('s'));
      const episode = Number(url.searchParams.get('e'));
      const duration = Number(url.searchParams.get('duration'));
      if (!/^\d{1,12}$/.test(tmdbId) || !Number.isInteger(season) || season < 1 || season > 999 ||
          !Number.isInteger(episode) || episode < 1 || episode > 9999 || !Number.isFinite(duration) || duration < 60 || duration > 21600) {
        sendJson(res, 400, { ok: false }, allowOrigin); return;
      }
      const pltoken = typeof req.headers['x-playback-token'] === 'string' ? req.headers['x-playback-token'] : '';
      const nonce = (url.searchParams.get('nonce') || '').trim() || undefined;
      // Skip markers are best-effort decoration with no secrets in them. A stale
      // document token must not turn them into a 401 the player has to handle.
      if (cfg.requireToken) {
        const verified = verifyPlaybackToken(cfg.secret, req, pltoken, nonce, { mediaType: 'tv', tmdbId, bindIp: cfg.bindTokenIp });
        if (!verified.ok) {
          const recoverable =
            isStaleTokenReason(verified.reason) &&
            !(cfg.bindTokenIp && /ip mismatch/i.test(verified.reason));
          if (!recoverable) {
            sendJson(res, 401, { ok: false, error: verified.reason }, allowOrigin);
            return;
          }
        }
      }
      const segments = await fetchSkipMarkers({ tmdbId, season, episode, duration });
      sendJson(res, 200, { ok: true, segments }, allowOrigin, 'no-store');
      return;
    }

    // 5. Single raw-stream proxy (tgvidx style). Every manifest, key,
    // subtitle and media segment flows through this one stateless route.
    if (
      (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') &&
      (pathname === cfg.streamProxyPath ||
        pathname === DEFAULT_STREAM_PROXY_PATH ||
        pathname === '/api/public/stream-proxy' ||
        pathname === '/proxy')
    ) {
      if (isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'automated scraper blocked' });
        return;
      }
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      await handleStreamProxy(req, res, { allowOrigin, proxyPath: cfg.streamProxyPath });
      return;
    }

    // 6. Public landing, demo, documentation, and status surfaces. The root is
    // deliberately separate from the token-minting player routes below.
    if (method === 'GET' || method === 'HEAD') {
      const cleanPath = pathname.replace(/\/+$/, '') || '/';
      if (['/', '/demo', '/docs', '/status', '/landing.html'].includes(cleanPath)) {
        const html = await getLandingTemplate();
        if (!html) {
          sendJson(res, 503, { ok: false, error: 'landing dist not built yet — run `npm run build` first' });
          return;
        }
        const buf = Buffer.from(html, 'utf8');
        setCloudflareCache(res, 'no-store');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(buf.byteLength),
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        });
        res.end(method === 'HEAD' ? undefined : buf);
        return;
      }

      // 7. Embed HTML routes (built Part 1 player + pre-minted session token)
      const embedMatch = matchEmbedPath(pathname);
      if (embedMatch) {
        const parentSite = siteOrigin(req.headers.referer);
        if (roxy.isBanned(parentSite)) { sendJson(res, 403, {ok:false,error:'Embedding site is banned'}); return; }
        const tpl = await getEmbedTemplate();
        if (!tpl) {
          sendJson(res, 503, {
            ok: false,
            error: 'player dist not built yet — run `npm run build` first',
          });
          return;
        }

        const qAnilistRaw = url.searchParams.get('anilist')?.trim() || url.searchParams.get('anilistId')?.trim() || '';
        if (qAnilistRaw && (!/^\d{1,10}$/.test(qAnilistRaw) || Number(qAnilistRaw) < 1)) {
          sendJson(res, 400, { ok: false, error: 'valid anilist parameter is required' });
          return;
        }
        const qAnilist = qAnilistRaw || undefined;
        const qTmdb = url.searchParams.get('tmdb')?.trim() || embedMatch.tmdbId || '*';
        if (qAnilist && !/^[A-Za-z0-9_-]{1,24}$/.test(qTmdb)) {
          sendJson(res, 400, { ok: false, error: 'valid tmdb parameter is required with anilist' });
          return;
        }
        const qTypeRaw = (url.searchParams.get('mediaType') || url.searchParams.get('type') || '').toLowerCase();
        const qMediaType =
          qAnilist ? 'tv' : embedMatch.mediaType || (qTypeRaw === 'tv' ? 'tv' : qTypeRaw === 'movie' ? 'movie' : '*');
        const qScopeId = qAnilist ? `tmdb:${qTmdb}|anilist:${qAnilist}` : qTmdb;

        const minted = mintPlaybackToken(cfg.secret, req, {
          mediaType: qMediaType,
          tmdbId: qScopeId,
          bindIp: cfg.bindTokenIp,
        });

        const bootData = {
          ...(embedMatch.mediaType ? { mediaType: embedMatch.mediaType } : qAnilist ? { mediaType: 'tv' } : {}),
          ...(embedMatch.tmdbId ? { tmdb: embedMatch.tmdbId } : {}),
          ...(qAnilist ? { anilist: qAnilist } : {}),
          ...(embedMatch.season ? { season: embedMatch.season } : {}),
          ...(embedMatch.episode ? { episode: embedMatch.episode } : {}),
          pltoken: minted.pltoken,
          nonce: minted.nonce,
          ...(!qAnilist && (qMediaType === 'movie' || qMediaType === 'tv') && /^[A-Za-z0-9_-]{1,24}$/.test(qTmdb) ? { analyticsTicket: roxy.ticket(parentSite, qMediaType, qTmdb) } : {}),
        };

        // Escape `<` inside JSON to prevent script breakout
        const safeJson = JSON.stringify(bootData).replace(/</g, '\\u003c');
        // Ads: embed player only. The decision uses the referring site, the
        // request host, the admin switches and the always-free brand domains.
        const adDecision = decideAds(
          { parentSite, requestHost: String(req.headers['x-forwarded-host'] || req.headers.host || '') },
          ads.get(),
        );
        const adTag = adDecision.serve ? popunderTag(adDecision.src) : '';
        let injected = tpl.replace(
          '</head>',
          `  <script>window.__ELFURA_BOOT__=${safeJson};</script>\n</head>`,
        );
        if (adTag) injected = injected.replace('</body>', `  ${adTag}\n</body>`);
        const buf = Buffer.from(injected, 'utf8');
        setCloudflareCache(res, 'no-store');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(buf.byteLength),
          'X-Content-Type-Options': 'nosniff',
          // Deliberately frameable: this document exists to be embedded. There
          // is no X-Frame-Options and the CSP names no frame-ancestors, so both
          // old and new browsers allow it. Do not copy the /roxy DENY above here.
          // A cross-site iframe is the whole point of this document. Under
          // `same-origin` the browser strips the referer exactly when the parent
          // is third-party, which is when the origin check most needs it - the
          // embed then looks like an anonymous caller and gets refused with the
          // player showing "Couldn't find this title". Full referrer, and the
          // document is frameable so a partner site may actually embed it.
          'Referrer-Policy': 'no-referrer-when-downgrade',
        });
        res.end(method === 'HEAD' ? undefined : buf);
        return;
      }

      // 8. Built static assets from dist/ (read-only). The official brand icon
      // lives at the document root so browsers can also use it as the favicon.
      if (
        pathname === '/icon-maskable-512.png' ||
        pathname.startsWith('/assets/') ||
        pathname.startsWith('/lib/')
      ) {
        const rel = pathname.replace(/^\/+/, '');
        const resolvedPath = path.resolve(DIST_ROOT, rel);
        if (resolvedPath.startsWith(DIST_ROOT + path.sep)) {
          try {
            const data = await fs.readFile(resolvedPath);
            const ext = path.extname(resolvedPath).toLowerCase();
            setCloudflareCache(res, 'immutable');
            res.writeHead(200, {
              'Content-Type': MIME_BY_EXT[ext] || 'application/octet-stream',
              'Content-Length': String(data.byteLength),
              'X-Content-Type-Options': 'nosniff',
            });
            res.end(method === 'HEAD' ? undefined : data);
            return;
          } catch {
            /* fall through to 404 */
          }
        }
      }
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  };

  server.on('close', () => roxy.close());
  return { server, cfg, registry };
}

/** Compact memory readout: MB with one decimal, cheap enough for a health probe. */
function readMemoryUsage(): {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  payloadCaches: 'on' | 'off';
} {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
  return {
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    externalMb: mb(m.external),
    payloadCaches: RAM_CACHE_ENABLED ? 'on' : 'off',
  };
}

/** Installed once, whatever the entry point. */
let processGuardsInstalled = false;

/**
 * Keep a stray async error from killing the service.
 *
 * Node treats an unhandled rejection as fatal by default, so before this a
 * single unexpected throw anywhere - a timer callback, an adapter's background
 * work, a socket callback - terminated the process. The panel then shows the
 * server as offline until a human notices, which is exactly the "it crashed and
 * never came back" behaviour. Log loudly and stay up: a degraded process still
 * serves every request it can, and an exited one serves none.
 *
 * Opt out with ELFURA_EXIT_ON_UNCAUGHT=1 for a host that would rather restart
 * (systemd, pm2, Pterodactyl's own restart-on-exit) and wants the hard failure.
 */
export function installProcessGuards(): void {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;

  const fatal = process.env.ELFURA_EXIT_ON_UNCAUGHT === '1';

  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    console.error(`[elfura-fatal] unhandled rejection: ${detail}`);
    if (fatal) process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    console.error(`[elfura-fatal] uncaught exception: ${error?.stack || error}`);
    // An uncaught exception may have left shared state inconsistent, so a host
    // that can restart us should be allowed to. The default keeps serving.
    if (fatal) process.exit(1);
  });
}

export function startBackendServer(overrides: Partial<BackendConfig> = {}) {
  installProcessGuards();
  // Before anything resolves a hostname: if this container's resolver is dead
  // (Docker's 127.0.0.11 stops forwarding and every upstream hangs), route our
  // own lookups through public DNS so the adapters can work at all.
  void installDnsRescue().then(() => installEgressProfile());
  const { server, cfg, registry } = createBackendServer(overrides);
  // A port that cannot be bound is not a survivable state: the guards below
  // deliberately keep the process alive through unexpected throws, which would
  // turn EADDRINUSE into a container that reports itself healthy while serving
  // nothing. Exit instead, so the supervisor retries and the log says why.
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(
      `[elfura-backend] cannot listen on ${cfg.host}:${cfg.port} (${error.code || error.message}); exiting so the supervisor can retry`,
    );
    process.exit(1);
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(
      `[elfura-backend] dns order: ${process.env.ELFURA_DNS_ORDER === 'verbatim' ? 'verbatim' : 'ipv4first'}` +
        ` · adapter timeout: ${cfg.resolveTimeoutMs}ms` +
        ` (RESOLVE_TIMEOUT_MS${process.env.RESOLVE_TIMEOUT_MS ? `=${process.env.RESOLVE_TIMEOUT_MS}` : ' unset'})` +
        ` · first-response budget: ${process.env.ELFURA_RESOLVE_BUDGET_MS || 5000}ms`,
    );
    console.log(describeMemoryPolicy());
    if (cfg.redirectTo) {
      // Named on boot: a redirect mistake looks like "the site is dead", so the
      // console says exactly where it is sending people.
      console.log(`[elfura-redirect] every page moves to ${cfg.redirectTo} (path and query preserved; /api and /roxy stay)`);
    }
    const state = registry.describeSources();
    // Count, not names. This console is visible to anyone with panel access, and
    // the list of providers is the one thing that must not be published — a
    // screenshot of the startup log used to be a complete source list.
    // ELFURA_VERBOSE_SOURCES=1 restores the names for local debugging.
    const named =
      process.env.ELFURA_VERBOSE_SOURCES === '1' ? `: ${state.enabled.join(', ') || 'none'}` : '';
    console.log(
      `[elfura-backend] listening on ${cfg.host}:${cfg.port} ` +
        `(${state.enabled.length}/${state.enabled.length + state.disabled.length} sources${named}; roxy: enabled)`,
    );
    if (process.env.ELFURA_SELF_TEST !== '0') {
      void import('./sources/self-test.js')
        .then((mod) => mod.runSourceSelfTest(registry))
        .catch(() => {});
    }
    if (state.disabled.length) {
      console.warn(
        `[elfura-backend] disabled sources: ${state.disabled
          .map((d) => `${d.id} (${d.flag}=0)`)
          .join(', ')} — remove those lines from .env to race every lane`,
      );
    }
    // Operator-only boot diagnostics (server console; never sent to clients).
    // Hostnames/booleans only — no keys, tokens, or secrets.
    const hostOf = (raw?: string) => {
      if (!raw) return 'unset';
      try {
        return new URL(raw).host;
      } catch {
        return 'invalid-url';
      }
    };
    console.log(
      `[elfura-config] tmdbBase=${hostOf(cfg.tmdb.apiBase)} tmdbKey=${cfg.tmdb.apiKey || cfg.tmdb.bearerToken ? 'set' : 'unset(fallback)'} ` +
        `allowedOrigins=${cfg.allowedOrigins.join(',') || '*'} ` +
        `streamProxy=${cfg.streamProxyPath} resolveTimeoutMs=${cfg.resolveTimeoutMs} ` +
        // Providers come from the manifest, not from this line: naming hosts here
        // kept stale ones in the log long after they were gone.
        `sources=${approvedSourceIds().join(',') || 'none-approved'} ${runtimeSummary()}`,
    );
    // One bounded outbound check, logged once per boot. When every source
    // reports "no rows" the first question is whether this container can reach
    // the internet at all — this answers it without opening a browser.
    void probeOutbound(cfg)
      .then((net) => {
        const parts = Object.entries(net).map(
          ([label, r]) => `${label}=${r.ok ? `ok/${r.status}` : `fail(${r.code})`} ${r.ms}ms`,
        );
        console.log(`[elfura-net] ${parts.join(' ')}`);
      })
      .catch(() => {});
    // The same question, one layer deeper: if the adapters all report zero
    // candidates, the console should say at which stage the outbound connection
    // dies instead of leaving "timeout" as the only clue.
    void reportEgress()
      .then((report) => {
        const rows = report.targets.map((t) => {
          const where = !t.dns?.ok
            ? `dns-fail(${t.dns?.error ?? '?'})`
            : !t.tcp?.ok
              ? `tcp-fail(${t.tcp?.error ?? '?'})`
              : !t.tls?.ok
                ? `tls-fail(${t.tls?.error ?? '?'})`
                : `http-${t.http?.status ?? '?'}`;
          return `${t.label}=${where}`;
        });
        console.log(`[elfura-egress] ${rows.join(' ')}`);
        for (const line of report.verdict) console.log(`[elfura-egress] ${line}`);
      })
      .catch(() => {});
  });
  return { server, cfg, registry };
}

// Auto-start when invoked directly (`node dist/backend/index.js`)
const isDirectMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectMain) {
  startBackendServer();
}

/**
 * Start the source-resolver process instead of the media server.
 *
 * Same build, same adapters, different port. Enabled with `--resolver` on the
 * command line or ELFURA_RESOLVER_MODE=1. Kept in the same file so the two
 * modes cannot drift apart: both construct a SourceRegistry from the same
 * config, they only differ in what they expose over HTTP.
 */
export function startResolverServer(overrides: Partial<BackendConfig> = {}) {
  installProcessGuards();
  const { cfg, registry } = createBackendServer(overrides);
  const token = (process.env.ELFURA_RESOLVER_TOKEN ?? process.env.ELFURA_SECRET ?? '').trim();
  const openMode = process.env.ELFURA_RESOLVER_OPEN === '1';
  if (!token && !openMode) {
    console.error(
      '[elfura-resolver] refusing to start without a token: set ELFURA_RESOLVER_TOKEN ' +
        '(or ELFURA_SECRET), or ELFURA_RESOLVER_OPEN=1 to accept only internal callers. ' +
        'An unauthenticated resolver on a public address is an open scraping proxy.',
    );
    process.exit(1);
  }
  if (!token && openMode) {
    // Tokenless is not the same as open-to-the-world: the auth check still
    // refuses any caller that did not arrive over a loopback or private address.
    // The warning says so, because "I turned the token off" should feel like a
    // decision with a stated limit, not a switch that quietly opened a port.
    console.warn(
      '[elfura-resolver] ELFURA_RESOLVER_OPEN=1: no token required, but ONLY for callers from ' +
        'a loopback or private address. Requests arriving through a public domain, reverse proxy ' +
        'or port forward are still refused with 401. Put this port on the private network and ' +
        'talk to it by VPS IP, as intended.',
    );
  }
  const port = resolverPort(cfg);
  // The resolver is an internal component. On a two-machine setup it must listen
  // on the private network only, never on the public interface — bind it to the
  // WireGuard/private IP, or to 127.0.0.1 when both live on one box.
  const listenHost = (process.env.ELFURA_RESOLVER_LISTEN || '127.0.0.1').trim();
  if (listenHost === '0.0.0.0' || listenHost === '::') {
    console.warn(
      `[elfura-resolver] listening on ${listenHost} exposes discovery to every network this ` +
        'machine is on. The token is the only thing left guarding it. Prefer a private address.',
    );
  }
  const { server } = createResolverServer({ cfg, registry, token });
  // The egress profile must be installed before the first provider request, and
  // the DNS rescue before the first hostname lookup — exactly as in media mode.
  void installDnsRescue().then(() => installEgressProfile());
  // Same reasoning as the media server: an unbound port must not masquerade as
  // a running process.
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`[elfura-resolver] cannot listen (${error.code || error.message}); exiting so the supervisor can retry`);
    process.exit(1);
  });
  server.listen(port, listenHost, () => {
    // Deliberately vague. This fills a Pterodactyl console that anyone with panel
    // access can read, so it does not name the port, the bind address or how many
    // sources exist. The operator knows all three; the log does not need them.
    console.log(
      '[elfura-resolver] ready · discovery is isolated from the media server · ' +
        `token ${process.env.ELFURA_RESOLVER_TOKEN ? 'from ELFURA_RESOLVER_TOKEN' : 'shared with ELFURA_SECRET'}`,
    );
    if (process.env.ELFURA_RESOLVER_VERBOSE === '1') {
      console.log(`[elfura-resolver] verbose: http://${cfg.host}:${port} · ${registry.listPublicSources().length} sources`);
    }
    console.log(describeMemoryPolicy());
    if (process.env.ELFURA_RESOLVER_VERBOSE === '1') {
      console.log(`[elfura-resolver] point the media server at it with ELFURA_RESOLVER_URL=http://127.0.0.1:${port}`);
    }
  });
  const shutdown = (signal: string) => {
    console.log(`[elfura-resolver] ${signal} received; closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { server, cfg, registry };
}

/**
 * One command, two processes.
 *
 * Pterodactyl gives an operator a single startup command, so "run the resolver
 * separately" is not a thing they can actually do there. With
 * ELFURA_RESOLVER_AUTOSTART=1 the media server starts the resolver itself, on the
 * same build, and points at it — the isolation is real (separate heap, separate
 * event loop, a crash in scraping cannot take down the relay) without asking for
 * a second terminal.
 *
 * Deliberately NOT a silent default: an operator who has deliberately not
 * configured a resolver should not suddenly be running two processes, and an
 * operator who runs one separately should not get a duplicate fighting for the
 * port.
 */
function startAutostartResolver(overrides: Partial<BackendConfig> = {}) {
  if (process.env.ELFURA_RESOLVER_AUTOSTART !== '1') return;
  if ((process.env.ELFURA_RESOLVER_URL ?? '').trim()) {
    console.log('[elfura-resolver] ELFURA_RESOLVER_URL is set; not starting a second resolver');
    return;
  }
  if (process.env.ELFURA_RESOLVER_CHILD === '1') return; // we ARE the child
  const token = (process.env.ELFURA_RESOLVER_TOKEN ?? process.env.ELFURA_SECRET ?? '').trim();
  if (!token) {
    console.warn('[elfura-resolver] autostart skipped: no ELFURA_SECRET or ELFURA_RESOLVER_TOKEN to authenticate with');
    return;
  }
  const cfg = { ...loadBackendConfig(), ...overrides };
  const port = resolverPort(cfg);
  // Re-exec the entrypoint the host actually launched (`index.js` at the project
  // root), not this compiled module: `--resolver` is handled there, and running
  // dist/backend/index.js directly would start a second *media* server and fight
  // for the port. Plain `node` regardless of how we were started, because the
  // entrypoint already knows how to serve the compiled build under a TS runner.
  const entrypoint = process.argv[1];
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELFURA_RESOLVER_CHILD: '1',
    ELFURA_RESOLVER_PORT: String(port),
    ELFURA_RESOLVER_MODE: '1',
  };
  // Let the child apply its own memory flags rather than inheriting our "already
  // applied" marker, which would leave it unbounded.
  delete childEnv.ELFURA_MEMORY_FLAGS_APPLIED;
  const child = spawn(process.execPath, [entrypoint, '--resolver'], {
    env: childEnv,
    stdio: 'inherit',
  });
  let shuttingDown = false;
  const stop = (signal: NodeJS.Signals) => {
    shuttingDown = true;
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => stop(signal));
  // A spawn that never starts (bad entrypoint, missing file) must not be reported
  // as "started". This check exists because the log said "started a separate
  // resolver on port N" while nothing was listening on N at all.
  child.on('error', (err) => {
    console.error(`[elfura-resolver] autostart could not spawn the resolver: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    // The resolver shuts itself down gracefully on a signal, so a normal stop is
    // an exit code, not a signal. Either way this is expected when we asked.
    if (shuttingDown) return;
    if (signal === 'SIGTERM' || signal === 'SIGINT') return;
    // The resolver dying must not take video serving with it. Say so loudly, and
    // leave the media server running: playback says 503 until it is restarted,
    // which is truthful and recoverable, where exiting would be neither.
    console.error(
      `[elfura-resolver] the autostarted resolver exited (${signal ?? code}); ` +
        'video keeps serving, but new source lookups will report an outage until it is restarted',
    );
  });
  process.env.ELFURA_RESOLVER_URL = `http://127.0.0.1:${port}`;
  // Say "starting", then confirm with a probe before claiming it is up. The old
  // single line was emitted unconditionally and was wrong whenever the child
  // exited immediately, which sent anyone debugging it looking at the media
  // server for a fault that was in the child.
  console.log(
    `[elfura-resolver] autostart: starting a separate resolver on port ${port}; ` +
      'discovery is isolated from the media server',
  );
  void (async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (shuttingDown) return;
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/resolver/api/health`, {
          signal: AbortSignal.timeout(400),
        });
        if (probe.ok || probe.status === 401 || probe.status === 403) {
          console.log(`[elfura-resolver] autostart: resolver is answering on port ${port}`);
          return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.error(
      `[elfura-resolver] autostart: the resolver never answered on port ${port}. ` +
        'Video keeps serving; new source lookups will report an outage.',
    );
  })();
}
