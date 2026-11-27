/**
 * TMDB → AniList, resolved on the server so the embed URL stays clean.
 *
 * The Hindi-dub lane (Mikaza) is AniList-keyed. Rather than make viewers append
 * `&anilist=` to every embed, the server converts by itself: the viewer keeps
 * `/embed/tv/46260`.
 *
 * Source: api.ani.zip/mappings. Measured 2026-11-16:
 *   ?themoviedb_id=46260 -> mappings.anilist_id = 20     (Naruto)
 *   ?themoviedb_id=85937 -> mappings.anilist_id = 101922 (Demon Slayer)
 *   ?themoviedb_id=1399  -> 404                          (Game of Thrones, not anime)
 *
 * Convert and forget: one request per resolve, no cache, no table, no expiry.
 * A 404 means "not anime" and returns null, which is the right answer for every
 * live-action title. It never throws into a resolve path and never invents an id.
 */

export interface AnimeMapping {
  anilistId: string;
  type?: string;
}

const BASE = 'https://api.ani.zip/mappings';
const TIMEOUT_MS = 4_000;

const asId = (value: unknown): string => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : '';
};

/** Exported so the test drives the real parser with a fixture. */
export function parseAniZipMappings(body: unknown): AnimeMapping | null {
  const mappings = body && typeof body === 'object' ? (body as { mappings?: unknown }).mappings : null;
  if (!mappings || typeof mappings !== 'object') return null;
  const row = mappings as Record<string, unknown>;
  const anilistId = asId(row.anilist_id);
  if (!anilistId) return null;
  return { anilistId, ...(typeof row.type === 'string' ? { type: row.type } : {}) };
}

/**
 * TMDB → AniList. `season` is not sent: ani.zip maps a TMDB series to one
 * AniList entry, so the season is not part of the conversion.
 */
export async function anilistIdForTmdb(
  tmdbId: string,
): Promise<AnimeMapping | null> {
  if (!/^\d{1,12}$/.test(String(tmdbId)) || !asId(tmdbId)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}?themoviedb_id=${encodeURIComponent(tmdbId)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    // 404 is the API saying "this is not anime". An answer, not an error.
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return parseAniZipMappings(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
