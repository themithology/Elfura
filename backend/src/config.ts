/**
 * Elfura Backend — Runtime Configuration (Part 2)
 * ===============================================
 * Designed for Pterodactyl container hosting behind a Cloudflare proxy:
 *   - Binds to 0.0.0.0 using SERVER_PORT (Pterodactyl) -> PORT -> 8787
 *   - Zero local disk paths / cache directories
 *   - All secrets & upstream base URLs driven by environment variables
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BackendConfig {
  host: string;
  port: number;
  isProd: boolean;
  /** Master secret for HMAC session tokens and AES-256-GCM stream tickets. */
  secret: Buffer;
  /** Allowed parent/embed origins ('*' permits any origin). */
  allowedOrigins: string[];
  /** Require signed X-Playback-Token / pltoken on /api/v1/playback. */
  requireToken: boolean;
  /** Strictly bind playback tokens to CF-Connecting-IP / client IP. */
  bindTokenIp: boolean;
  /** Per-IP requests per minute on resolution endpoints. */
  rateLimitPerMin: number;
  /** Max time to wait for source adapters before returning available streams. */
  resolveTimeoutMs: number;
  /**
   * Stream segment delivery mode:
   *  - 'hybrid' (default): manifests/subtitles/keys + header-locked or source-identifying
   *    streams relay via `/api/v1/stream`, while verified anonymous CORS-safe HTTPS
   *    segments offload directly to upstream edge CDNs (Cloudflare & VPS safe).
   *  - 'full': pipe 100% of manifests and binary segments through `/api/v1/stream`.
   */
  relayMode: 'hybrid' | 'full';
  /** Self-hosted TMDB API configuration. */
  tmdb: {
    apiBase: string;
    apiKey: string;
    bearerToken: string;
    imageBase: string;
    timeoutMs: number;
  };
  /** Source 1 configurable endpoints (kept purely server-side). */
  source1: {
    enabled: boolean;
    riftOrigin: string;
    vidboltOrigin?: string;
    riftRelay: string;
    syncOrigin: string;
    vidrockOrigin?: string;
  };
  /** Source 2 configurable endpoints (kept purely server-side). */
  source2: {
    enabled: boolean;
    embedOrigin: string;
    defaultServer: string;
    nxshaOrigin?: string;
    vidstuckOrigin?: string;
  };
  /** Source 3 configurable endpoint (kept purely server-side). */
  source3: {
    enabled: boolean;
    origin: string;
  };

  /** Optional experimental Source 4 HLS fallback. */
  source4?: { enabled: boolean };
  source5?: { enabled: boolean };
  /** Experimental additional source controls. */
  source7?: { enabled: boolean };
  source8?: { enabled: boolean };
  source9?: { enabled: boolean };
  source10?: { enabled: boolean };
  source11?: { enabled: boolean };
  source12?: { enabled: boolean };
  source13?: { enabled: boolean };
  source14?: { enabled: boolean };
  source15?: { enabled: boolean };
  source16?: { enabled: boolean };
  /** AniVortex (signed installation) — off unless explicitly enabled AND credentials exist. */
  source17?: { enabled: boolean };
  /** Experimental additional source controls (sources 18-21). */
  source18?: { enabled: boolean };
  source19?: { enabled: boolean };
  source20?: { enabled: boolean };
  source21?: { enabled: boolean };
  /** Vidly subtitle index. Subtitles only: it never contributes a stream. */
  source22?: { enabled: boolean };

  /**
   * VidLink. A real JSON API (measured: /api/b returns application/json), so it
   * is a cheap deterministic lane rather than a scrape.
   */
  source24: {
    enabled: boolean;
    origin: string;
    timeoutMs: number;
    /** Comes through a third-party API front, so it must not outrank origin CDNs. */
    rank: number;
  };

  /**
   * Greybox. Plain JSON with no token or encryption, and per-stream language
   * labels, so it is both the cheapest lane and the most useful for
   * multi-language titles.
   */
  source25: {
    enabled: boolean;
    origin: string;
    timeoutMs: number;
    /** Aggregates third-party providers, so it sits behind direct CDNs. */
    rank: number;
  };


  /** Automatic OpenSubtitles fallback configuration (zero-disk RAM cached). */
  subtitles: {
    enabled: boolean;
    openSubtitlesBase: string;
    timeoutMs: number;
  };
  /**
   * Whole-site redirect to a new domain.
   *
   * `from` lists the hosts this deployment answers for; `to` is the host that
   * should serve them from now on. A lookup that does not match `from` is never
   * redirected, so a redirect left switched on cannot break access through the
   * new domain later - the classic way a migration locks its owner out.
   */
  redirect: {
    to: string;
    from: string[];
    status: 301 | 302;
    /** Paths that must keep answering on the old host. */
    keep: string[];
    /**
     * Path prefixes that redirect. Empty means the whole host.
     *
     * This is what makes "move the embeds to embed.example.to" expressible
     * without moving the main site: the same domain can keep serving its pages
     * while only /embed/* and /player* point somewhere else.
     */
    paths: string[];
  };
}

