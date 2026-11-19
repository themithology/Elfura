/**
 * One switch for every payload cache in the backend.
 *
 * The deployment target is a small container, and RAM is the scarce resource —
 * not bandwidth and not CPU. The operator asked for exactly that trade: do the
 * work again rather than hold results in memory. So payload caches (catalog
 * results, manifests, segment markers, metadata, subtitles) are off by default,
 * and the code that reads them falls through to a live fetch.
 *
 * This is deliberately a *policy*, not a set of scattered flags: every cache
 * asks this module, so there is one place to audit and one place to change.
 *
 * What is NOT cached here, and must never be, is anything whose absence would
 * cost correctness rather than CPU:
 *   - in-flight de-duplication (a Map of promises, not of payloads) is capped
 *     separately per module and only coalesces concurrent identical requests;
 *   - small bookkeeping (rate-limit counters, ban lists, seek markers) stays
 *     bounded by count, not by payload size.
 *
 * Set ELFURA_RAM_CACHE=off to disable caching. Default ON.
 *
 * Retuned for a 4 GB container. This module used to default OFF, which meant
 * every page load re-fetched catalogues, manifests, metadata and subtitles that
 * had just been fetched for the previous viewer. On a small box that trade was
 * right; on 4 GB it is the reason a traffic spike turns into a CPU and upstream
 * pile-up that starves the requests already in flight. The caches are all
 * bounded by entry count (see MAX_*_ENTRIES), so "on" cannot grow without limit.
 */

const OFF_VALUES = new Set(['0', 'off', 'false', 'no', 'none']);

/**
 * Whether payload caches may retain data in RAM.
 *
 * Read once at module load: the value must not change under a running server,
 * because a cache that stops being read would simply become dead memory.
 */
export const RAM_CACHE_ENABLED: boolean = (() => {
  const raw = (process.env.ELFURA_RAM_CACHE ?? '').trim().toLowerCase();
  if (!raw) return true;
  return !OFF_VALUES.has(raw);
})();

/**
 * A cache slot that respects the policy.
 *
 * Rather than making every call site branch, this exposes the same shape a Map
 * has so existing cache code keeps working: when caching is off, `get` always
 * misses and `set` discards. Callers then naturally take the uncached path.
 *
 * Using a class instead of a Map keeps the intent readable at each site and
 * makes it impossible to accidentally grow the backing store when disabled.
 */
export class PolicyCache<V> {
  private readonly store = new Map<string, V>();

  constructor(
    /** Bounded so that even with caching on, one burst cannot pin the heap. */
    private readonly maxEntries: number,
    private readonly enabled: boolean = RAM_CACHE_ENABLED,
  ) {}

  get size(): number {
    return this.store.size;
  }

  get(key: string): V | undefined {
    if (!this.enabled) return undefined;
    return this.store.get(key);
  }

  has(key: string): boolean {
    if (!this.enabled) return false;
    return this.store.has(key);
  }

  set(key: string, value: V): void {
    if (!this.enabled) return;
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.delete(key);
    this.store.set(key, value);
  }

  delete(key: string): boolean {
    // Guarded like the rest: with caching off the store must stay empty, and a
    // synchronous "check then delete" caller must not be able to observe a
    // half-enabled cache. (setCachedLiveness is exactly that shape.)
    if (!this.enabled) return false;
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  keys(): IterableIterator<string> {
    return this.store.keys();
  }

  /** For diagnostics: what this cache is costing, and whether it is even on. */
  describe(): { enabled: boolean; entries: number; maxEntries: number } {
    return { enabled: this.enabled, entries: this.store.size, maxEntries: this.maxEntries };
  }
}

/** Logged once at boot so the operator can see which mode the server chose. */
export function describeMemoryPolicy(): string {
  return RAM_CACHE_ENABLED
    ? '[elfura-memory] payload caches are ON (default); RAM use is bounded by the per-cache entry caps'
    : '[elfura-memory] payload caches are OFF; every request is recomputed to keep RAM flat';
}
