import type { PlaybackRequest, PlaybackResolution } from './playback-resolver.js';

/**
 * Coalesce identical concurrent resolver requests, including late-wave reads.
 * This retains no completed playback payloads: each caller still gets its own
 * HTTP response, and requests with different language, source, episode, path or
 * retry semantics never share an answer. Existing adapter/probe caches and
 * their security boundaries remain unchanged.
 */
export class ResolverCoalescer {
  private readonly active = new Map<string, Promise<PlaybackResolution | null>>();
  private generation = 0;
  private started = 0;
  private shared = 0;
  private uncached = 0;
  constructor(private readonly resolve: (request: PlaybackRequest) => Promise<PlaybackResolution | null>, private readonly maxKeys = 512) {}

  invalidate(): void { this.generation++; }

  run(request: PlaybackRequest): Promise<PlaybackResolution | null> {
    // Explicit fields rather than arbitrary JSON avoid key-order differences and
    // ensure every field that affects the resolved payload is part of the key.
    const key = JSON.stringify([this.generation, request.type, request.tmdbId,
      request.season ?? null, request.episode ?? null, request.anilistId ?? null,
      request.anilistEpisode ?? null, request.sourceId ?? null, request.preferredLang ?? null,
      request.late === true, request.retryMissing === true]);
    const existing = this.active.get(key);
    if (existing) { this.shared++; return existing; }
    this.started++;
    // Keep memory bounded even for an unexpected burst of distinct titles. Do
    // not silently reject unique viewers just because the dedup table is full.
    if (this.active.size >= this.maxKeys) { this.uncached++; return Promise.resolve().then(() => this.resolve(request)); }
    const task = Promise.resolve().then(() => this.resolve(request));
    this.active.set(key, task);
    // Attach both handlers rather than creating an unobserved rejected finally promise.
    void task.then(() => { if (this.active.get(key) === task) this.active.delete(key); }, () => { if (this.active.get(key) === task) this.active.delete(key); });
    return task;
  }

  snapshot(): { activeKeys: number; started: number; shared: number; uncached: number } {
    return { activeKeys: this.active.size, started: this.started, shared: this.shared, uncached: this.uncached };
  }
}
