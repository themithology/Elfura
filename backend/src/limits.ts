/**
 * Elfura Backend — concurrency guards for the expensive endpoint
 * ==============================================================
 * `/api/v1/playback` fans out to every source adapter and is the only request
 * that costs the whole process real work. Without a bound, a burst (or a client
 * that retries in a loop) queues hundreds of resolutions: each one starts its
 * own metadata fetch and adapter race, the event loop stalls for hundreds of ms
 * parsing the replies, and every other endpoint — artwork included — answers
 * late or gets rate limited. That is what "all the sources died" looks like from
 * the browser.
 *
 * Two bounds, deliberately small:
 *  - a process-wide gate, so the machine never runs more resolutions than it can
 *    finish (queued callers are served in order, or told to retry);
 *  - a per-client in-flight cap, so one browser or one retry loop cannot occupy
 *    the whole gate. A normal player keeps one or two requests open.
 */

/** Slot accounting for one bounded resource. */
export class ResolveGate {
  private active = 0;
  private queue: { grant: (ok: boolean) => void; timer: NodeJS.Timeout }[] = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxQueue: number,
    private readonly waitMs: number,
  ) {}

  stats(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  /** Run `task` with a slot held, or report why it could not start. */
  async run<T>(task: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: 'queue-full' | 'queue-timeout' }> {
    if (this.active >= this.maxActive) {
      if (this.queue.length >= this.maxQueue) return { ok: false, reason: 'queue-full' };
      const granted = await new Promise<boolean>((resolve) => {
        const entry = {
          grant: (ok: boolean) => {
            clearTimeout(entry.timer);
            resolve(ok);
          },
          timer: setTimeout(() => {
            this.queue = this.queue.filter((item) => item !== entry);
            resolve(false);
          }, this.waitMs),
        };
        this.queue.push(entry);
      });
      if (!granted) return { ok: false, reason: 'queue-timeout' };
    } else {
      this.active += 1;
    }
    try {
      return { ok: true, value: await task() };
    } finally {
      // Hand the slot straight to the next waiter instead of dropping and
      // re-incrementing, so the count cannot drift.
      const next = this.queue.shift();
      if (next) next.grant(true);
      else this.active = Math.max(0, this.active - 1);
    }
  }
}

/** In-flight requests per client key. */
export class PerKeyConcurrency {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit: number) {}

  enter(key: string): boolean {
    const active = this.counts.get(key) ?? 0;
    if (active >= this.limit) return false;
    this.counts.set(key, active + 1);
    return true;
  }

  leave(key: string): void {
    const next = (this.counts.get(key) ?? 1) - 1;
    if (next <= 0) this.counts.delete(key);
    else this.counts.set(key, next);
  }

  stats(): { clients: number } {
    return { clients: this.counts.size };
  }
}

const providers = new Set<() => Record<string, number>>();

/** Let the perf endpoint report every registered bound. */
export function registerQueueStats(provider: () => Record<string, number>): void {
  providers.add(provider);
}

export function queueStats(): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const provider of providers) {
    try {
      Object.assign(merged, provider());
    } catch {
      /* a broken provider must not break telemetry */
    }
  }
  return merged;
}
