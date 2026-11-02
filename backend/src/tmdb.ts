/**
 * Elfura Backend — Self-Hosted TMDB Metadata Client
 * =================================================
 * Queries our hosted TMDB API (`TMDB_API_BASE`) with zero local disk caching.
 * Uses a bounded in-memory RAM cache + concurrent TV show/episode resolution
 * and never blocks stream playback if metadata fails.
 */

import type { BackendConfig } from './config.js';

export interface MediaMetadata {
  type: 'movie' | 'tv';
  tmdbId: string;
  imdbId: string | null;
  season?: number;
  episode?: number;
  title: string;
  /** Clean movie or series title without episode suffix, for upstream search queries. */
  rawTitle?: string;
  year: string;
  /** Primary release / first-air date (YYYY-MM-DD) when available. */
  releaseDate?: string;
  /** Episode air date or series last-air date (YYYY-MM-DD) when available. */
  latestDate?: string;
  /** Original ISO 639-1 language code reported by TMDB (e.g. 'ja', 'en', 'ko'). */
  originalLanguage?: string;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  logo: string | null;
}

const MAX_TMDB_RAM_ENTRIES = 512;
const TMDB_RAM_TTL_MS = 30 * 60_000;

const tmdbRamCache = new Map<string, { expiresAt: number; value: MediaMetadata }>();
const tmdbInFlight = new Map<string, Promise<MediaMetadata>>();

function cloneMeta(meta: MediaMetadata): MediaMetadata {
  return { ...meta };
}

function getCachedMeta(key: string): MediaMetadata | null {
  const hit = tmdbRamCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    tmdbRamCache.delete(key);
    return null;
  }
  tmdbRamCache.delete(key);
  tmdbRamCache.set(key, hit);
  return cloneMeta(hit.value);
}

function setCachedMeta(key: string, value: MediaMetadata): void {
  if (!value.title && !value.imdbId && !value.poster && !value.backdrop) return;
  if (tmdbRamCache.has(key)) tmdbRamCache.delete(key);
  while (tmdbRamCache.size >= MAX_TMDB_RAM_ENTRIES) {
    const oldest = tmdbRamCache.keys().next().value;
    if (oldest === undefined) break;
    tmdbRamCache.delete(oldest);
  }
  tmdbRamCache.set(key, {
    expiresAt: Date.now() + TMDB_RAM_TTL_MS,
    value: cloneMeta(value),
  });
}

function fullImageUrl(imageBase: string, path: unknown, size: string): string | null {
  if (typeof path !== 'string' || !path.trim()) return null;
  const trimmed = path.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const rel = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return `${imageBase}/${size}${rel}`;
}

function unwrapPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
    return obj.data as Record<string, unknown>;
  }
  if (obj.result && typeof obj.result === 'object' && !Array.isArray(obj.result)) {
    return obj.result as Record<string, unknown>;
  }
  return obj;
}