function parseOrigins(raw?: string): string[] {
  if (!raw || !raw.trim()) return ['*'];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Parse ELFURA_REDIRECT_TO into a host (or host+path prefix).
 *
 * Accepts `def.com`, `def.com/`, `https://def.com`, `https://def.com/watch`.
 * Returns '' when unset, and refuses anything that is not an http(s) target so a
 * typo cannot turn every page into an unfollowable Location header.
 */
export function parseRedirectTarget(raw?: string): { host: string; baseUrl: string } | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  // Keep any path the operator gave us (a redirect to /watch is legal), but drop
  // the query and hash: those belong to the request being redirected.
  const basePath = parsed.pathname.replace(/\/+$/, '');
  return {
    host: parsed.host.toLowerCase(),
    baseUrl: `${parsed.protocol}//${parsed.host}${basePath}`,
  };
}

/** Hostnames (lowercased) that ELFURA_REDIRECT_TO should be applied to. */
export function parseRedirectHosts(raw?: string, target?: string | null): string[] {
  const listed = (raw || '')
    .split(/[,\s]+/)
    .map((entry) => {
      const parsed = parseRedirectTarget(entry);
      return parsed ? parsed.host : '';
    })
    .filter(Boolean);
  // A single-host install should not have to name itself: with no list, the
  // redirect applies to every request that is not already aimed at the target,
  // which is the behaviour of a "this domain moved" switch.
  return listed.filter((host) => host !== (target || '').toLowerCase());
}

const PLACEHOLDER_SECRET_RE = /^(?:replace-with-|changeme|your-secret|example|<)/i;

/** True when a real (non-placeholder) ELFURA_SECRET is set via env or .env. */
export function hasConfiguredSecret(): boolean {
  const merged = { ...readDotEnvOverlay(), ...process.env };
  return isConfiguredSecret(merged.ELFURA_SECRET);
}

function isConfiguredSecret(raw?: string): boolean {
  const trimmed = raw?.trim() || '';
  return trimmed.length > 0 && !PLACEHOLDER_SECRET_RE.test(trimmed);
}

function deriveSecret(raw?: string): Buffer {
  const seed = isConfiguredSecret(raw)
    ? raw!.trim()
    : 'elfura-ephemeral-' + crypto.randomBytes(24).toString('hex');
  return crypto.createHash('sha256').update(seed).digest();
}

