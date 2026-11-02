/**
 * Elfura Backend — Anti-Scraper Security & Stateless Stream Tickets
 * =================================================================
 * 1. HMAC-SHA256 Playback Tokens (`pltoken` + `nonce`) gate `/api/v1/playback`.
 * 2. AES-256-GCM Encrypted Stream Tickets (`?t=`) gate `/api/v1/stream`:
 *    - Raw upstream URLs, domains, cookies, and Referer/Origin headers are
 *      encrypted server-side so scrapers/DevTools cannot decode or tamper them.
 *    - Completely stateless: zero disk writes, zero per-ticket RAM usage.
 * 3. SSRF guard blocks loopback, private RFC1918, link-local, and metadata IPs.
 * 4. Bounded in-memory sliding-window rate limiter keyed by CF-Connecting-IP.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

/* ------------------------------------------------------------------ */
/* Client identity & Origin checks                                     */
/* ------------------------------------------------------------------ */

export function getClientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || '0.0.0.0';
}

function uaFingerprint(req: IncomingMessage): string {
  const ua = String(req.headers['user-agent'] || '');
  return crypto.createHash('sha256').update(ua).digest('base64url').slice(0, 12);
}

const BOT_UA_RE = /\b(curl|wget|python-requests|python-urllib|aiohttp|httpx|scrapy|go-http-client|libwww-perl)\b/i;

export function isLikelyAutomatedScraper(req: IncomingMessage, isProd: boolean): boolean {
  if (!isProd) return false;
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_UA_RE.test(ua)) return true;
  return false;
}

export function resolveAllowedOrigin(req: IncomingMessage, allowedOrigins: string[]): string | null {
  const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/+$/, '') : '';
  let refererOrigin = '';
  if (typeof req.headers.referer === 'string') {
    try {
      refererOrigin = new URL(req.headers.referer).origin;
    } catch {
      /* ignore malformed referer */
    }
  }

  if (allowedOrigins.includes('*')) {
    return originHeader || refererOrigin || '*';
  }

  const candidate = originHeader || refererOrigin;
  if (!candidate) {
    // Same-origin navigation (e.g. opening /embed directly in browser)
    const secSite = req.headers['sec-fetch-site'];
    if (secSite === 'same-origin' || secSite === 'none') return allowedOrigins[0] ?? '*';
    return null;
  }

  // Always permit same-host requests originating from Elfura's own /embed/* page
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (rawHost) {
    try {
      if (new URL(candidate).host.toLowerCase() === rawHost) {
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }

  return allowedOrigins.includes(candidate) ? candidate : null;
}

/* ------------------------------------------------------------------ */
/* Bounded in-memory rate limiter (zero disk)                          */
/* ------------------------------------------------------------------ */

export class SlidingWindowLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly maxKeys: number;
  private readonly windowMs: number;
  private readonly limit: number;

  constructor(limitPerMinute: number, maxKeys = 4096, windowMs = 60_000) {
    this.limit = limitPerMinute;
    this.maxKeys = maxKeys;
    this.windowMs = windowMs;
  }

  allow(key: string): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      if (this.buckets.size >= this.maxKeys) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    existing.count += 1;
    return existing.count <= this.limit;
  }
}

/* ------------------------------------------------------------------ */
/* Playback Session Tokens (`pltoken` + `nonce`)                       */
/* ------------------------------------------------------------------ */

export interface PlaybackTokenClaims {
  /** 'movie' | 'tv' | '*' */
  m: string;
  /** tmdbId or '*' */
  id: string;
  /** nonce */
  n: string;
  /** ua hash */
  u: string;
  /** optional ip hash */
  ip?: string;
  /** unix seconds expiry */
  exp: number;
}

export function mintPlaybackToken(
  secret: Buffer,
  req: IncomingMessage,
  scope: { mediaType?: string; tmdbId?: string; bindIp?: boolean; ttlSec?: number } = {},
): { pltoken: string; nonce: string; exp: number } {
  const nonce = crypto.randomBytes(9).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + (scope.ttlSec ?? 7200);
  const claims: PlaybackTokenClaims = {
    m: scope.mediaType || '*',
    id: scope.tmdbId || '*',
    n: nonce,
    u: uaFingerprint(req),
    ...(scope.bindIp
      ? { ip: crypto.createHash('sha256').update(getClientIp(req)).digest('base64url').slice(0, 12) }
      : {}),
    exp,
  };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return { pltoken: `${body}.${sig}`, nonce, exp };
}

