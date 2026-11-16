/**
 * Elfura Backend — "why did it stop?" telemetry
 * =============================================
 * When sources stop and artwork stops at the same moment, the browser is fine
 * and the process is not: both are endpoints on this one Node process. Rather
 * than guess between CPU starvation (a small Pterodactyl container throttling
 * its cgroup), a blocked event loop, a GC storm, or a rate limiter shutting the
 * user out, this module measures all four continuously and reports them from
 * `/api/v1/perf`, with stall warnings printed to the server console.
 *
 * Nothing here touches the network, disk on the request path, or any upstream
 * identity. Counters are process-local and bounded.
 */

import fs from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

/** A loop delay above this is reported in the console as a stall. */
const STALL_WARN_MS = Math.max(50, Number(process.env.ELFURA_STALL_WARN_MS || 250));
/** How often the histogram is harvested. */
const SAMPLE_INTERVAL_MS = 2_000;
const MAX_STALLS = 25;

interface Stall {
  at: string;
  ms: number;
  busy: string;
}

interface CgroupStats {
  /** Effective CPU quota in cores, when the container publishes one. */
  quotaCores: number | null;
  /** Percentage of scheduling periods in which the cgroup was throttled. */
  throttledPercent: number | null;
  /** Total time spent throttled, seconds. */
  throttledSeconds: number | null;
}

const histogram = monitorEventLoopDelay({ resolution: 20 });
const phases = new Map<string, number>();
const stalls: Stall[] = [];
const rateLimits = new Map<string, { denied: number; lastAt: number }>();
/** The phase most recently entered, with when. A stall is detected one sample
 * later, long after the work that blocked the loop has finished, so the answer
 * to "what was running?" is usually this rather than the live counter. */
let lastPhase: { name: string; at: number } = { name: 'idle', at: 0 };
const gc = { count: 0, pauseMs: 0, maxPauseMs: 0 };

let started = false;
let sampler: NodeJS.Timeout | null = null;
let lastSampleAt = Date.now();
let lastCpu = process.cpuUsage();
let windowMaxMs = 0;
let windowP99Ms = 0;
let windowP50Ms = 0;
let worstMs = 0;
let worstAt = '';
let cpuPercent = 0;
let cgroup: CgroupStats = { quotaCores: null, throttledPercent: null, throttledSeconds: null };
let totals = { requests: 0, rateLimited: 0, stalls: 0 };
let startedAt = Date.now();

/** Mark a unit of work as in flight; the returned function clears it. */
export function phaseStart(name: string): () => void {
  phases.set(name, (phases.get(name) ?? 0) + 1);
  lastPhase = { name, at: Date.now() };
  return () => {
    const next = (phases.get(name) ?? 0) - 1;
    if (next > 0) phases.set(name, next);
    else phases.delete(name);
  };
}

export function noteRequest(): void {
  totals.requests += 1;
}

/** Called wherever the process answers 429, so a lockout is visible. */
export function noteRateLimit(bucket: string): void {
  totals.rateLimited += 1;
  const entry = rateLimits.get(bucket) ?? { denied: 0, lastAt: 0 };
  const now = Date.now();
  entry.denied += 1;
  // One console line per bucket per 10 s: a retry storm must not flood the log.
  if (now - entry.lastAt > 10_000) {
    entry.lastAt = now;
    console.warn(`[elfura-perf] rate limit hit on "${bucket}" (${entry.denied} denial(s) so far)`);
  }
  entry.lastAt = entry.lastAt || now;
  rateLimits.set(bucket, entry);
}

function busiestPhase(windowMs: number): string {
  let best = 'idle';
  let count = 0;
  for (const [name, active] of phases) {
    if (active > count) {
      best = name;
      count = active;
    }
  }
  if (count > 0) return count > 1 ? `${best}×${count}` : best;
  // Nothing is running now: attribute the stall to the work that was running
  // when it happened, if that was recent enough to be the cause.
  if (lastPhase.name !== 'idle' && Date.now() - lastPhase.at <= windowMs + 1000) return `${lastPhase.name} (just finished)`;
  return 'idle';
}

function readCgroup(): CgroupStats {
  const read = (path: string): string => {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return '';
    }
  };
  const cpuMax = read('/sys/fs/cgroup/cpu.max').trim(); // cgroup v2: "<quota> <period>" or "max <period>"
  let quotaCores: number | null = null;
  if (cpuMax) {
    const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
    const quota = Number(quotaRaw);
    const period = Number(periodRaw);
    if (Number.isFinite(quota) && Number.isFinite(period) && period > 0 && quota > 0) {
      quotaCores = Math.round((quota / period) * 100) / 100;
    }
  }
  const stat =
    read('/sys/fs/cgroup/cpu.stat') ||
    read('/sys/fs/cgroup/cpu/cpu.stat') ||
    read('/sys/fs/cgroup/cpu,cpuacct/cpu.stat');
  let throttledPercent: number | null = null;
  let throttledSeconds: number | null = null;
  if (stat) {
    const pick = (name: string): number => {
      const match = new RegExp(`^${name}\\s+(\\d+)$`, 'm').exec(stat);
      return match ? Number(match[1]) : 0;
    };
    const periods = pick('nr_periods');
    const throttled = pick('nr_throttled');
    const usec = pick('throttled_usec') || pick('throttled_time') / 1_000;
    if (periods > 0) throttledPercent = Math.round((throttled / periods) * 1000) / 10;
    if (usec > 0) throttledSeconds = Math.round(usec / 1e6);
  }
  return { quotaCores, throttledPercent, throttledSeconds };
}

