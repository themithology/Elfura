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
  /** Master secret for HMAC session tokens and the sealed playback envelope. */
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
   * Public path of the single raw-stream proxy. Every manifest, key,
   * subtitle and media segment is served through this one stateless route.
   */
  streamProxyPath: string;
  /** Self-hosted TMDB API configuration. */
  tmdb: {
    apiBase: string;
    apiKey: string;
    bearerToken: string;
    imageBase: string;
    timeoutMs: number;
  };
  /**
   * There is no per-source configuration here any more, and that is deliberate.
   *
   * Every lane used to get a hand-written block in this file — thirty of them,
   * with origins, timeouts, ranks and switches — and the file became a second
   * registry that had to be edited in lockstep with the first. A lane now lives
   * in one place (`sources/index.ts`) and reads its own settings from the
   * environment through `sourceEnv()`, so mounting a source cannot leave a
   * stale config block behind and removing one cannot orphan an env var.
   *
   * If a future source needs a setting the operator can tune, it reads it in
   * its own module; only settings shared by the whole service belong here.
   */

  /** Automatic OpenSubtitles fallback configuration (zero-disk RAM cached). */
  subtitles: {
    enabled: boolean;
    openSubtitlesBase: string;
    timeoutMs: number;
  };
  /**
   * Whole-site redirect to a new domain (ELFURA_REDIRECT_TO), or '' for off.
   * Only the host is replaced; path and query are kept as they are.
   */
  redirectTo: string;
}

function parseOrigins(raw?: string): string[] {
  if (!raw || !raw.trim()) return ['*'];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Turn ELFURA_REDIRECT_TO into an origin, or '' when unset.
 *
 * Accepts `def.com`, `def.com/`, `https://def.com` and returns `https://def.com`.
 * Only the host is used: the request's own path is what gets appended, so a
 * base path in the setting would be a second, conflicting source of truth.
 */
export function parseRedirectTo(raw?: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (!parsed.hostname) return '';
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
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

/**
 * Publish .env entries into process.env, so code that reads process.env directly
 * can see them.
 *
 * This exists because of a bug that hid for a long time: loadBackendConfig merged
 * the .env overlay into a LOCAL object and returned it, while a dozen modules
 * (the resolver split, DNS, caching, the runtime toggles) read process.env
 * straight. The effect was that every one of those variables worked when set as a
 * real environment variable and was silently ignored when set in .env - with no
 * error anywhere, just a feature that quietly did not engage.
 *
 * Precedence is deliberate and the same as loadBackendConfig's: a real
 * environment variable always wins over the file. The file only fills gaps.
 */
export function hydrateProcessEnvFromDotEnv(): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  const overlay = readDotEnvOverlay();
  for (const [key, value] of Object.entries(overlay)) {
    if (process.env[key] !== undefined && process.env[key] !== '') {
      // A real environment variable outranks the file; this is not an error.
      if (process.env[key] !== value) skipped.push(key);
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }
  return { applied, skipped };
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
    // 0 disables viewer-facing rate limiting entirely (the default). A positive
    // number caps requests per minute per client IP. See the note at the call
    // site in index.ts for why the cap is off.
    rateLimitPerMin: Math.max(0, Number(env.RATE_LIMIT_PER_MIN || 0)),
    resolveTimeoutMs: Math.max(2000, Number(env.RESOLVE_TIMEOUT_MS || 9000)),
    streamProxyPath: (env.ELFURA_STREAM_PROXY_PATH || '/api/proxy').trim() || '/api/proxy',
    tmdb: {
      apiBase: (env.TMDB_API_BASE || env.TMDB_API_BASE_URL || '').trim().replace(/\/+$/, ''),
      apiKey: (env.TMDB_API_KEY || '').trim(),
      bearerToken: (env.TMDB_BEARER_TOKEN || '').trim(),
      imageBase: (env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p').trim().replace(/\/+$/, ''),
      timeoutMs: Math.max(1000, Number(env.TMDB_TIMEOUT_MS || 4500)),
    },
    redirectTo: parseRedirectTo(env.ELFURA_REDIRECT_TO),
    subtitles: {
      enabled: env.OPENSUBTITLES_ENABLED !== '0',
      openSubtitlesBase: (env.OPENSUBTITLES_BASE || 'https://opensubtitles-v3.strem.io')
        .trim()
        .replace(/\/+$/, ''),
      timeoutMs: Math.max(800, Number(env.OPENSUBTITLES_TIMEOUT_MS || 2800)),
    },
  };
}
