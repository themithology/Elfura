/**
 * AniVortex direct adapter (Source 17) — movies, series, anime and Asian drama.
 *
 * The upstream catalogue is addressed by AniVortex's own numeric title ids, not
 * TMDB, so the adapter resolves a title through `/api/v1/search`, confirms the
 * year/kind, then asks `/api/v1/titles/{id}/playback` for stream rows. TV
 * episodes come from `/api/v1/titles/{id}/watch`.
 *
 * Every route is gated by a signed installation (see `../anivortex-auth.ts`),
 * so the adapter is disabled unless `ELFURA_ANIVORTEX_ENABLED=1` *and*
 * installation credentials exist. Language names in playback responses are
 * provider labels: they become `claimedAudioLang`/`audioLabel` only, never
 * verified `audioLang` — the liveness probe supplies real manifest evidence.
 */

import { anivortexRequest, readAnivortexCredentials, type AnivortexCredentials } from '../anivortex-auth.js';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const MAX_SEARCH_RESULTS = 12;
const MAX_CANDIDATES = 12;
const MAX_EXTRA_SERVERS = 2;
const MAX_SUBTITLES = 16;
const RESOLVE_BUDGET_MS = 4200;

export interface AnivortexTitle {
  id: string;
  title: string;
  originalTitle: string;
  contentType: string;
  releaseYear: number | null;
}

