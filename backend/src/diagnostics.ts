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
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
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
  anilist?: string;
  anilistEpisode?: number;
  lang?: string;
}

/**
 * Bounded outbound-connectivity check. When every source reports "no rows",
 * the first question is whether this host can reach the internet at all, so the
 * report answers it directly. Labels stay generic: no provider hostnames are
 * ever exposed to the client.
 */
export async function probeOutbound(cfg: BackendConfig): Promise<Record<string, { ok: boolean; ms: number; status?: number; code?: string }>> {
  const targets: Record<string, string> = {
    // Title metadata (TMDB) — a 401 still proves DNS + TLS + egress work.
    metadata: `${cfg.tmdb.apiBase.replace(/\/$/, '')}/3/configuration`,
  };
  const out: Record<string, { ok: boolean; ms: number; status?: number; code?: string }> = {};
  await Promise.all(
    Object.entries(targets).map(async ([label, target]) => {
      const started = Date.now();
      try {
        const res = await fetch(target, {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(4000),
        });
        await res.body?.cancel().catch(() => {});
        out[label] = { ok: true, ms: Date.now() - started, status: res.status };
      } catch (err) {
        const cause = (err as { cause?: { code?: string } })?.cause;
        out[label] = {
          ok: false,
          ms: Date.now() - started,
          code: (err instanceof Error ? err.name : 'Error') + (cause?.code ? `/${cause.code}` : ''),
        };
      }
    }),
  );
  return out;
}

/**
 * Where does an outbound connection actually fail?
 *
 * "Every adapter returned zero candidates" has four very different causes: the
 * name does not resolve, the TCP connection never opens, the TLS handshake hangs,
 * or the site answers with a challenge. Reported as one flat timeout they are
 * indistinguishable, and guessing between them costs hours. This walks the stages
 * of a real connection to the hosts the adapters use, on the server itself, and
 * says which stage failed.
 */
export interface EgressStage {
  label: string;
  host: string;
  dns?: { ok: boolean; ms: number; address?: string; family?: number; error?: string };
  tcp?: { ok: boolean; ms: number; error?: string };
  tls?: { ok: boolean; ms: number; error?: string; cn?: string };
  http?: { ok: boolean; ms: number; status?: number; error?: string };
}

const EGRESS_TARGETS: { label: string; host: string; path: string }[] = [
  { label: 'control-tmdb', host: 'api.themoviedb.org', path: '/3/configuration' },
  { label: 'rivestream', host: 'www.rivestream.app', path: '/' },
  { label: 'rive-api', host: 'scrapper.rivestream.app', path: '/' },
  { label: 'vidbolt', host: 'vidbolt.xyz', path: '/' },
  { label: 'vidzee', host: 'player.vidzee.wtf', path: '/' },
  { label: 'vixsrc', host: 'vixsrc.to', path: '/' },
];

const STAGE_TIMEOUT_MS = 5000;

async function probeEgressStages(): Promise<{ targets: EgressStage[]; verdict: string[] }> {
  const run = async (target: { label: string; host: string; path: string }): Promise<EgressStage> => {
    const stage: EgressStage = { label: target.label, host: target.host };

    const t0 = Date.now();
    let address = '';
    let family = 4;
    try {
      const resolved = await lookup(target.host, { all: false });
      address = resolved.address;
      family = resolved.family;
      stage.dns = { ok: true, ms: Date.now() - t0, address, family };
    } catch (err) {
      stage.dns = { ok: false, ms: Date.now() - t0, error: (err as { code?: string })?.code || 'lookup-failed' };
      return stage;
    }

    const tcpStart = Date.now();
    const tcpOk = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: address, port: 443 });
      let done = false;
      const finish = (ok: boolean, error?: string) => {
        if (done) return;
        done = true;
        stage.tcp = { ok, ms: Date.now() - tcpStart, ...(error ? { error } : {}) };
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(STAGE_TIMEOUT_MS, () => finish(false, 'timeout'));
      socket.once('connect', () => finish(true));
      socket.once('error', (err) => finish(false, (err as { code?: string })?.code || 'connect-error'));
    });
    if (!tcpOk) return stage;

    const tlsStart = Date.now();
    const tlsOk = await new Promise<boolean>((resolve) => {
      const socket = tls.connect({ host: address, port: 443, servername: target.host, rejectUnauthorized: false });
      let done = false;
      const finish = (ok: boolean, error?: string) => {
        if (done) return;
        done = true;
        stage.tls = {
          ok,
          ms: Date.now() - tlsStart,
          ...(error ? { error } : {}),
          ...(socket.getPeerCertificate?.()?.subject?.CN ? { cn: String(socket.getPeerCertificate().subject.CN) } : {}),
        };
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(STAGE_TIMEOUT_MS, () => finish(false, 'timeout'));
      socket.once('secureConnect', () => finish(true));
      socket.once('error', (err) => finish(false, (err as { code?: string })?.code || 'tls-error'));
    });
    if (!tlsOk) return stage;

    const httpStart = Date.now();
    try {
      const res = await fetch(`https://${target.host}${target.path}`, {
        redirect: 'manual',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      stage.http = { ok: res.status < 500, ms: Date.now() - httpStart, status: res.status };
    } catch (err) {
      const cause = (err as { cause?: { code?: string } })?.cause;
      stage.http = {
        ok: false,
        ms: Date.now() - httpStart,
        error: (err instanceof Error ? err.name : 'Error') + (cause?.code ? `/${cause.code}` : ''),
      };
    }
    return stage;
  };

  const targets = await Promise.all(EGRESS_TARGETS.map((target) => run(target)));

  const verdict: string[] = [];
  const control = targets.find((t) => t.label === 'control-tmdb');
  const providers = targets.filter((t) => t.label !== 'control-tmdb');
  const allDnsOk = targets.every((t) => t.dns?.ok);
  const anyDnsFail = targets.some((t) => !t.dns?.ok);
  if (anyDnsFail) verdict.push('dns-failure-on-server: names do not resolve, so no adapter can reach anything');
  if (control && !control.tcp?.ok) verdict.push('egress-blocked: even the control host cannot open a TCP connection');
  else if (control?.tcp?.ok && providers.some((t) => !t.tcp?.ok)) {
    verdict.push('selective-egress-block: the control host connects but provider hosts do not (firewall, proxy or IP reputation)');
  }
  if (providers.some((t) => t.tcp?.ok && !t.tls?.ok)) verdict.push('tls-handshake-fails-to-provider-hosts');
  if (providers.some((t) => t.tls?.ok && (t.http?.status ?? 0) >= 400)) {
    verdict.push('providers-answer-with-refusal: TLS works, the site refuses this server (challenge, 403 or 429)');
  }
  if (allDnsOk && providers.every((t) => t.tls?.ok && (t.http?.status ?? 0) < 400)) {
    verdict.push('egress-healthy: the server can reach the provider hosts, so re-check the adapters themselves');
  }
  return { targets, verdict };
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
      anilistId: probe.anilist,
      anilistEpisode: probe.anilistEpisode,
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
    network: await probeOutbound(cfg),
    egress: await probeEgressStages(),
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
  const key = `${probe.type}:${probe.tmdbId}:${probe.anilist ?? ''}:${probe.anilistEpisode ?? ''}:${probe.season}:${probe.episode}:${probe.lang ?? ''}`;
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