export function readDotEnvOverlay(): Record<string, string> {
  const out: Record<string, string> = {};
  const candidates = [
    path.resolve(__dirname, '../../.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const dotEnvPath of candidates) {
    try {
      if (!fs.existsSync(dotEnvPath)) continue;
      const raw = fs.readFileSync(dotEnvPath, 'utf8');
      for (const rawLine of raw.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const cleaned = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
        const eq = cleaned.indexOf('=');
        if (eq < 1) continue;
        const key = cleaned.slice(0, eq).trim();
        let val = cleaned.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (key) out[key] = val;
      }
    } catch {
      /* non-fatal if .env is unreadable */
    }
  }
  return out;
}

export function loadBackendConfig(envInput?: NodeJS.ProcessEnv): BackendConfig {
  const env: NodeJS.ProcessEnv = envInput ?? {
    ...readDotEnvOverlay(),
    ...process.env,
  };
  const isProd = env.NODE_ENV === 'production';
  if (isProd && !isConfiguredSecret(env.ELFURA_SECRET)) {
    console.warn('[elfura-backend] ELFURA_SECRET is not set (or uses placeholder); generated an ephemeral per-boot key.');
  }

  const portRaw = Number(env.SERVER_PORT || env.PORT || 8787);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 8787;

  return {
    host: env.HOST || '0.0.0.0',
    port,
    isProd,
    secret: deriveSecret(env.ELFURA_SECRET),
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    requireToken: env.REQUIRE_PLAYBACK_TOKEN !== '0',
    bindTokenIp: env.BIND_TOKEN_IP === '1',
    rateLimitPerMin: Math.max(10, Number(env.RATE_LIMIT_PER_MIN || 120)),
    resolveTimeoutMs: Math.max(2000, Number(env.RESOLVE_TIMEOUT_MS || 9000)),
    relayMode: (env.RELAY_MODE || 'hybrid').trim().toLowerCase() === 'full' ? 'full' : 'hybrid',
    tmdb: {
      apiBase: (env.TMDB_API_BASE || env.TMDB_API_BASE_URL || '').trim().replace(/\/+$/, ''),
      apiKey: (env.TMDB_API_KEY || '').trim(),
      bearerToken: (env.TMDB_BEARER_TOKEN || '').trim(),
      imageBase: (env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p').trim().replace(/\/+$/, ''),
      timeoutMs: Math.max(1000, Number(env.TMDB_TIMEOUT_MS || 4500)),
    },
    source1: {
      enabled: env.SOURCE1_ENABLED !== '0',
      riftOrigin: (env.SOURCE1_RIFT_ORIGIN || 'https://embed.vidrift.in').replace(/\/+$/, ''),
      vidboltOrigin: (env.SOURCE1_VIDBOLT_ORIGIN || 'https://vidbolt.xyz').replace(/\/+$/, ''),
      riftRelay: (env.SOURCE1_RIFT_RELAY || '').replace(/\/+$/, ''),
      syncOrigin: (env.SOURCE1_SYNC_ORIGIN || 'https://vidsync.pro').replace(/\/+$/, ''),
      vidrockOrigin: (env.SOURCE1_VIDROCK_ORIGIN || 'https://vidrock.net').replace(/\/+$/, ''),
    },
    // Legacy Source 2 configuration is retained in the type only; old panel
    // environment variables must never reactivate the removed providers.
    source2: {
      enabled: false,
      embedOrigin: '',
      defaultServer: 'orion',
      nxshaOrigin: '',
      vidstuckOrigin: '',
    },
    source3: {
      enabled: env.SOURCE3_ENABLED !== '0',
      // SOURCE1_SYNC_ORIGIN is accepted as a legacy alias because VidSync
      // used to be an internal Source 1 lane before becoming Source 3.
      origin: (
        env.SOURCE3_ORIGIN ||
        env.VIDSYNC_ORIGIN ||
        env.SOURCE1_SYNC_ORIGIN ||
        'https://vidsync.pro'
      ).replace(/\/+$/, ''),
    },
    source4: { enabled: env.ELFURA_BINGR_ENABLED !== '0' },
    source5: { enabled: env.ELFURA_NXSHA_ENABLED !== '0' },
    // Merged into source-5 as a second lane set. Default off, matching the
    // `?? false` gate the standalone adapter used to carry.
    source7: { enabled: env.ELFURA_SCREENSCAPE_ENABLED === '1' },
    source8: { enabled: env.ELFURA_VIDZEE_ENABLED !== '0' },
    source9: { enabled: env.ELFURA_VIXSRC_ENABLED !== '0' },
    source10: { enabled: env.ELFURA_VIDNEST_ENABLED !== '0' },
    source11: { enabled: env.ELFURA_VAPLAYER_ENABLED !== '0' },
    source12: { enabled: env.ELFURA_VIDZEN_ENABLED !== '0' },
    source13: { enabled: env.ELFURA_XPASS_ENABLED !== '0' },
    source14: { enabled: env.ELFURA_RIVE_CITADEL_ENABLED !== '0' },
    source15: { enabled: env.ELFURA_MAPPLE_ENABLED !== '0' },
    source16: { enabled: env.ELFURA_ANIVEXA_ENABLED !== '0' },
    // AniVortex signs every request with installation credentials. Without them
    // the adapter returns in microseconds, so it simply stays on: no toggles to
    // maintain, no cost when the credentials are absent.
    source17: { enabled: env.ELFURA_ANIVORTEX_ENABLED !== '0' },
    source18: { enabled: env.ELFURA_SUBDUB_ENABLED !== '0' },
    source19: { enabled: env.ELFURA_DESIDUB_ENABLED !== '0' },
    source20: { enabled: env.ELFURA_VIDORA_ENABLED !== '0' },
    source21: { enabled: env.ELFURA_WATCHOUT_ENABLED !== '0' },
    source22: { enabled: env.ELFURA_VIDLY_SUBS_ENABLED !== '0' },
    source24: {
      enabled: env.ELFURA_VIDLINK_ENABLED !== '0',
      origin: (env.ELFURA_VIDLINK_ORIGIN || 'https://vidlink.pro/api/b').replace(/\/+$/, ''),
      timeoutMs: Math.max(3000, Number(env.ELFURA_VIDLINK_TIMEOUT_MS || 12_000)),
      rank: 55,
    },
    source25: {
      enabled: env.ELFURA_GREYBOX_ENABLED !== '0',
      origin: (env.ELFURA_GREYBOX_ORIGIN || 'https://greyboxtv.duckdns.org').replace(/\/+$/, ''),
      timeoutMs: Math.max(3000, Number(env.ELFURA_GREYBOX_TIMEOUT_MS || 12_000)),
      rank: 50,
    },
    redirect: {
      // ELFURA_REDIRECT_TO=def.com  (or https://def.com/any/base/path)
      // Empty means off, which is the default: nothing changes until it is set.
      ...(() => {
        const target = parseRedirectTarget(env.ELFURA_REDIRECT_TO);
        // Empty by default. /api and /roxy are exempted in the middleware itself
        // because they are load-bearing; anything else the operator wants pinned
        // to the old host has to be said out loud. A non-empty default here also
        // silently defeated ELFURA_REDIRECT_PATHS=/player, since keep was checked
        // first and /player was in it.
        const keepRaw = (env.ELFURA_REDIRECT_KEEP || '').trim();
        const list = (raw: string) =>
          raw
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
        return {
          to: target ? target.baseUrl : '',
          from: target ? parseRedirectHosts(env.ELFURA_REDIRECT_FROM, target.baseUrl) : [],
          status: (Number(env.ELFURA_REDIRECT_STATUS || 301) === 302 ? 302 : 301) as 301 | 302,
          keep: list(keepRaw),
          // Empty means the whole host, which is the documented behaviour of
          // setting ELFURA_REDIRECT_TO on its own. Scoping is opt-in so this
          // addition cannot change what an existing config does.
          paths: list((env.ELFURA_REDIRECT_PATHS || '').trim()),
        };
      })(),
    },
    subtitles: {
      enabled: env.OPENSUBTITLES_ENABLED !== '0',
      openSubtitlesBase: (env.OPENSUBTITLES_BASE || 'https://opensubtitles-v3.strem.io')
        .trim()
        .replace(/\/+$/, ''),
      timeoutMs: Math.max(800, Number(env.OPENSUBTITLES_TIMEOUT_MS || 2800)),
    },
  };
}
