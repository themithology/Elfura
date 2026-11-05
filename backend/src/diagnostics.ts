/**
 * Elfura Backend — Operator Diagnostics (`GET /api/v1/diagnostics`)
 * ================================================================
 * JSON snapshot of what the backend can actually reach and resolve, for the
 * server operator. Contains NO secrets, NO upstream URLs, and NO provider
 * names: upstream hosts are reported as short SHA-256 hashes, config as
 * booleans/host-hashes, and source lanes as opaque codes. Results are
 * cached briefly so the endpoint cannot be used to hammer upstreams.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasConfiguredSecret, type BackendConfig } from './config.js';
import type { SourceRegistry } from './sources/registry.js';
import { fetchTmdbCatalog, fetchTmdbMetadata } from './tmdb.js';

export interface DiagnosticsProbe {
  type: 'movie' | 'tv';
  tmdbId: string;
  season: number;
  episode: number;
}

let buildInfoCache: { commit: string } | null = null;
/** Commit stamp written into the deployment ZIP at packaging time. */
export function readBuildInfo(): { commit: string } {
  if (buildInfoCache) return buildInfoCache;
  let commit = process.env.ELFURA_BUILD || 'unknown';
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, '../../build-info.json'),
      path.resolve(process.cwd(), 'build-info.json'),
    ];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { commit?: string };
      if (parsed.commit) {
        commit = parsed.commit;
        break;
      }
    }
  } catch {
    /* keep fallback */
  }
  buildInfoCache = { commit };
  return buildInfoCache;
}

const DIAG_CACHE_TTL_MS = 45_000;
let cached: { key: string; expiresAt: number; value: unknown } | null = null;
let inFlight: { key: string; promise: Promise<unknown> } | null = null;

function hostHash(raw?: string): string | null {
  if (!raw) return null;
  try {
    const host = new URL(raw).host;
    return crypto.createHash('sha256').update(host).digest('hex').slice(0, 12);
  } catch {
    return 'invalid';
  }
}

async function probeOrigin(role: string, origin?: string): Promise<Record<string, unknown>> {
  if (!origin) return { role, configured: false };
  const t0 = Date.now();
  try {
    const res = await fetch(origin, {
      method: 'GET',
      headers: { 'User-Agent': 'ElfuraDiagnostics/1.0', Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(3500),
    });
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return {
      role,
      configured: true,
      host: hostHash(origin),
      reachable: true,
      status: res.status,
      ms: Date.now() - t0,
    };
  } catch (err) {
    const cause = (err as { cause?: { code?: string } })?.cause;
    return {
      role,
      configured: true,
      host: hostHash(origin),
      reachable: false,
      error: err instanceof Error ? err.name : 'error',
      ...(cause?.code ? { cause: cause.code } : {}),
      ms: Date.now() - t0,
    };
  }
}

async function collect(cfg: BackendConfig, registry: SourceRegistry, probe: DiagnosticsProbe) {
  const started = Date.now();
  const tmdbBase = cfg.tmdb.apiBase || 'https://api.themoviedb.org/3';

  const [origins, tmdbMeta, catalog, sources] = await Promise.all([
    Promise.all([
      probeOrigin('tmdb', tmdbBase),
      probeOrigin('s1-app', cfg.source1.appOrigin),
      probeOrigin('s1-api', cfg.source1.apiOrigin),
      probeOrigin('s1-rift', cfg.source1.riftOrigin),
      probeOrigin('s1-sync', cfg.source1.syncOrigin),
      probeOrigin('s1-link', cfg.source1.vidlinkOrigin),
      probeOrigin('s1-rock', cfg.source1.vidrockOrigin),
      probeOrigin('s2-embed', cfg.source2.embedOrigin),
      probeOrigin('s2-nx', cfg.source2.nxshaOrigin),
      probeOrigin('s2-vs', cfg.source2.vidstuckOrigin),
      probeOrigin('subtitles', cfg.subtitles.openSubtitlesBase),
    ]),
    (async () => {
      const t0 = Date.now();
      const meta = await fetchTmdbMetadata(cfg.tmdb, {
        type: probe.type,
        tmdbId: probe.tmdbId,
        season: probe.season,
        episode: probe.episode,
      });
      return {
        ms: Date.now() - t0,
        titleFound: !!meta.title,
        year: meta.year || null,
        imdbFound: !!meta.imdbId,
        posterFound: !!meta.poster,
      };
    })(),
    (async () => {
      const t0 = Date.now();
      const cat = await fetchTmdbCatalog(cfg.tmdb);
      return {
        ms: Date.now() - t0,
        movies: cat.movies.length,
        series: cat.series.length,
        anime: cat.anime.length,
      };
    })(),
    registry.diagnosePlayback(probe),
  ]);

  const hints: string[] = [];
  if (!tmdbMeta.titleFound) hints.push('tmdb-metadata-not-resolving');
  if (!catalog.movies && !catalog.series && !catalog.anime) hints.push('tmdb-catalog-empty');
  for (const a of sources.adapters) {
    if (a.raw === 0) hints.push(`${a.id}-returned-zero-candidates`);
    else if (a.verified === 0) hints.push(`${a.id}-candidates-all-failed-liveness`);
  }
  for (const o of origins) {
    if (o.configured && o.reachable === false) hints.push(`origin-unreachable:${o.role}`);
  }
  if (!hasConfiguredSecret()) hints.push('elfura-secret-not-configured-ephemeral');

  return {
    ok: true,
    build: readBuildInfo(),
    generatedAt: new Date().toISOString(),
    totalMs: Date.now() - started,
    runtime: { node: process.version, uptimeSec: Math.round(process.uptime()) },
    probe,
    config: {
      secretConfigured: hasConfiguredSecret(),
      relayMode: cfg.relayMode,
      resolveTimeoutMs: cfg.resolveTimeoutMs,
      requireToken: cfg.requireToken,
      allowedOrigins: cfg.allowedOrigins,
      tmdb: {
        baseConfigured: !!cfg.tmdb.apiBase,
        baseHost: hostHash(tmdbBase),
        keyConfigured: !!(cfg.tmdb.apiKey || cfg.tmdb.bearerToken),
        imageHost: hostHash(cfg.tmdb.imageBase),
      },
      sourcesEnabled: registry.listPublicSources().map((s) => s.id),
    },
    tmdb: tmdbMeta,
    catalog,
    origins,
    sources: sources.adapters,
    lanes: sources.lanes,
    hints,
  };
}

export function collectDiagnostics(
  cfg: BackendConfig,
  registry: SourceRegistry,
  probe: DiagnosticsProbe,
): Promise<unknown> {
  const key = `${probe.type}:${probe.tmdbId}:${probe.season}:${probe.episode}`;
  if (cached && cached.key === key && Date.now() <= cached.expiresAt) {
    return Promise.resolve(cached.value);
  }
  if (inFlight && inFlight.key === key) return inFlight.promise;
  const promise = collect(cfg, registry, probe)
    .then((value) => {
      cached = { key, expiresAt: Date.now() + DIAG_CACHE_TTL_MS, value };
      return value;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return promise;
}