/** Harvest the histogram. Exported so tests can force a sample immediately. */
export function sampleNow(): void {
  const now = Date.now();
  const elapsedMs = Math.max(1, now - lastSampleAt);
  lastSampleAt = now;

  // Numbers are nanoseconds; a disabled or brand-new histogram reports 0.
  const maxMs = histogram.max / 1e6;
  const p99Ms = histogram.percentile(99) / 1e6;
  const p50Ms = histogram.percentile(50) / 1e6;
  if (Number.isFinite(maxMs) && maxMs > 0) {
    windowMaxMs = maxMs;
    windowP99Ms = Number.isFinite(p99Ms) ? p99Ms : 0;
    windowP50Ms = Number.isFinite(p50Ms) ? p50Ms : 0;
    if (maxMs > worstMs) {
      worstMs = maxMs;
      worstAt = new Date(now).toISOString();
    }
    if (maxMs >= STALL_WARN_MS) {
      totals.stalls += 1;
      const entry: Stall = { at: new Date(now).toISOString(), ms: Math.round(maxMs), busy: busiestPhase(maxMs) };
      stalls.push(entry);
      if (stalls.length > MAX_STALLS) stalls.shift();
      console.warn(
        `[elfura-perf] event loop stalled ${entry.ms}ms while busy with ${entry.busy}` +
          ` (heap ${Math.round(process.memoryUsage().heapUsed / 1048576)}MB)`,
      );
    }
  }
  histogram.reset();

  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  cpuPercent = Math.round((((cpu.user + cpu.system) / 1000) / elapsedMs) * 1000) / 10;
  cgroup = readCgroup();
}

/** Start the sampler. Idempotent, and the timer never keeps the process alive. */
export function startPerfMonitor(): void {
  if (started) return;
  started = true;
  startedAt = Date.now();
  histogram.enable();
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gc.count += 1;
        gc.pauseMs += entry.duration;
        if (entry.duration > gc.maxPauseMs) gc.maxPauseMs = entry.duration;
      }
    });
    observer.observe({ entryTypes: ['gc'] });
    // Do not let the observer hold the event loop open on shutdown.
    (observer as unknown as { unref?: () => void }).unref?.();
  } catch {
    /* GC observer is a nicety, not a requirement */
  }
  lastCpu = process.cpuUsage();
  cgroup = readCgroup();
  sampler = setInterval(sampleNow, SAMPLE_INTERVAL_MS);
  sampler.unref?.();
}

export function stopPerfMonitor(): void {
  if (sampler) clearInterval(sampler);
  sampler = null;
  started = false;
  histogram.disable();
}

export interface PerfSnapshot {
  uptimeSec: number;
  eventLoop: {
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
    worstMs: number;
    worstAt: string | null;
    stallWarnMs: number;
    stalls: Stall[];
  };
  cpu: {
    percent: number;
    cores: number;
    loadAvg1: number;
    cgroup: CgroupStats;
  };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number };
  gc: { count: number; pauseMs: number; maxPauseMs: number };
  traffic: { requests: number; rateLimited: number; rateLimitedByBucket: Record<string, number> };
  inFlight: Record<string, number>;
  /** Plain-language verdict, so a log dump answers "was it the CPU?". */
  verdict: string;
}

function verdict(): string {
  const throttled = cgroup.throttledPercent;
  if (throttled !== null && throttled >= 20) {
    return `cpu-throttled: the container used ${throttled}% of its scheduling periods while throttled — raise the CPU limit`;
  }
  if (worstMs >= 500) {
    return `event-loop-blocked: worst stall ${Math.round(worstMs)}ms — something synchronous is holding the loop`;
  }
  if (gc.maxPauseMs >= 120) {
    return `gc-pressure: longest GC pause ${Math.round(gc.maxPauseMs)}ms — memory is under pressure`;
  }
  if (totals.rateLimited > 0) {
    return `rate-limited: ${totals.rateLimited} request(s) answered 429 — a client hit the per-IP window`;
  }
  if (throttled !== null && throttled > 5) return `cpu-contended: throttled ${throttled}% of periods`;
  return 'healthy';
}

export function perfSnapshot(): PerfSnapshot {
  const mem = process.memoryUsage();
  const byBucket: Record<string, number> = {};
  for (const [bucket, entry] of rateLimits) byBucket[bucket] = entry.denied;
  const inFlight: Record<string, number> = {};
  for (const [name, active] of phases) inFlight[name] = active;
  return {
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    eventLoop: {
      p50Ms: Math.round(windowP50Ms * 10) / 10,
      p99Ms: Math.round(windowP99Ms * 10) / 10,
      maxMs: Math.round(windowMaxMs * 10) / 10,
      worstMs: Math.round(worstMs * 10) / 10,
      worstAt: worstAt || null,
      stallWarnMs: STALL_WARN_MS,
      stalls: stalls.slice(),
    },
    cpu: {
      percent: cpuPercent,
      cores: os.cpus().length,
      loadAvg1: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
      cgroup,
    },
    memory: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      externalMb: Math.round(mem.external / 1048576),
    },
    gc: { count: gc.count, pauseMs: Math.round(gc.pauseMs), maxPauseMs: Math.round(gc.maxPauseMs) },
    traffic: { requests: totals.requests, rateLimited: totals.rateLimited, rateLimitedByBucket: byBucket },
    inFlight,
    verdict: verdict(),
  };
}

/** Compact block for `/api/v1/health`: three numbers and a verdict. */
export function healthSummary(): { eventLoopMs: number; cpuPercent: number; throttledPercent: number | null; verdict: string } {
  return {
    eventLoopMs: Math.round(windowMaxMs * 10) / 10,
    cpuPercent,
    throttledPercent: cgroup.throttledPercent,
    verdict: verdict(),
  };
}
