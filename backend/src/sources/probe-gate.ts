/** Shared, abort-aware cap on simultaneous upstream liveness probes per process. */
export class ProbeGate {
  private active = 0;
  private readonly waiters: { signal: AbortSignal; finish: (release: (() => void) | null) => void }[] = [];
  constructor(private readonly limit: number, private readonly maxWaiting = 1024) {}

  acquire(signal: AbortSignal): Promise<(() => void) | null> {
    if (signal.aborted) return Promise.resolve(null);
    if (this.active < this.limit) return Promise.resolve(this.grant());
    if (this.waiters.length >= this.maxWaiting) return Promise.resolve(null);
    return new Promise(resolve => {
      const waiter = { signal, finish: (_release: (() => void) | null) => {} };
      const abort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        waiter.finish(null);
      };
      let settled = false;
      waiter.finish = release => {
        if (settled) { release?.(); return; }
        settled = true;
        signal.removeEventListener('abort', abort);
        resolve(release);
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private grant(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      while (this.waiters.length && this.active < this.limit) {
        const waiter = this.waiters.shift()!;
        if (waiter.signal.aborted) { waiter.finish(null); continue; }
        waiter.finish(this.grant());
      }
    };
  }

  snapshot(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: this.waiters.length, limit: this.limit };
  }
}