export async function fetchTmdbMetadata(
  cfg: BackendConfig['tmdb'],
  params: { type: 'movie' | 'tv'; tmdbId: string; season?: number; episode?: number },
): Promise<MediaMetadata> {
  const fallback: MediaMetadata = {
    type: params.type,
    tmdbId: params.tmdbId,
    imdbId: null,
    ...(params.type === 'tv' ? { season: params.season ?? 1, episode: params.episode ?? 1 } : {}),
    title: '',
    year: '',
    overview: '',
    poster: null,
    backdrop: null,
    logo: null,
  };

  const base = cfg.apiBase || (cfg.apiKey || cfg.bearerToken ? 'https://api.themoviedb.org/3' : '');
  if (!base) return fallback;

  const cacheKey = `${base}|${params.type}|${params.tmdbId}|${params.season ?? 0}|${params.episode ?? 0}`;
  const cached = getCachedMeta(cacheKey);
  if (cached) return cached;

  const inflight = tmdbInFlight.get(cacheKey);
  if (inflight) return inflight.then(cloneMeta);

  const task = (async (): Promise<MediaMetadata> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.bearerToken) headers.Authorization = `Bearer ${cfg.bearerToken}`;

    const buildUrl = (subpath: string, extraQuery: Record<string, string> = {}): string => {
      const u = new URL(`${base}${subpath.startsWith('/') ? subpath : `/${subpath}`}`);
      if (cfg.apiKey && !u.searchParams.has('api_key')) u.searchParams.set('api_key', cfg.apiKey);
      for (const [k, v] of Object.entries(extraQuery)) u.searchParams.set(k, v);
      return u.toString();
    };

    try {
      const mainUrl = buildUrl(`/${params.type}/${encodeURIComponent(params.tmdbId)}`, {
        append_to_response: 'external_ids,images',
        include_image_language: 'en,null',
      });

      const epPromise =
        params.type === 'tv' && params.season && params.episode
          ? fetch(
              buildUrl(`/tv/${encodeURIComponent(params.tmdbId)}/season/${params.season}/episode/${params.episode}`),
              {
                headers,
                signal: AbortSignal.timeout(Math.min(2500, cfg.timeoutMs)),
              },
            )
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null)
          : Promise.resolve(null);

      const [mainRes, rawEpJson] = await Promise.all([
        fetch(mainUrl, { headers, signal: AbortSignal.timeout(cfg.timeoutMs) }),
        epPromise,
      ]);

      if (!mainRes.ok) return fallback;
      const data = unwrapPayload(await mainRes.json());
      if (!data) return fallback;

      const extIds =
        data.external_ids && typeof data.external_ids === 'object'
          ? (data.external_ids as Record<string, unknown>)
          : null;
      const imdbId =
        typeof data.imdb_id === 'string' && data.imdb_id
          ? data.imdb_id
          : typeof extIds?.imdb_id === 'string' && extIds.imdb_id
            ? extIds.imdb_id
            : null;

      const cleanSeriesOrMovieTitle = String(
        data.title ?? data.name ?? data.original_title ?? data.original_name ?? '',
      ).trim();
      let baseTitle = cleanSeriesOrMovieTitle;
      let overview = String(data.overview ?? '').trim();
      let backdrop = fullImageUrl(cfg.imageBase, data.backdrop_path ?? data.backdrop, 'w1280');
      let latestDateRaw = String(data.last_air_date ?? '').trim();

      if (params.type === 'tv' && params.season && params.episode) {
        const epData = unwrapPayload(rawEpJson);
        if (epData) {
          const epName = typeof epData.name === 'string' ? epData.name.trim() : '';
          if (epName && baseTitle) {
            baseTitle = `${baseTitle} · S${params.season}E${params.episode} — ${epName}`;
          } else if (baseTitle) {
            baseTitle = `${baseTitle} · S${params.season}E${params.episode}`;
          }
          if (typeof epData.overview === 'string' && epData.overview.trim()) {
            overview = epData.overview.trim();
          }
          if (typeof epData.air_date === 'string' && epData.air_date.trim()) {
            latestDateRaw = epData.air_date.trim();
          }
          const still = fullImageUrl(cfg.imageBase, epData.still_path, 'w1280');
          if (still) backdrop = still;
        } else if (baseTitle) {
          baseTitle = `${baseTitle} · S${params.season}E${params.episode}`;
        }
      }

      const images =
        data.images && typeof data.images === 'object'
          ? (data.images as { logos?: Record<string, unknown>[] })
          : null;
      const logos = Array.isArray(images?.logos) ? images!.logos : [];
      const pickedLogo = logos.find((l) => l?.iso_639_1 === 'en') ?? logos[0];
      const logoPath =
        typeof pickedLogo?.file_path === 'string' ? pickedLogo.file_path.replace(/\.svg$/i, '.png') : null;

      const releaseRaw = String(data.release_date ?? data.first_air_date ?? data.year ?? '').trim();
      const year = releaseRaw.slice(0, 4);
      const originalLanguage =
        typeof data.original_language === 'string' && data.original_language.trim()
          ? data.original_language.trim().toLowerCase()
          : undefined;

      const resolved: MediaMetadata = {
        type: params.type,
        tmdbId: params.tmdbId,
        imdbId,
        ...(params.type === 'tv' ? { season: params.season ?? 1, episode: params.episode ?? 1 } : {}),
        title: baseTitle,
        ...(cleanSeriesOrMovieTitle ? { rawTitle: cleanSeriesOrMovieTitle } : {}),
        year,
        ...(releaseRaw.length >= 8 ? { releaseDate: releaseRaw.slice(0, 10) } : {}),
        ...(latestDateRaw.length >= 8 ? { latestDate: latestDateRaw.slice(0, 10) } : {}),
        ...(originalLanguage ? { originalLanguage } : {}),
        overview,
        poster: fullImageUrl(cfg.imageBase, data.poster_path ?? data.poster, 'w780'),
        backdrop,
        logo: fullImageUrl(cfg.imageBase, logoPath, 'w780'),
      };
      setCachedMeta(cacheKey, resolved);
      return resolved;
    } catch {
      return fallback;
    }
  })();

  tmdbInFlight.set(cacheKey, task);
  try {
    return cloneMeta(await task);
  } finally {
    tmdbInFlight.delete(cacheKey);
  }
}
