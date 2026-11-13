/**
 * Playback-focused operator diagnostics (`GET /diagnose`).
 *
 * This reports the actual title lookup, source resolution, selected stream
 * candidates, HLS/DASH/MP4 probes, and a bounded byte-range read from sample
 * media segments. It intentionally does not probe unrelated provider root
 * domains: a 200/404 at a homepage says nothing about whether this title plays.
 * Raw URLs, response bodies, upstream headers, and credentials never leave the
 * server. A successful server-side segment read is not browser playback proof.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasConfiguredSecret, type BackendConfig } from './config.js';
import type { SourceRegistry } from './sources/registry.js';
import { fetchTmdbMetadata } from './tmdb.js';

export interface DiagnosticsProbe {
  type: 'movie' | 'tv';
  tmdbId: string;
  season: number;
  episode: number;
  lang?: string;
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

const DIAG_CACHE_TTL_MS = 12_000;
let cached: { key: string; expiresAt: number; createdAt: number; value: unknown } | null = null;
let inFlight: { key: string; promise: Promise<unknown> } | null = null;

async function collect(cfg: BackendConfig, registry: SourceRegistry, probe: DiagnosticsProbe) {
  const started = Date.now();
  const [meta, playback] = await Promise.all([
    (async () => {
      const t0 = Date.now();
      const result = await fetchTmdbMetadata(cfg.tmdb, {
        type: probe.type,
        tmdbId: probe.tmdbId,
        season: probe.season,
        episode: probe.episode,
      });
      return {
        ms: Date.now() - t0,
        titleFound: !!result.title,
        title: result.title || null,
        year: result.year || null,
        imdbFound: !!result.imdbId,
      };
    })(),
    registry.diagnosePlayback({
      type: probe.type,
      tmdbId: probe.tmdbId,
      season: probe.season,
      episode: probe.episode,
      preferredLang: probe.lang,
    }),
  ]);

  const hints: string[] = [];
  if (!meta.titleFound) hints.push('tmdb-identity-lookup-failed');
  if (!playback.selected.length) hints.push('no-stream-candidate-selected');
  const emptySources = playback.adapters.filter(a => a.raw === 0).map(a => a.id);
  if (emptySources.length) hints.push(`no-title-candidate:${emptySources.join(',')}`);
  if (playback.adapters.some(a => a.raw > 0 && a.manifestReachable === 0)) hints.push('one-or-more-source-manifests-did-not-verify');
  const hasPipelineFailure = playback.playbackChecks.some(c => {
    const check = c.check as { manifest?: { status?: string }; media?: { status?: string } };
    return !['ok', 'not-applicable'].includes(check.manifest?.status ?? '') || !['ok', 'not-applicable'].includes(check.media?.status ?? '');
  });
  if (hasPipelineFailure) hints.push('one-or-more-sampled-manifest-or-media-stages-failed');
  if (playback.playbackChecks.length && !hasPipelineFailure) hints.push('backend-fetched-sample-media; browser-and-relay-playback-still-unconfirmed');
  if (!hasConfiguredSecret()) hints.push('ephemeral-playback-secret-generated-at-boot');

  return {
    ok: true,
    build: readBuildInfo(),
    generatedAt: new Date().toISOString(),
    totalMs: Date.now() - started,
    probe,
    config: {
      secretConfigured: hasConfiguredSecret(),
      relayMode: cfg.relayMode,
      resolveTimeoutMs: cfg.resolveTimeoutMs,
      requireToken: cfg.requireToken,
      sourcesEnabled: registry.listPublicSources().map(s => s.id),
    },
    identity: meta,
    playback: {
      resolution: {
        adapters: playback.adapters,
        lanes: playback.lanes,
        selected: playback.selected,
      },
      candidateChecks: playback.playbackChecks,
      policy: playback.policy,
    },
    diagnosis: {
      hints,
      scope: 'The server makes bounded upstream requests and reads at most 1 KiB from each sampled media segment. The browser session, actual /api/v1/stream relay response, device decoder, and audible language are not exercised by this endpoint.',
    },
  };
}

export function collectDiagnostics(
  cfg: BackendConfig,
  registry: SourceRegistry,
  probe: DiagnosticsProbe,
  forceFresh = false,
): Promise<unknown> {
  const key = `${probe.type}:${probe.tmdbId}:${probe.season}:${probe.episode}:${probe.lang ?? ''}`;
  if (!forceFresh && cached && cached.key === key && Date.now() <= cached.expiresAt) {
    return Promise.resolve({ ...(cached.value as object), cache: { hit: true, ageMs: Date.now() - cached.createdAt } });
  }
  if (inFlight && inFlight.key === key) return inFlight.promise;
  if (inFlight) return Promise.reject(new Error('diagnostics busy'));
  const promise = collect(cfg, registry, probe)
    .then(value => {
      cached = { key, createdAt: Date.now(), expiresAt: Date.now() + DIAG_CACHE_TTL_MS, value };
      return { ...(value as object), cache: { hit: false, ageMs: 0 } };
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return promise;
}