export function verifyPlaybackToken(
  secret: Buffer,
  req: IncomingMessage,
  pltoken: string | undefined,
  nonce: string | undefined,
  expected: { mediaType: string; tmdbId: string; bindIp?: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (!pltoken) return { ok: false, reason: 'missing playback token' };
  const dot = pltoken.indexOf('.');
  if (dot < 1) return { ok: false, reason: 'malformed playback token' };

  const body = pltoken.slice(0, dot);
  const sig = pltoken.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(body).digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'invalid token signature' };
  }

  let claims: PlaybackTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PlaybackTokenClaims;
  } catch {
    return { ok: false, reason: 'corrupt token claims' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || now > claims.exp) return { ok: false, reason: 'playback token expired' };
  if (nonce && claims.n && nonce !== claims.n) return { ok: false, reason: 'nonce mismatch' };
  if (claims.m !== '*' && claims.m !== expected.mediaType) return { ok: false, reason: 'media type scope mismatch' };
  if (claims.id !== '*' && claims.id !== expected.tmdbId) return { ok: false, reason: 'media id scope mismatch' };
  if (claims.u && claims.u !== uaFingerprint(req)) return { ok: false, reason: 'client fingerprint mismatch' };
  if (expected.bindIp && claims.ip) {
    const ipHash = crypto.createHash('sha256').update(getClientIp(req)).digest('base64url').slice(0, 12);
    if (claims.ip !== ipHash) return { ok: false, reason: 'client ip mismatch' };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* AES-256-GCM Stateless Stream Tickets                                */
/* ------------------------------------------------------------------ */

export interface StreamTicketPayload {
  /** Raw upstream URL (or 'inline' when carrying inline manifest). */
  u: string;
  /** Upstream request headers to attach server-side (Referer, Origin, UA, Cookie). */
  h?: Record<string, string>;
  /** Hint: 'm' = manifest, 's' = subtitle, 'a' = asset/segment */
  k?: 'm' | 's' | 'a';
  /** Unix seconds expiration. */
  exp: number;
}

const COMP_FLAG_RAW = 0x00;
const COMP_FLAG_DEFLATE = 0x01;

export function sealStreamTicket(secret: Buffer, payload: Omit<StreamTicketPayload, 'exp'> & { exp?: number }, ttlSec = 14_400): string {
  const full: StreamTicketPayload = {
    ...payload,
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + ttlSec,
  };
  const jsonBytes = Buffer.from(JSON.stringify(full), 'utf8');
  const useDeflate = jsonBytes.length > 140;
  const body = useDeflate ? zlib.deflateRawSync(jsonBytes) : jsonBytes;
  const plain = Buffer.concat([Buffer.from([useDeflate ? COMP_FLAG_DEFLATE : COMP_FLAG_RAW]), body]);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function openStreamTicket(secret: Buffer, ticket: string): StreamTicketPayload | null {
  if (!ticket || ticket.length < 40) return null;
  try {
    const buf = Buffer.from(ticket, 'base64url');
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    if (!plain.length) return null;

    const flag = plain[0];
    const raw = flag === COMP_FLAG_DEFLATE ? zlib.inflateRawSync(plain.subarray(1)) : plain.subarray(1);
    const parsed = JSON.parse(raw.toString('utf8')) as StreamTicketPayload;
    if (!parsed || typeof parsed.u !== 'string' || typeof parsed.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* SSRF Guard                                                          */
/* ------------------------------------------------------------------ */

export function isSafeUpstreamUrl(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  const allowTestLoopback =
    process.env.NODE_ENV === 'test' && process.env.ELFURA_ALLOW_LOOPBACK_TEST === '1';
  if (!allowTestLoopback && (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1')) {
    return false;
  }
  // IPv6 loopback / unique-local / link-local
  if ((!allowTestLoopback && host === '::1') || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    return false;
  }
  // IPv4 private / loopback / link-local / CGNAT / metadata
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (allowTestLoopback && a === 127) return true;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    ) {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Cloudflare Edge Cache & CORS Helpers                                */
/* ------------------------------------------------------------------ */

export function applyCorsHeaders(res: ServerResponse, allowOrigin: string): void {
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  if (allowOrigin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Playback-Token, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

export function setCloudflareCache(
  res: ServerResponse,
  policy: 'no-store' | 'manifest' | 'segment' | 'subtitle' | 'immutable',
): void {
  switch (policy) {
    case 'no-store':
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('CDN-Cache-Control', 'no-store');
      break;
    case 'manifest':
      // Short edge TTL so token/signature refreshes stay live while shielding bursts
      res.setHeader('Cache-Control', 'public, max-age=20, s-maxage=45, stale-while-revalidate=30');
      res.setHeader('CDN-Cache-Control', 'public, max-age=45');
      break;
    case 'subtitle':
      res.setHeader('Cache-Control', 'public, max-age=1800, s-maxage=3600');
      res.setHeader('CDN-Cache-Control', 'public, max-age=3600');
      break;
    case 'segment':
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=14400');
      res.setHeader('CDN-Cache-Control', 'public, max-age=14400');
      break;
    case 'immutable':
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('CDN-Cache-Control', 'public, max-age=31536000, immutable');
      break;
  }
}
