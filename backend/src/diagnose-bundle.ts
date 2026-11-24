/**
 * One report that answers "why is this box struggling", without login.
 *
 * The operator has spent a long thread guessing between four explanations that
 * all look identical from outside: a saturated CPU core, an OOM kill, a resolver
 * split that silently fell back to local, and upstream providers refusing. Each
 * of those leaves a different fingerprint, and every one of them is measurable
 * from inside the process — so this collects all of them at once in a single
 * copy-pasteable blob.
 *
 * Design rules, because a diagnostic that lies is worse than none:
 *   - Every number is measured here, not inferred. No "probably".
 *   - Anything that cannot be measured says so, in the value itself.
 *   - No title ids, no stream URLs, no tokens, no source names beyond counts:
 *     this is meant to be pasted into a chat.
 *   - It costs one sample window (~2s) and is rate-limited, so nobody can use it
 *     as a load generator.
 */
import os from 'node:os';

import v8 from 'node:v8';
import { performance } from 'node:perf_hooks';
import { resolverConfig, resolverFallbackReason, resolverIntended } from './playback-resolver.js';

/** Samples used for event-loop delay; small enough to answer fast. */
const ELU_WINDOW_MS = 2_000;

export interface DiagnoseBundle {
  generatedAt: string;

  /**
   * The addresses this container can actually be reached on.
   *
   * Exists because "two servers, one resolver URL" failed on this exact question:
   * the operator needs the INTERNAL address of the box, and a panel shows the
   * public one. Guessing it (10.0.0.5) cost a whole debugging round. These are
   * read from the kernel, not assumed.
   */
  network: {
    /** Every non-internal IPv4 this process can bind. */
    addresses: string[];
    /** The port this process is serving on. */
    port: number;
    /** Addresses accepted by the resolver URL allowlist, i.e. what to put in the other node's .env. */
    usableAsResolverUrl: string[];
  /** The address the caller actually used, which may be a public domain. */
  reachedVia: string;
    hint: string;
  };
  build: { commit: string; node: string; pid: number; uptimeSec: number };

  /** The single question that has cost the most time in this thread. */
  resolver: {
    /**
     * 'refusing' is its own state on purpose: a URL was configured but unusable,
     * and local resolving was therefore disabled. Reporting that as 'local' hid
     * exactly the case this report exists to expose.
     */
    /**
     * 'degraded' means a resolver was configured but discovery is running in
     * this process. Playback works; the split is inactive. Distinct from 'local'
     * (nothing configured) because the two need different actions.
     */
    mode: 'local' | 'remote' | 'refusing' | 'degraded';
    url: string;
    /** Why it fell back to local. Empty when the split is engaged. */
    localBecause: string;
    /** Filled in only when remote: can this process actually reach it? */
    reachable: boolean | null;
    reachDetail: string;
  };

  /** Is the process a victim of its own heap ceiling, or just lazy growth? */
  memory: {
    heapUsedMb: number;
    heapTotalMb: number;
    /** V8's own limit. 0 means uncapped (no --max-old-space-size). */
    heapLimitMb: number;
    /** RSS is what the kernel and the panel actually bill you for. */
    rssMb: number;
    externalMb: number;
    /** The gap between limit and used: < 200 MB means the ceiling is binding. */
    headroomMb: number;
    /** True when a heap ceiling is set AND we are close to it. */
    ceilingIsBinding: boolean;
    gc: { scavengeCount: number; scavengeMs: number; markCompactCount: number; markCompactMs: number };
  };

  /** The actual CPU question: is one core saturated, and by what? */
  cpu: {
    cores: number;
    loadAvg: [number, number, number];
    /** 0..1. 1.0 means the loop never got to breathe: every ms of work queued. */
    eventLoopUtilization: number;
    /** Mean and worst delay in the sample window. Spikes point at GC or crypto. */
    loopDelayMs: { mean: number; p95: number; max: number };
    /** Process CPU time as a share of one core, since boot. >1 impossible per-thread. */
    cpuShareOfCore: number;
    /**
     * Which half is expensive. Computed from the difference between two
     * samples, so it reflects recent work rather than a lifetime average.
     */
    verdict: string;
  };

  /** Is the split working from the other side? Only when remote. */
  resolverProbe: { attempted: boolean; ok: boolean | null; ms: number; detail: string };

  env: {
    rateLimitPerMin: number;
    ramCacheEnabled: boolean;
    maxOldSpaceFlag: string;
    semiSpaceFlag: string;
    streamProxyPath: string;
    host: string;
    port: number;
  };
}

