/**
 * Elfura Backend — Self-Hosted TMDB Metadata Client
 * =================================================
 * Queries our hosted TMDB API (`TMDB_API_BASE`) with zero local disk caching.
 * Uses a bounded in-memory RAM cache + concurrent TV show/episode resolution
 * and never blocks stream playback if metadata fails.
 */

import type { BackendConfig } from './config.js';

export interface SeasonSummary {
  seasonNumber: number;
  name: string;
  episodeCount: number;
}

export interface EpisodeItem {
  episodeNumber: number;
  seasonNumber: number;
  name: string;
  overview: string;
  runtime: number | null;
  rating: number | null;
  airDate: string;
  still: string | null;
}

export interface SeriesSeasonCatalog {
  tmdbId: string;
  season: number;
  seasons: SeasonSummary[];
  episodes: EpisodeItem[];
}

export interface MediaMetadata {
  type: 'movie' | 'tv';
  tmdbId: string;
  imdbId: string | null;
  season?: number;
  episode?: number;
  episodeName?: string;
  seasons?: SeasonSummary[];
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
  tagline?: string;
  rating?: number | null;
  genres?: string[];
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
  return {
    ...meta,
    ...(meta.genres ? { genres: [...meta.genres] } : {}),
    ...(meta.seasons ? { seasons: meta.seasons.map((s) => ({ ...s })) } : {}),
  };
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

const DEFAULT_TMDB_FALLBACK_KEY = '47a1a7df542d3d483227f758a7317dff';

interface TmdbEndpoint {
  base: string;
  apiKey: string;
  bearerToken: string;
}

function isLoopbackBase(rawBase: string): boolean {
  try {
    const h = new URL(rawBase).hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

function resolveTmdbEndpoints(cfg: BackendConfig['tmdb']): TmdbEndpoint[] {
  const endpoints: TmdbEndpoint[] = [];
  if (cfg.apiBase) {
    endpoints.push({
      base: cfg.apiBase.replace(/\/+$/, ''),
      apiKey: cfg.apiKey,
      bearerToken: cfg.bearerToken,
    });
    if (isLoopbackBase(cfg.apiBase) || process.env.TMDB_DISABLE_FALLBACK === '1') {
      return endpoints;
    }
  } else if (cfg.apiKey || cfg.bearerToken) {
    endpoints.push({
      base: 'https://api.themoviedb.org/3',
      apiKey: cfg.apiKey,
      bearerToken: cfg.bearerToken,
    });
    endpoints.push({
      base: 'https://api.tmdb.org/3',
      apiKey: cfg.apiKey,
      bearerToken: cfg.bearerToken,
    });
    return endpoints;
  }

  if (process.env.TMDB_DISABLE_FALLBACK !== '1') {
    const fallbackKey = cfg.apiKey || DEFAULT_TMDB_FALLBACK_KEY;
    endpoints.push({ base: 'https://api.themoviedb.org/3', apiKey: fallbackKey, bearerToken: '' });
    endpoints.push({ base: 'https://api.tmdb.org/3', apiKey: fallbackKey, bearerToken: '' });
  }
  return endpoints;
}

function buildEndpointUrl(
  ep: TmdbEndpoint,
  subpath: string,
  extraQuery: Record<string, string> = {},
): string {
  const u = new URL(`${ep.base}${subpath.startsWith('/') ? subpath : `/${subpath}`}`);
  if (ep.apiKey && !u.searchParams.has('api_key')) u.searchParams.set('api_key', ep.apiKey);
  for (const [k, v] of Object.entries(extraQuery)) u.searchParams.set(k, v);
  return u.toString();
}

function buildEndpointHeaders(ep: TmdbEndpoint): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ep.bearerToken) {
    headers.Authorization = ep.bearerToken.startsWith('Bearer ')
      ? ep.bearerToken
      : `Bearer ${ep.bearerToken}`;
  }
  return headers;
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

  const endpoints = resolveTmdbEndpoints(cfg);
  if (!endpoints.length) return fallback;

  const cacheKey = `${endpoints[0].base}|${params.type}|${params.tmdbId}|${params.season ?? 0}|${params.episode ?? 0}`;
  const cached = getCachedMeta(cacheKey);
  if (cached) return cached;

  const inflight = tmdbInFlight.get(cacheKey);
  if (inflight) return inflight.then(cloneMeta);

  const task = (async (): Promise<MediaMetadata> => {
    try {
      let data: Record<string, unknown> | null = null;
      let rawEpJson: unknown = null;
      let matchedEp: TmdbEndpoint = endpoints[0];

      for (const ep of endpoints) {
        try {
          const headers = buildEndpointHeaders(ep);
          const mainUrl = buildEndpointUrl(ep, `/${params.type}/${encodeURIComponent(params.tmdbId)}`, {
            append_to_response: 'external_ids,images',
            include_image_language: 'en,null',
          });

          const epPromise =
            params.type === 'tv' && params.season && params.episode
              ? fetch(
                  buildEndpointUrl(
                    ep,
                    `/tv/${encodeURIComponent(params.tmdbId)}/season/${params.season}/episode/${params.episode}`,
                  ),
                  {
                    headers,
                    signal: AbortSignal.timeout(Math.min(2500, cfg.timeoutMs)),
                  },
                )
                  .then((r) => (r.ok ? r.json() : null))
                  .catch(() => null)
              : Promise.resolve(null);

          const [mainRes, epResJson] = await Promise.all([
            fetch(mainUrl, { headers, signal: AbortSignal.timeout(cfg.timeoutMs) }),
            epPromise,
          ]);

          if (!mainRes.ok) continue;
          const unwrapped = unwrapPayload(await mainRes.json());
          if (unwrapped) {
            data = unwrapped;
            rawEpJson = epResJson;
            matchedEp = ep;
            break;
          }
        } catch {
          /* try next endpoint */
        }
      }

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
      let episodeName = '';
      let overview = String(data.overview ?? '').trim();
      let backdrop = fullImageUrl(cfg.imageBase, data.backdrop_path ?? data.backdrop, 'w1280');
      let latestDateRaw = String(data.last_air_date ?? '').trim();

      if (params.type === 'tv' && params.season && params.episode) {
        const epData = unwrapPayload(rawEpJson);
        if (epData) {
          episodeName = typeof epData.name === 'string' ? epData.name.trim() : '';
          if (episodeName && baseTitle) {
            baseTitle = `${baseTitle} · S${params.season}E${params.episode} — ${episodeName}`;
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

      let images =
        data.images && typeof data.images === 'object'
          ? (data.images as { logos?: Record<string, unknown>[] })
          : null;
      if (!images?.logos) {
        try {
          const imgRes = await fetch(
            buildEndpointUrl(matchedEp, `/${params.type}/${encodeURIComponent(params.tmdbId)}/images`, {
              include_image_language: 'en,null',
            }),
            {
              headers: buildEndpointHeaders(matchedEp),
              signal: AbortSignal.timeout(Math.min(2000, cfg.timeoutMs)),
            },
          );
          if (imgRes.ok) {
            const imgData = unwrapPayload(await imgRes.json());
            if (imgData && Array.isArray(imgData.logos)) {
              images = { logos: imgData.logos as Record<string, unknown>[] };
            }
          }
        } catch {
          /* non-fatal */
        }
      }
      const logos = Array.isArray(images?.logos) ? images!.logos : [];
      const pickedLogo = logos.find((l) => l?.iso_639_1 === 'en') ?? logos[0];
      const logoPath =
        typeof pickedLogo?.file_path === 'string'
          ? pickedLogo.file_path.replace(/\.svg$/i, '.png')
          : typeof data.logo === 'string'
            ? data.logo
            : null;

      const tagline = typeof data.tagline === 'string' ? data.tagline.trim() : '';
      const rawVote = Number(data.vote_average ?? data.rating);
      const rating = Number.isFinite(rawVote) && rawVote > 0 ? Math.round(rawVote * 10) / 10 : null;
      const genres: string[] = Array.isArray(data.genres)
        ? data.genres
            .map((g) =>
              typeof g === 'string'
                ? g.trim()
                : g && typeof g === 'object' && typeof (g as { name?: unknown }).name === 'string'
                  ? String((g as { name: string }).name).trim()
                  : '',
            )
            .filter(Boolean)
            .slice(0, 3)
        : [];

      const releaseRaw = String(data.release_date ?? data.first_air_date ?? data.year ?? '').trim();
      const year = releaseRaw.slice(0, 4);
      const originalLanguage =
        typeof data.original_language === 'string' && data.original_language.trim()
          ? data.original_language.trim().toLowerCase()
          : undefined;

      const parsedSeasons: SeasonSummary[] =
        params.type === 'tv' && Array.isArray(data.seasons)
          ? (data.seasons as Record<string, unknown>[])
              .map((s) => ({
                seasonNumber: Number(s?.season_number),
                name:
                  typeof s?.name === 'string' && s.name.trim()
                    ? s.name.trim()
                    : `Season ${Number(s?.season_number)}`,
                episodeCount: Math.max(0, Number(s?.episode_count) || 0),
              }))
              .filter((s) => Number.isFinite(s.seasonNumber) && s.seasonNumber >= 1)
              .sort((a, b) => a.seasonNumber - b.seasonNumber)
          : [];

      const resolved: MediaMetadata = {
        type: params.type,
        tmdbId: params.tmdbId,
        imdbId,
        ...(params.type === 'tv' ? { season: params.season ?? 1, episode: params.episode ?? 1 } : {}),
        ...(episodeName ? { episodeName } : {}),
        ...(parsedSeasons.length ? { seasons: parsedSeasons } : {}),
        title: baseTitle,
        ...(cleanSeriesOrMovieTitle ? { rawTitle: cleanSeriesOrMovieTitle } : {}),
        year,
        ...(releaseRaw.length >= 8 ? { releaseDate: releaseRaw.slice(0, 10) } : {}),
        ...(latestDateRaw.length >= 8 ? { latestDate: latestDateRaw.slice(0, 10) } : {}),
        ...(originalLanguage ? { originalLanguage } : {}),
        ...(tagline ? { tagline } : {}),
        ...(rating !== null ? { rating } : {}),
        ...(genres.length ? { genres } : {}),
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

const MAX_SEASON_RAM_ENTRIES = 256;
const seasonRamCache = new Map<string, { expiresAt: number; value: SeriesSeasonCatalog }>();
const seasonInFlight = new Map<string, Promise<SeriesSeasonCatalog>>();

export async function fetchTmdbSeasonEpisodes(
  cfg: BackendConfig['tmdb'],
  params: { tmdbId: string; season: number },
): Promise<SeriesSeasonCatalog> {
  const safeSeason = Math.max(1, Math.floor(params.season || 1));
  const fallback: SeriesSeasonCatalog = {
    tmdbId: params.tmdbId,
    season: safeSeason,
    seasons: [{ seasonNumber: safeSeason, name: `Season ${safeSeason}`, episodeCount: 0 }],
    episodes: [],
  };

  const endpoints = resolveTmdbEndpoints(cfg);
  if (!endpoints.length) return fallback;

  const cacheKey = `${endpoints[0].base}|tv:${params.tmdbId}:s:${safeSeason}`;
  const cached = seasonRamCache.get(cacheKey);
  if (cached) {
    if (Date.now() <= cached.expiresAt) {
      seasonRamCache.delete(cacheKey);
      seasonRamCache.set(cacheKey, cached);
      return cached.value;
    }
    seasonRamCache.delete(cacheKey);
  }

  const existing = seasonInFlight.get(cacheKey);
  if (existing) return existing;

  const task = (async (): Promise<SeriesSeasonCatalog> => {
    try {
      let showData: Record<string, unknown> | null = null;
      let seasonData: Record<string, unknown> | null = null;

      for (const ep of endpoints) {
        try {
          const headers = buildEndpointHeaders(ep);
          const [showRes, seasonRes] = await Promise.all([
            fetch(buildEndpointUrl(ep, `/tv/${encodeURIComponent(params.tmdbId)}`), {
              headers,
              signal: AbortSignal.timeout(cfg.timeoutMs),
            }).catch(() => null),
            fetch(buildEndpointUrl(ep, `/tv/${encodeURIComponent(params.tmdbId)}/season/${safeSeason}`), {
              headers,
              signal: AbortSignal.timeout(cfg.timeoutMs),
            }).catch(() => null),
          ]);

          const [rawShow, rawSeason] = await Promise.all([
            showRes && showRes.ok ? showRes.json().catch(() => null) : Promise.resolve(null),
            seasonRes && seasonRes.ok ? seasonRes.json().catch(() => null) : Promise.resolve(null),
          ]);

          const unwrappedSeason = unwrapPayload(rawSeason);
          if (unwrappedSeason && Array.isArray(unwrappedSeason.episodes)) {
            showData = unwrapPayload(rawShow);
            seasonData = unwrappedSeason;
            break;
          }
        } catch {
          /* try next endpoint */
        }
      }

      const seasons: SeasonSummary[] =
        showData && Array.isArray(showData.seasons)
          ? (showData.seasons as Record<string, unknown>[])
              .map((s) => ({
                seasonNumber: Number(s?.season_number),
                name:
                  typeof s?.name === 'string' && s.name.trim()
                    ? s.name.trim()
                    : `Season ${Number(s?.season_number)}`,
                episodeCount: Math.max(0, Number(s?.episode_count) || 0),
              }))
              .filter((s) => Number.isFinite(s.seasonNumber) && s.seasonNumber >= 1)
              .sort((a, b) => a.seasonNumber - b.seasonNumber)
          : [];

      const episodes: EpisodeItem[] =
        seasonData && Array.isArray(seasonData.episodes)
          ? (seasonData.episodes as Record<string, unknown>[])
              .map((ep) => {
                const epNum = Number(ep?.episode_number);
                const rawVote = Number(ep?.vote_average);
                const rawRuntime = Number(ep?.runtime);
                return {
                  episodeNumber: epNum,
                  seasonNumber: Number(ep?.season_number) || safeSeason,
                  name:
                    typeof ep?.name === 'string' && ep.name.trim()
                      ? ep.name.trim()
                      : `Episode ${epNum}`,
                  overview: typeof ep?.overview === 'string' ? ep.overview.trim() : '',
                  runtime:
                    Number.isFinite(rawRuntime) && rawRuntime > 0 ? Math.round(rawRuntime) : null,
                  rating:
                    Number.isFinite(rawVote) && rawVote > 0
                      ? Math.round(rawVote * 10) / 10
                      : null,
                  airDate: typeof ep?.air_date === 'string' ? ep.air_date.trim() : '',
                  still: fullImageUrl(cfg.imageBase, ep?.still_path, 'w500'),
                };
              })
              .filter((ep) => Number.isFinite(ep.episodeNumber) && ep.episodeNumber >= 1)
              .sort((a, b) => a.episodeNumber - b.episodeNumber)
          : [];

      if (!seasons.length) {
        seasons.push({
          seasonNumber: safeSeason,
          name: `Season ${safeSeason}`,
          episodeCount: episodes.length,
        });
      }

      const resolved: SeriesSeasonCatalog = {
        tmdbId: params.tmdbId,
        season: safeSeason,
        seasons,
        episodes,
      };

      if (episodes.length > 0 || seasons.length > 1) {
        if (seasonRamCache.has(cacheKey)) seasonRamCache.delete(cacheKey);
        while (seasonRamCache.size >= MAX_SEASON_RAM_ENTRIES) {
          const oldest = seasonRamCache.keys().next().value;
          if (oldest === undefined) break;
          seasonRamCache.delete(oldest);
        }
        seasonRamCache.set(cacheKey, {
          expiresAt: Date.now() + TMDB_RAM_TTL_MS,
          value: resolved,
        });
      }
      return resolved;
    } catch {
      return fallback;
    }
  })();

  seasonInFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    seasonInFlight.delete(cacheKey);
  }
}

/* ------------------------------------------------------------------ */
/* Public landing-page catalog                                         */
/* ------------------------------------------------------------------ */

export interface TmdbCatalogItem {
  tmdbId: string;
  type: 'movie' | 'tv' | 'anime';
  title: string;
  year: string;
  overview: string;
  rating: number | null;
  poster: string | null;
  backdrop: string | null;
}

export interface TmdbCatalog {
  generatedAt: string;
  movies: TmdbCatalogItem[];
  series: TmdbCatalogItem[];
  anime: TmdbCatalogItem[];
}

const CATALOG_TTL_MS = 10 * 60_000;
let catalogCache: { expiresAt: number; key: string; value: TmdbCatalog } | null = null;
let catalogInFlight: Promise<TmdbCatalog> | null = null;

async function fetchCatalogList(
  cfg: BackendConfig['tmdb'],
  subpath: string,
  query: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
  for (const ep of resolveTmdbEndpoints(cfg)) {
    try {
      const response = await fetch(buildEndpointUrl(ep, subpath, query), {
        headers: buildEndpointHeaders(ep),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!response.ok) continue;
      const payload = unwrapPayload(await response.json());
      if (Array.isArray(payload?.results)) {
        return payload.results.filter(
          (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item),
        );
      }
    } catch {
      // Try the next configured TMDB endpoint.
    }
  }
  return [];
}

/** Live, sanitized TMDB data for the public landing page. No API key reaches the browser. */
export async function fetchTmdbCatalog(cfg: BackendConfig['tmdb']): Promise<TmdbCatalog> {
  const key = resolveTmdbEndpoints(cfg)[0]?.base || 'none';
  if (catalogCache && catalogCache.key === key && Date.now() <= catalogCache.expiresAt) {
    return catalogCache.value;
  }
  if (catalogInFlight) return catalogInFlight;

  catalogInFlight = (async () => {
    const [movieRows, seriesRows, animeRows] = await Promise.all([
      fetchCatalogList(cfg, '/trending/movie/week', { language: 'en-US' }),
      fetchCatalogList(cfg, '/trending/tv/week', { language: 'en-US' }),
      fetchCatalogList(cfg, '/discover/tv', {
        language: 'en-US',
        sort_by: 'popularity.desc',
        with_genres: '16',
        with_original_language: 'ja',
        'vote_count.gte': '100',
        include_adult: 'false',
      }),
    ]);

    const mapRows = (
      rows: Record<string, unknown>[],
      type: TmdbCatalogItem['type'],
    ): TmdbCatalogItem[] => {
      const seen = new Set<string>();
      const items: TmdbCatalogItem[] = [];
      for (const row of rows) {
        const tmdbId = String(Number(row.id) || '');
        const title = String(row.title || row.name || '').trim();
        if (!tmdbId || !title || row.adult === true || seen.has(tmdbId)) continue;
        seen.add(tmdbId);
        const date = String(row.release_date || row.first_air_date || '');
        const rating = Number(row.vote_average);
        items.push({
          tmdbId,
          type,
          title,
          year: /^\d{4}/.test(date) ? date.slice(0, 4) : '',
          overview: String(row.overview || '').trim(),
          rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : null,
          poster: fullImageUrl(cfg.imageBase, row.poster_path, 'w500'),
          backdrop: fullImageUrl(cfg.imageBase, row.backdrop_path || row.poster_path, 'w1280'),
        });
        if (items.length >= 20) break;
      }
      return items;
    };

    const value: TmdbCatalog = {
      generatedAt: new Date().toISOString(),
      movies: mapRows(movieRows, 'movie'),
      series: mapRows(seriesRows, 'tv'),
      anime: mapRows(animeRows, 'anime'),
    };
    if (value.movies.length || value.series.length || value.anime.length) {
      catalogCache = { key, value, expiresAt: Date.now() + CATALOG_TTL_MS };
    }
    return value;
  })();

  try {
    return await catalogInFlight;
  } finally {
    catalogInFlight = null;
  }
}
