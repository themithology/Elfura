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
    appOrigin: string;
    apiOrigin: string;
    riftOrigin: string;
    riftRelay: string;
    syncOrigin: string;
    vidlinkOrigin?: string;
    encDecOrigin?: string;
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

  /** Automatic OpenSubtitles fallback configuration (zero-disk RAM cached). */
  subtitles: {
    enabled: boolean;
    openSubtitlesBase: string;
    timeoutMs: number;
  };
}

function parseOrigins(raw?: string): string[] {
  if (!raw || !raw.trim()) return ['*'];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
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

function readDotEnvOverlay(): Record<string, string> {
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
      appOrigin: (env.SOURCE1_APP_ORIGIN || 'https://tgvid.lovable.app').replace(/\/+$/, ''),
      apiOrigin: (env.SOURCE1_API_ORIGIN || '').replace(/\/+$/, ''),
      riftOrigin: (env.SOURCE1_RIFT_ORIGIN || '').replace(/\/+$/, ''),
      riftRelay: (env.SOURCE1_RIFT_RELAY || '').replace(/\/+$/, ''),
      syncOrigin: (env.SOURCE1_SYNC_ORIGIN || 'https://vidsync.pro').replace(/\/+$/, ''),
      vidlinkOrigin: (env.SOURCE1_VIDLINK_ORIGIN || 'https://vidlink.pro').replace(/\/+$/, ''),
      encDecOrigin: (env.SOURCE1_ENCDEC_ORIGIN || 'https://enc-dec.app').replace(/\/+$/, ''),
      vidrockOrigin: (env.SOURCE1_VIDROCK_ORIGIN || 'https://vidrock.net').replace(/\/+$/, ''),
    },
    source2: {
      enabled: env.SOURCE2_ENABLED !== '0',
      embedOrigin: (env.SOURCE2_EMBED_ORIGIN || '').replace(/\/+$/, ''),
      defaultServer: (env.SOURCE2_DEFAULT_SERVER || 'orion').trim() || 'orion',
      nxshaOrigin: (env.SOURCE2_NXSHA_ORIGIN || 'https://nxsha.space').replace(/\/+$/, ''),
      vidstuckOrigin: (env.SOURCE2_VIDSTUCK_ORIGIN || 'https://vidstuck.cc').replace(/\/+$/, ''),
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
