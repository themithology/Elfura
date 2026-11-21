import { readBoundedText } from './upstream-fetch.js';
import { restrictedFetch } from '../restricted-fetch.js';
import type { SourceQuery } from './types.js';

/** Match only a named episode; generic placeholders cannot establish identity. */
export function normalizeAnimeEpisodeTitle(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

/**
 * TMDB series numbering and AniList numbering are not interchangeable. Limit
 * these direct anime lanes to the first TMDB season and require the requested
 * episode title to match the AniZip entry. Missing metadata is a miss, not a
 * reason to guess. The mapping response is bounded and never written to disk.
 */
export async function resolveDirectAnimeEpisode(query: SourceQuery, fetchImpl: typeof fetch = fetch): Promise<{ anilistId: string; episode: number } | null> {
  const episode = query.episode ?? 1;
  if (query.type !== 'tv' || (query.season ?? 1) !== 1 || !/^\d{1,12}$/.test(query.tmdbId) ||
      !Number.isSafeInteger(episode) || episode < 1 || episode > 5000 || !query.resolveMetaFallback) return null;
  try {
    const meta = await query.resolveMetaFallback();
    if (meta?.originalLanguage !== 'ja' || !meta.genres?.some(g => g.toLowerCase() === 'animation')) return null;
    const expected = normalizeAnimeEpisodeTitle(meta.episodeName ?? '');
    if (expected.length < 5 || /^(?:episode|ep)\s*\d+$/i.test(expected)) return null;
    const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(6500)]) : AbortSignal.timeout(6500);
    const response = await restrictedFetch(`https://api.ani.zip/mappings?themoviedb_id=${encodeURIComponent(query.tmdbId)}`, {
      signal, headers: { Accept: 'application/json' },
    }, fetchImpl);
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
    const body = await readBoundedText(response, 4_000_000); if (!body) return null;
    const data: unknown = JSON.parse(body);
    if (!data || typeof data !== 'object') return null;
    const root = data as { mappings?: { anilist_id?: unknown }; episodes?: Record<string, { title?: unknown }> };
    const id = Number(root.mappings?.anilist_id);
    if (!Number.isSafeInteger(id) || id < 1 || id > 9_999_999_999) return null;
    const title = root.episodes?.[String(episode)]?.title;
    if (!title || typeof title !== 'object' || Array.isArray(title)) return null;
    if (!Object.values(title).some(v => typeof v === 'string' && normalizeAnimeEpisodeTitle(v) === expected)) return null;
    return { anilistId: String(id), episode };
  } catch { return null; }
}