function normalizeTitle(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toTitle(raw: any): AnivortexTitle | null {
  const id = Number(raw?.id);
  const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
  if (!Number.isSafeInteger(id) || id < 1 || !title) return null;
  const year = Number(raw?.release_year ?? raw?.releaseYear);
  return {
    id: String(id),
    title,
    originalTitle: typeof (raw?.original_title ?? raw?.originalTitle) === 'string' ? (raw.original_title ?? raw.originalTitle) : '',
    contentType: String(raw?.content_type ?? raw?.contentType ?? '').toLowerCase(),
    releaseYear: Number.isFinite(year) && year > 1900 ? year : null,
  };
}

/** Score a search hit against the query; higher is better, < 0 disqualifies. */
export function scoreTitleMatch(
  candidate: AnivortexTitle,
  query: { type: 'movie' | 'tv'; title?: string; year?: string },
): number {
  const wanted = normalizeTitle(query.title);
  if (!wanted) return -1;
  const names = [normalizeTitle(candidate.title), normalizeTitle(candidate.originalTitle)].filter(Boolean);
  const exact = names.some((name) => name === wanted);
  const prefix = names.some((name) => name.startsWith(wanted) || wanted.startsWith(name));
  if (!exact && !prefix) return -1;

  // 'movie' upstream covers features; series/anime/drama are episodic.
  const movieKind = candidate.contentType === 'movie' || candidate.contentType === 'anime_movie';
  if (query.type === 'movie' ? !movieKind : movieKind) return -1;

  let score = exact ? 100 : 40;
  const wantedYear = Number(query.year);
  if (Number.isFinite(wantedYear) && candidate.releaseYear) {
    const delta = Math.abs(candidate.releaseYear - wantedYear);
    if (delta === 0) score += 30;
    else if (delta === 1) score += 15;
    else if (delta > 2) score -= 45;
  }
  if (candidate.contentType === 'anime' && query.type === 'tv') score += 2;
  return score;
}

export function pickBestTitle(
  items: AnivortexTitle[],
  query: { type: 'movie' | 'tv'; title?: string; year?: string },
): AnivortexTitle | null {
  let best: { title: AnivortexTitle; score: number } | null = null;
  for (const item of items.slice(0, MAX_SEARCH_RESULTS)) {
    const score = scoreTitleMatch(item, query);
    if (score >= 0 && (!best || score > best.score)) best = { title: item, score };
  }
  return best?.title ?? null;
}

function safeMediaUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null;
  if (!isSafeUpstreamUrl(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function streamType(url: string, declared: unknown): RawStreamCandidate['type'] | null {
  const hint = String(declared ?? '').toLowerCase();
  if (/\bhls\b|m3u8/.test(hint) || /\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  if (/\bdash\b|mpd/.test(hint) || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (/\bmp4\b|progressive/.test(hint) || /\.(?:mp4|m4v)(?:[?#]|$)/i.test(url)) return 'mp4';
  return null;
}

/** Keep only the three upstream headers that can matter, and nothing identifying. */
function safeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length > 2048) continue;
    const name = key.toLowerCase();
    if (name === 'referer') out.Referer = value;
    else if (name === 'origin') out.Origin = value;
    else if (name === 'user-agent') out['User-Agent'] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function subtitleTracks(raw: unknown): RawTrackRef[] {
  if (!Array.isArray(raw)) return [];
  const tracks: RawTrackRef[] = [];
  for (const item of raw.slice(0, MAX_SUBTITLES)) {
    const any = item as any;
    const url = safeMediaUrl(any?.url ?? any?.file ?? any?.src);
    if (!url) continue;
    const label = String(any?.label ?? any?.name ?? any?.title ?? '').trim().slice(0, 100);
    const lang = normalizeLang(String(any?.code ?? any?.lang ?? any?.language ?? ''), label).code || 'und';
    const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
    tracks.push({
      lang,
      label: label || lang,
      url,
      format: ext === 'ass' ? 'ass' : ext === 'srt' ? 'srt' : 'vtt',
    });
  }
  return tracks;
}

/**
 * Flatten one playback server into rows.
 *
 * Live shape (verified 2026-11-15): each language carries
 *   `playback.sources[]` → `{ quality, format: 'dash'|'mp4', url, headers }`
 * plus `download_options[]` → progressive MP4s with real quality labels.
 * Languages are separate streams per dub, never one multi-audio manifest, so
 * they are surfaced as distinct candidates with label-only audio claims.
 */
function serverRows(server: any, subtitles: RawTrackRef[]): RawStreamCandidate[] {
  const rows: RawStreamCandidate[] = [];
  const languages = Array.isArray(server?.languages) ? server.languages : [];
  for (const language of languages.slice(0, 24)) {
    const label = String(language?.name ?? language?.code ?? '').trim().slice(0, 60);
    const code = normalizeLang(String(language?.code ?? ''), label).code || undefined;
    const sources = Array.isArray(language?.playback?.sources)
      ? language.playback.sources
      : Array.isArray(language?.qualities) ? language.qualities : [];
    const downloads = Array.isArray(language?.download_options) ? language.download_options : [];

    const push = (row: any): void => {
      const url = safeMediaUrl(row?.url);
      if (!url) return;
      const type = streamType(url, row?.format ?? row?.type);
      if (!type) return;
      rows.push({
        key: `${server?.key ?? 'srv'}:${code ?? 'und'}:${row?.id ?? row?.quality ?? ''}:${url}`,
        type,
        url,
        ...(safeHeaders(row?.headers) ? { headers: safeHeaders(row?.headers) } : {}),
        quality: String(row?.quality ?? 'auto').trim().slice(0, 24) || 'auto',
        claimedAudioLang: code,
        audioLabel: label ? `${label} (provider label)` : undefined,
        audioVariant: /\bsub\b/i.test(label) ? 'sub' : /\bdub\b/i.test(label) ? 'dub' : undefined,
        subtitles,
        rank: 60,
      });
    };

    for (const source of sources.slice(0, 8)) push(source);
    // Progressive MP4 options are a fallback only: they are whole files, so they
    // are not promoted ahead of adaptive streams but do keep a lane alive.
    if (sources.length === 0) {
      const preferred = [...downloads]
        .sort((a: any, b: any) => qualityWeight(a?.quality) - qualityWeight(b?.quality))
        .slice(0, 1);
      for (const option of preferred) push(option);
    }
  }
  return rows;
}

function qualityWeight(label: unknown): number {
  const text = String(label ?? '').toLowerCase();
  if (/4k|2160/.test(text)) return 0;
  if (/2k|1440/.test(text)) return 1;
  if (/1080/.test(text)) return 2;
  if (/720/.test(text)) return 3;
  if (/480/.test(text)) return 4;
  return 5;
}

function playbackServers(payload: any): any[] {
  const servers: any[] = [];
  if (payload?.server && typeof payload.server === 'object') servers.push(payload.server);
  return servers;
}

function serverOptions(payload: any): string[] {
  const raw = Array.isArray(payload?.server_options) ? payload.server_options : [];
  const keys: string[] = [];
  for (const option of raw) {
    const key = typeof option === 'string' ? option : String(option?.key ?? '');
    if (key && /^[A-Za-z0-9._-]{1,64}$/.test(key) && !keys.includes(key)) keys.push(key);
    if (keys.length >= MAX_EXTRA_SERVERS) break;
  }
  return keys;
}

/**
 * Resolve the upstream episode id for a TV query.
 *
 * Verified protocol: `/titles/{id}/watch` returns seasons `{ id, season_number,
 * episode_count }` only, and `/seasons/{seasonId}/episodes` returns the episodes
 * with their ids. Playback then REQUIRES `episode_id`; `season`/`episode` query
 * parameters are rejected with `invalid_query`.
 */
export async function resolveEpisode(
  credentials: AnivortexCredentials,
  titleId: string,
  seasonNumber: number,
  episodeNumber: number,
  signal: AbortSignal,
): Promise<{ episodeId: string; servers: string[] } | null> {
  const watch = await signedJson(credentials, `/api/v1/titles/${titleId}/watch`, {}, signal) as any;
  const seasons = Array.isArray(watch?.seasons) ? watch.seasons : [];
  const season = seasons.find((entry: any) => Number(entry?.season_number) === seasonNumber)
    ?? seasons[0];
  const seasonId = Number(season?.id);
  if (!Number.isSafeInteger(seasonId) || seasonId < 1) return null;

  const listing = await signedJson(credentials, `/api/v1/seasons/${seasonId}/episodes`, {}, signal) as any;
  const episodes = Array.isArray(listing?.episodes) ? listing.episodes : [];
  const episode = episodes.find((entry: any) => Number(entry?.episode_number) === episodeNumber);
  const episodeId = Number(episode?.id);
  if (!Number.isSafeInteger(episodeId) || episodeId < 1) return null;

  const servers = (Array.isArray(episode?.available_servers) ? episode.available_servers : [])
    .map((entry: any) => String(entry?.key ?? ''))
    .filter((key: string) => /^[A-Za-z0-9._-]{1,64}$/.test(key));
  return { episodeId: String(episodeId), servers };
}

/**
 * Playback accepts only `episode_id`, `include_adult`, `server` and `language`
 * (the API rejects anything else with `invalid_query`).
 */
export function playbackQueryAttempts(
  query: SourceQuery,
  episodeId: string | null,
  serverKeys: string[] = [],
): Array<Record<string, string>> {
  const base: Record<string, string> = query.type === 'tv' && episodeId ? { episode_id: episodeId } : {};
  const attempts: Array<Record<string, string>> = [base];
  for (const key of serverKeys.slice(0, MAX_EXTRA_SERVERS)) attempts.push({ ...base, server: key });
  return attempts;
}

async function signedJson(
  credentials: AnivortexCredentials,
  path: string,
  query: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const result = await anivortexRequest(credentials, { method: 'GET', path, query }, { signal }).catch(() => null);
  return result?.ok ? result.json : null;
}

export async function fetchFromAnivortex(
  query: SourceQuery,
  credentials: AnivortexCredentials | null = readAnivortexCredentials(),
): Promise<RawStreamCandidate[]> {
  if (!credentials) return [];
  const parent = query.signal ?? new AbortController().signal;
  const signal = AbortSignal.any([parent, AbortSignal.timeout(RESOLVE_BUDGET_MS)]);
  if (!/^\d{1,9}$/.test(query.tmdbId)) return [];

  let searchTitle = (query.title ?? '').trim();
  if (!searchTitle && query.resolveMetaFallback) {
    const meta = await query.resolveMetaFallback().catch(() => null);
    searchTitle = (meta?.title ?? '').trim();
  }
  if (!searchTitle) return [];

  const search = await signedJson(credentials, '/api/v1/search', { q: searchTitle.slice(0, 120) }, signal) as any;
  const rawItems = Array.isArray(search?.results)
    ? search.results
    : Array.isArray(search?.items)
      ? search.items
      : Array.isArray(search)
        ? search
        : [];
  const titles = rawItems.slice(0, MAX_SEARCH_RESULTS).map(toTitle).filter((item: AnivortexTitle | null): item is AnivortexTitle => !!item);
  const match = pickBestTitle(titles, { type: query.type, title: searchTitle, year: query.year });
  if (!match) return [];

  let episodeId: string | null = null;
  let episodeServers: string[] = [];
  if (query.type === 'tv') {
    const episode = await resolveEpisode(
      credentials,
      match.id,
      Number(query.season ?? 1),
      Number(query.episode ?? 1),
      signal,
    );
    // Playback rejects season/episode for TV; without an episode id there is
    // nothing to ask for, so stop instead of provoking a 400.
    if (!episode) return [];
    episodeId = episode.episodeId;
    episodeServers = episode.servers;
  }

  const candidates: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  const primary = await signedJson(
    credentials,
    `/api/v1/titles/${match.id}/playback`,
    playbackQueryAttempts(query, episodeId)[0],
    signal,
  );
  const attempts = playbackQueryAttempts(query, episodeId, [...episodeServers, ...serverOptions(primary)]);
  for (const attempt of attempts) {
    const payload = attempt.server
      ? await signedJson(credentials, `/api/v1/titles/${match.id}/playback`, attempt, signal)
      : primary;
    const servers = playbackServers(payload);
    if (servers.length === 0) continue;

    for (const server of servers) {
      const subtitles = subtitleTracks(server?.subtitles);
      for (const candidate of serverRows(server, subtitles)) {
        if (seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        candidate.rank = 60 + candidates.length;
        candidates.push(candidate);
        if (candidates.length >= MAX_CANDIDATES) return candidates;
      }
    }
  }
  if (candidates.length === 0) return [];
  return candidates;
}

export function createSource17Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-17',
    label: 'Source 17',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const credentials = readAnivortexCredentials();
      if (!credentials) {
        query.diag?.push({
          adapter: 'source-17',
          lane: 'V',
          ok: false,
          ms: 0,
          detail: 'no installation credentials (ELFURA_ANIVORTEX_INSTALL_ID / _KEY_ID / _PRIVATE_KEY)',
        });
        return { candidates: [] };
      }
      const raw = await fetchFromAnivortex(query, credentials);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter(candidate => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-17',
        lane: 'V',
        ok: candidates.length > 0,
        ms: Date.now() - started,
        detail: `playbackRows=${raw.length},manifestReachable=${candidates.length}`,
      });
      return { candidates: candidates.map(candidate => query.diag
        ? { ...candidate, diagnosticLane: 'V' }
        : candidate) };
    },
  };
}
