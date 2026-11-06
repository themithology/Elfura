/**
 * Elfura Backend — HTTP Server Entrypoint (Part 2)
 * ================================================
 * Zero-dependency Node HTTP server engineered for Pterodactyl + Cloudflare:
 *   - Listens on 0.0.0.0:${SERVER_PORT || PORT || 8787}
 *   - Single uniform resolution endpoint: GET/POST /api/v1/playback
 *   - Single uniform stream ingress/egress relay: GET/HEAD /api/v1/stream?t=...
 *   - Session token bootstrap: POST /api/v1/session & SSR-injected /embed/*
 *   - Zero local disk writes, logs, SQLite files, or temp media caches
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasConfiguredSecret, loadBackendConfig, type BackendConfig } from './config.js';
import { RoxyStore, siteOrigin } from './roxy-store.js';
import { ROXY_PAGE } from './roxy-page.js';
import { collectDiagnostics, readBuildInfo } from './diagnostics.js';
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
import { SourceRegistry } from './sources/registry.js';
import { handleStreamRelay } from './relay.js';
import { fetchTmdbCatalog, fetchTmdbSeasonEpisodes } from './tmdb.js';

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

export function createBackendServer(overrides: Partial<BackendConfig> = {}) {
  const cfg: BackendConfig = { ...loadBackendConfig(), ...overrides };
  const registry = new SourceRegistry(cfg);
  const rateLimiter = new SlidingWindowLimiter(cfg.rateLimitPerMin);
  const roxy = new RoxyStore(cfg.secret);
  const loginLimiter = new SlidingWindowLimiter(5);
  const roxyTestLimiter = new SlidingWindowLimiter(6);
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

  const server = http.createServer(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'malformed request url' });
      return;
    }

    const pathname = url.pathname;

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
      if (pathname === '/roxy/api/clear' && method === 'POST') { roxy.clear(); const ok=await roxy.flush(); reply(ok?200:500,ok?{ok:true}:{error:'Could not persist deletion'}); return; }
      if (pathname === '/roxy/api/ban' && method === 'POST') {
        try { const b=await readJsonBody(req,4096);if(typeof b.site!=='string'||typeof b.ban!=='boolean'||!roxy.setBan(b.site,b.ban)){reply(400,{error:'Invalid site or action'});return;}const ok=await roxy.flush();reply(ok?200:500,ok?{ok:true}:{error:'Could not persist ban'}); }catch{reply(400,{error:'Invalid request'});} return;
      }
      if (pathname === '/roxy/api/test' && method === 'POST') {
        if (!roxyTestLimiter.allow('global')) { reply(429,{error:'Test limit reached; retry shortly'}); return; }
        try { const b=await readJsonBody(req,4096);const tmdb=String(b.tmdb||'');if(!/^\d{1,12}$/.test(tmdb)){reply(400,{error:'Enter a numeric TMDB ID'});return;}const num=(v:unknown)=>Math.min(999,Math.max(1,Number(v)||1));const result=await registry.diagnosePlayback({type:b.type==='tv'?'tv':'movie',tmdbId:tmdb,season:num(b.season),episode:num(b.episode)});reply(200,result); } catch {reply(500,{error:'Source test failed'});}return;
      }
      reply(404,{error:'Not found'}); return;
    }
    if (pathname === '/api/v1/analytics' && method === 'POST') {
      if (!rateLimiter.allow(`analytics:${getClientIp(req)}`)) {sendJson(res,429,{ok:false});return;}
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
        sources: registry.listPublicSources(),
      });
      return;
    }

    // 2b. Live public landing-page catalog. Only sanitized TMDB fields are
    // returned; upstream credentials and endpoint URLs stay server-side.
    if (method === 'GET' && pathname === '/api/v1/catalog') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (!allowOrigin || isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'request forbidden' });
        return;
      }
      if (!rateLimiter.allow(`catalog:${getClientIp(req)}`)) {
        sendJson(res, 429, { ok: false, error: 'rate limit exceeded' }, allowOrigin);
        return;
      }
      const catalog = await fetchTmdbCatalog(cfg.tmdb);
      sendJson(res, 200, { ok: true, ...catalog }, allowOrigin, 'manifest');
      return;
    }

    // 2c. Operator diagnostics (sanitized JSON: no secrets, URLs, or provider names)
    if (method === 'GET' && ['/api/v1/diagnostics', '/diagnostic', '/diagnose', '/diagnose/'].includes(pathname)) {
      // Global limit avoids title/query variations bypassing the report cache.
      if (!diagnosticLimiter.allow('global')) {
        sendJson(res, 429, { ok: false, error: 'diagnostics rate limit exceeded; try again later' });
        return;
      }
      const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
      const tmdbRaw = (url.searchParams.get('tmdb') || '693134').replace(/\D/g, '');
      const num = (raw: string | null, fallback: number) => {
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.min(999, Math.floor(n)) : fallback;
      };
      try {
        const report = await collectDiagnostics(cfg, registry, {
          type,
          tmdbId: tmdbRaw.slice(0, 12) || '693134',
          season: num(url.searchParams.get('s'), 1),
          episode: num(url.searchParams.get('e'), 1),
        });
        sendJson(res, 200, report, '*', 'no-store');
      } catch (error) {
        const busy = error instanceof Error && error.message === 'diagnostics busy';
        sendJson(res, busy ? 429 : 500, { ok: false, error: busy ? 'diagnostics busy; try again shortly' : 'diagnostics failed' });
      }
      return;
    }

    // 3. Session token bootstrap (for standalone SDK & dev embeds)
    if (method === 'POST' && pathname === '/api/v1/session') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (!allowOrigin || isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'origin not permitted' });
        return;
      }
      const clientIp = getClientIp(req);
      if (!rateLimiter.allow(`sess:${clientIp}`)) {
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
      const mediaType = body.type === 'tv' ? 'tv' : body.type === 'movie' ? 'movie' : '*';
      const tmdbId = typeof body.tmdb === 'string' && body.tmdb.trim() ? body.tmdb.trim() : '*';
      const minted = mintPlaybackToken(cfg.secret, req, {
        mediaType,
        tmdbId,
        bindIp: cfg.bindTokenIp,
      });
      sendJson(res, 200, { ok: true, ...minted }, allowOrigin);
      return;
    }

    // 4. Single Uniform Playback Endpoint
    if ((method === 'GET' || method === 'POST') && pathname === '/api/v1/playback') {
      const allowOrigin = resolveAllowedOrigin(req, cfg.allowedOrigins);
      if (!allowOrigin || isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'request forbidden' });
        return;
      }
      const clientIp = getClientIp(req);
      if (!rateLimiter.allow(`pb:${clientIp}`)) {
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
      const mediaType: 'movie' | 'tv' = rawType === 'tv' ? 'tv' : 'movie';
      const tmdbId = pick(['tmdb', 'tmdbId', 'id']);
      if (!tmdbId || !/^[A-Za-z0-9_-]{1,24}$/.test(tmdbId)) {
        sendJson(res, 400, { ok: false, error: 'valid tmdb parameter is required' }, allowOrigin);
        return;
      }

      const season = mediaType === 'tv' ? Math.max(1, Number(pick(['s', 'season'])) || 1) : undefined;
      const episode = mediaType === 'tv' ? Math.max(1, Number(pick(['e', 'ep', 'episode'])) || 1) : undefined;
      const sourceId = pick(['source']) || undefined;
      const preferredLang = pick(['lang']) || undefined;

      const headerTok = typeof req.headers['x-playback-token'] === 'string' ? req.headers['x-playback-token'] : '';
      const pltoken = headerTok || pick(['pltoken']);
      const nonce = pick(['nonce']) || undefined;

      if (cfg.requireToken) {
        const verified = verifyPlaybackToken(cfg.secret, req, pltoken, nonce, {
          mediaType,
          tmdbId,
          bindIp: cfg.bindTokenIp,
        });
        if (!verified.ok) {
          sendJson(res, 401, { ok: false, error: verified.reason }, allowOrigin);
          return;
        }
      }

      const resolved = await registry.resolvePlayback({
        type: mediaType,
        tmdbId,
        season,
        episode,
        sourceId,
        preferredLang,
      });

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
      if (!allowOrigin || isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'request forbidden' });
        return;
      }
      const clientIp = getClientIp(req);
      if (!rateLimiter.allow(`ep:${clientIp}`)) {
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
        if (!verified.ok) {
          sendJson(res, 401, { ok: false, error: verified.reason }, allowOrigin);
          return;
        }
      }

      const catalog = await fetchTmdbSeasonEpisodes(cfg.tmdb, { tmdbId, season });
      const payload = { ok: true as const, ...catalog };
      const wantEnvelope = req.headers['x-elfura-envelope'] === '1' && Boolean(pltoken && nonce);
      const responseBody = wantEnvelope ? sealPlaybackEnvelope(payload, pltoken, nonce!) : payload;
      sendJson(res, 200, responseBody, allowOrigin, wantEnvelope ? 'no-store' : 'manifest');
      return;
    }

    // 5. Uniform Stream Ingress / Egress Relay
    if ((method === 'GET' || method === 'HEAD') && pathname === '/api/v1/stream') {
      if (isLikelyAutomatedScraper(req, cfg.isProd)) {
        sendJson(res, 403, { ok: false, error: 'automated scraper blocked' });
        return;
      }
      const hasExplicitOriginOrRef = !!(req.headers.origin || req.headers.referer);
      const allowOrigin =
        resolveAllowedOrigin(req, cfg.allowedOrigins) ??
        (!hasExplicitOriginOrRef ? (cfg.allowedOrigins[0] ?? '*') : null);
      if (!allowOrigin) {
        sendJson(res, 403, { ok: false, error: 'origin not permitted' });
        return;
      }
      const ticketParam = url.searchParams.get('t') || '';
      const forceProxy = url.searchParams.get('p') === '1';
      await handleStreamRelay(req, res, {
        secret: cfg.secret,
        allowOrigin,
        ticketParam,
        streamPath: '/api/v1/stream',
        relayMode: cfg.relayMode,
        forceProxy,
        requireHttpsOffload: cfg.isProd,
      });
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

        const qTmdb = url.searchParams.get('tmdb')?.trim() || embedMatch.tmdbId || '*';
        const qTypeRaw = (url.searchParams.get('mediaType') || url.searchParams.get('type') || '').toLowerCase();
        const qMediaType =
          embedMatch.mediaType || (qTypeRaw === 'tv' ? 'tv' : qTypeRaw === 'movie' ? 'movie' : '*');

        const minted = mintPlaybackToken(cfg.secret, req, {
          mediaType: qMediaType,
          tmdbId: qTmdb,
          bindIp: cfg.bindTokenIp,
        });

        const bootData = {
          ...(embedMatch.mediaType ? { mediaType: embedMatch.mediaType } : {}),
          ...(embedMatch.tmdbId ? { tmdb: embedMatch.tmdbId } : {}),
          ...(embedMatch.season ? { season: embedMatch.season } : {}),
          ...(embedMatch.episode ? { episode: embedMatch.episode } : {}),
          pltoken: minted.pltoken,
          nonce: minted.nonce,
          ...((qMediaType === 'movie' || qMediaType === 'tv') && /^[A-Za-z0-9_-]{1,24}$/.test(qTmdb) ? { analyticsTicket: roxy.ticket(parentSite, qMediaType, qTmdb) } : {}),
        };

        // Escape `<` inside JSON to prevent script breakout
        const safeJson = JSON.stringify(bootData).replace(/</g, '\\u003c');
        const injected = tpl.replace(
          '</head>',
          `  <script>window.__ELFURA_BOOT__=${safeJson};</script>\n</head>`,
        );
        const buf = Buffer.from(injected, 'utf8');
        setCloudflareCache(res, 'no-store');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(buf.byteLength),
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'same-origin',
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
  });

  server.on('close', () => roxy.close());
  return { server, cfg, registry };
}

export function startBackendServer(overrides: Partial<BackendConfig> = {}) {
  const { server, cfg, registry } = createBackendServer(overrides);
  server.listen(cfg.port, cfg.host, () => {
    const sources = registry.listPublicSources().map((s) => s.id).join(', ') || 'none';
    console.log(`[elfura-backend] listening on http://${cfg.host}:${cfg.port} (sources: ${sources}; roxy: enabled)`);
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
        `relay=${cfg.relayMode} resolveTimeoutMs=${cfg.resolveTimeoutMs} ` +
        `source2VidRift=${hostOf(cfg.source1.riftOrigin)} source3VidSync=${hostOf(cfg.source3.origin)} source1VidBolt=${hostOf(cfg.source1.vidboltOrigin)}`,
    );
  });
  return { server, cfg, registry };
}

// Auto-start when invoked directly (`node dist/backend/index.js`)
const isDirectMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectMain) {
  startBackendServer();
}
