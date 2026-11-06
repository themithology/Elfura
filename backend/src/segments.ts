/** Optional, independent skip-marker lookup. Playback never waits for this service. */
export interface SegmentQuery { tmdbId: string; season: number; episode: number; duration: number }
export interface SkipMarkers { intro?: [number, number]; outro?: [number, number] }
const cache = new Map<string, { expires: number; value: SkipMarkers }>();
const pending = new Map<string, Promise<SkipMarkers>>();

export function parseIntroDbMarkers(data: unknown, duration: number): SkipMarkers {
  if (!data || typeof data !== 'object' || !Number.isFinite(duration) || duration <= 0) return {};
  const record = data as Record<string, unknown>;
  const read = (raw: unknown, allowEnd: boolean): [number, number] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const { start_ms, end_ms } = item as Record<string, unknown>;
      const start = start_ms === null ? 0 : typeof start_ms === 'number' ? start_ms / 1000 : NaN;
      const end = end_ms === null && allowEnd ? duration : typeof end_ms === 'number' ? end_ms / 1000 : NaN;
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= duration + 1) {
        return [start, Math.min(end, duration)];
      }
    }
    return undefined;
  };
  const intro = read(record.intro, false);
  const outro = read(record.credits, true);
  return { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}) };
}

export async function fetchSkipMarkers(q: SegmentQuery): Promise<SkipMarkers> {
  const key = `${q.tmdbId}:${q.season}:${q.episode}:${Math.round(q.duration)}`;
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.value;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const task = (async (): Promise<SkipMarkers> => {
    try {
      const url = new URL('https://api.theintrodb.org/v4/media');
      url.searchParams.set('tmdb_id', q.tmdbId);
      url.searchParams.set('season', String(q.season));
      url.searchParams.set('episode', String(q.episode));
      url.searchParams.set('duration_ms', String(Math.round(q.duration * 1000)));
      const response = await fetch(url, { signal: AbortSignal.timeout(3500), headers: { Accept: 'application/json' } });
      if (!response.ok) return {};
      const data = await response.json() as Record<string, unknown>;
      if (data?.type !== 'tv' || Number(data.season) !== q.season || Number(data.episode) !== q.episode) return {};
      const result = parseIntroDbMarkers(data, q.duration);
      if (cache.size >= 500) cache.delete(cache.keys().next().value!);
      cache.set(key, { value: result, expires: Date.now() + (result.intro || result.outro ? 3600_000 : 300_000) });
      return result;
    } catch { return {}; }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