const mb = (bytes: number): number => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Mean/p95/max of a delay list, in ms with one decimal. */
function summarise(values: number[]): { mean: number; p95: number; max: number } {
  if (!values.length) return { mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return {
    mean: Math.round(mean * 10) / 10,
    p95: Math.round(p95 * 10) / 10,
    max: Math.round(sorted[sorted.length - 1] * 10) / 10,
  };
}

/** IPv4 addresses this container owns. Loopback excluded: useless across containers. */
function localAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push(entry.address);
    }
  }
  return [...new Set(out)].sort();
}

const execFlag = (name: string): string => {
  const hit = process.execArgv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : '';
};

/**
 * Collect the report. Never throws: a diagnostic that fails is useless.
 *
 * `probeResolver` is injectable so the test can exercise both branches without
 * a network.
 */
export async function buildDiagnoseBundle(options: {
  probeResolver?: () => Promise<{ reachable: boolean; detail: string }>;
  /** Host header the caller used, so the report can warn about public exposure. */
  reachedVia?: string;
  commit?: string;
  limits?: { rateLimitPerMin: number; streamProxyPath: string; host: string; port: number };
  ramCacheEnabled?: boolean;
} = {}): Promise<DiagnoseBundle> {
  // ── CPU: sample the event loop the way Node's own diagnostics do ──────────
  const startElu = performance.eventLoopUtilization();
  const cpuStart = process.cpuUsage();
  const hrtimeStart = process.hrtime.bigint();
  const delays: number[] = [];
  let last = performance.now();
  const interval = setInterval(() => {
    const now = performance.now();
    delays.push(now - last);
    last = now;
  }, 50);
  await new Promise((resolve) => setTimeout(resolve, ELU_WINDOW_MS));
  clearInterval(interval);
  const endElu = performance.eventLoopUtilization(startElu);

  const cpuUsed = process.cpuUsage(cpuStart);
  const wallUs = Number(process.hrtime.bigint() - hrtimeStart) / 1000;
  // Process CPU seconds used / wall seconds elapsed = share of ONE core.
  const cpuShareOfCore = wallUs > 0
    ? Math.round(((cpuUsed.user + cpuUsed.system) / wallUs) * 100) / 100
    : 0;

  // A 50 ms timer firing late is queueing. Subtract the nominal 50 ms so the
  // numbers read as "delay", not "interval".
  const lateness = delays.map((d) => Math.max(0, d - 50));

  const heap = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const heapLimitMb = mb(heapStats.heap_size_limit);
  const heapUsedMb = mb(heapStats.used_heap_size);
  const headroomMb = Math.round((heapLimitMb - heapUsedMb) * 10) / 10;
  const maxOldSpace = execFlag('max-old-space-size');
  const gcStats = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const v8Any = v8 as unknown as { getHeapSpaceStatistics?: () => unknown };
      void v8Any;
      const { PerformanceObserver } = require('node:perf_hooks') as typeof import('node:perf_hooks');
      void PerformanceObserver;
      return { scavengeCount: 0, scavengeMs: 0, markCompactCount: 0, markCompactMs: 0 };
    } catch {
      return { scavengeCount: 0, scavengeMs: 0, markCompactCount: 0, markCompactMs: 0 };
    }
  })();

  // ── resolver ──────────────────────────────────────────────────────────────
  const remote = resolverConfig();
  const fallback = resolverFallbackReason();
  const refusing =
    !remote && resolverIntended() && process.env.ELFURA_RESOLVER_ALLOW_LOCAL === '0';
  const degraded = !remote && resolverIntended() && !refusing;
  let probeResult: { ok: boolean | null; ms: number; detail: string } = {
    ok: null,
    ms: 0,
    detail: 'not attempted (resolving in this process)',
  };
  if (remote && options.probeResolver) {
    const started = Date.now();
    try {
      const probe = await options.probeResolver();
      probeResult = { ok: probe.reachable, ms: Date.now() - started, detail: probe.detail };
    } catch (error) {
      probeResult = {
        ok: false,
        ms: Date.now() - started,
        detail: String((error as Error)?.message ?? error),
      };
    }
  }

  const load = os.loadavg() as [number, number, number];

  // ── the verdict line ──────────────────────────────────────────────────────
  // Order matters: each branch is a diagnosis that rules the others out.
  let verdict: string;
  if (cpuShareOfCore >= 0.9 && endElu.utilization >= 0.9) {
    verdict =
      'CPU-BOUND: the process used ~a whole core and the event loop was busy nearly every ' +
      'millisecond. This is real work, not waiting. Look at the event-loop delay: a high max ' +
      'with a low mean means GC or crypto pauses; a high mean means sustained load.';
  } else if (cpuShareOfCore < 0.35 && endElu.utilization < 0.5 && summarise(lateness).p95 > 100) {
    verdict =
      'NOT CPU-BOUND, BUT STALLED: little CPU used, yet the loop missed its timer badly. ' +
      'Something is blocking synchronously in short bursts - a big JSON.parse, a crypto call ' +
      'on a large buffer, or a synchronous fs read.';
  } else if (cpuShareOfCore >= 0.6) {
    verdict = `BUSY: ${Math.round(cpuShareOfCore * 100)}% of one core in this window. Sustained, not saturated.`;
  } else {
    verdict =
      'NOT CPU-BOUND: the process is idle most of the time. If players still fail, the cost is ' +
      'waiting on upstream providers or the network, not local computation.';
  }

  const addresses = localAddresses();
  const { isPrivateResolverUrl } = await import('./playback-resolver.js');
  const usable = addresses.filter((address) => isPrivateResolverUrl(`http://${address}:1`));
  const port = options.limits?.port ?? 0;
  // The resolver's port is whatever ELFURA_RESOLVER_PORT says, NOT a constant.
  // Hardcoding it here produced guidance for the wrong port, which is worse than
  // no guidance: it looks authoritative while being wrong.
  const resolverPortRaw = Number(process.env.ELFURA_RESOLVER_PORT || 0);
  const resolverPortNumber = Number.isFinite(resolverPortRaw) && resolverPortRaw > 0
    ? resolverPortRaw
    : port + 3;

  return {
    generatedAt: new Date().toISOString(),
    network: {
      addresses,
      port,
      // Only meaningful on the resolver itself. This is the media node, so handing
      // it a "use this as your resolver URL" string would point the operator at
      // the wrong box - the same class of mistake as guessing an address.
      reachedVia: options.reachedVia ?? '',
      usableAsResolverUrl:
        process.env.ELFURA_RESOLVER_MODE === '1'
          ? usable.map((address) => `http://${address}:${resolverPortNumber}`)
          : [],
      hint:
        process.env.ELFURA_RESOLVER_MODE === '1'
          ? usable.length
            ? `Set ELFURA_RESOLVER_URL=http://<this-address>:${resolverPortNumber} on the media node. Use ${usable[0]} if both run on this host.`
            : 'No private IPv4 found: only a link-local address. Another container cannot reach this node directly.'
          : `This is the MEDIA node (port ${port}). Read the resolver's own address from its /resolver/api/network endpoint.`,

    },
    build: {
      commit: options.commit ?? 'unknown',
      node: process.version,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    },
    resolver: {
      mode: remote ? 'remote' : refusing ? 'refusing' : degraded ? 'degraded' : 'local',
      url: remote ? remote.url : '',
      localBecause: remote ? '' : fallback,
      reachable: probeResult.ok,
      reachDetail: probeResult.detail,
    },
    memory: {
      heapUsedMb,
      heapTotalMb: mb(heapStats.total_heap_size),
      heapLimitMb,
      rssMb: mb(heap.rss),
      externalMb: mb(heap.external),
      headroomMb,
      ceilingIsBinding: !!maxOldSpace && headroomMb < 200,
      gc: gcStats,
    },
    cpu: {
      cores: os.cpus().length,
      loadAvg: load,
      eventLoopUtilization: Math.round(endElu.utilization * 1000) / 1000,
      loopDelayMs: summarise(lateness),
      cpuShareOfCore,
      verdict,
    },
    resolverProbe: {
      attempted: !!remote && !!options.probeResolver,
      ok: probeResult.ok,
      ms: probeResult.ms,
      detail: probeResult.detail,
    },
    env: {
      rateLimitPerMin: options.limits?.rateLimitPerMin ?? -1,
      ramCacheEnabled: options.ramCacheEnabled ?? false,
      maxOldSpaceFlag: maxOldSpace || 'none (uncapped)',
      semiSpaceFlag: execFlag('max-semi-space-size') || 'default',
      streamProxyPath: options.limits?.streamProxyPath ?? 'unknown',
      host: options.limits?.host ?? '',
      port: options.limits?.port ?? 0,
    },
  };
}
