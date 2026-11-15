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

type PlaybackRow = { url: string; type: RawStreamCandidate['type']; quality: string; headers?: Record<string, string> };

/** Flatten one playback server into rows, preserving provider language labels. */
function serverRows(server: any, subtitles: RawTrackRef[]): RawStreamCandidate[] {
  const rows: RawStreamCandidate[] = [];
  const languages = Array.isArray(server?.languages) ? server.languages : [];
  for (const language of languages.slice(0, 24)) {
    const label = String(language?.name ?? language?.code ?? '').trim().slice(0, 60);
    const code = normalizeLang(String(language?.code ?? ''), label).code || undefined;
    const qualities = Array.isArray(language?.playback?.qualities)
      ? language.playback.qualities
      : Array.isArray(language?.qualities) ? language.qualities : [];
    for (const quality of qualities.slice(0, 12)) {
      const url = safeMediaUrl(quality?.url);
      if (!url) continue;
      const type = streamType(url, quality?.type ?? quality?.format);
      if (!type) continue;
      const row: PlaybackRow = {
        url,
        type,
        quality: String(quality?.quality ?? 'auto').trim().slice(0, 24) || 'auto',
        headers: safeHeaders(quality?.headers),
      };
      rows.push({
        key: `${server?.key ?? 'srv'}:${code ?? 'und'}:${row.quality}:${row.url}`,
        type: row.type,
        url: row.url,
        ...(row.headers ? { headers: row.headers } : {}),
        quality: row.quality,
        claimedAudioLang: code,
        audioLabel: label ? `${label} (provider label)` : undefined,
        audioVariant: /\bsub\b/i.test(label) ? 'sub' : /\bdub\b/i.test(label) ? 'dub' : undefined,
        subtitles,
        rank: 60,
      });
    }
  }
  return rows;
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

/** Episode ids are optional: playback accepts season/episode, or an episode id. */
export function episodeIdsFromWatchPayload(payload: any, season: number, episode: number): string[] {
  const ids: string[] = [];
  const visit = (node: any, inheritedSeason?: number): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, inheritedSeason);
      return;
    }
    const nodeSeason = Number(node.season_number ?? node.seasonNumber ?? inheritedSeason);
    const nodeEpisode = Number(node.episode_number ?? node.episodeNumber ?? node.number);
    if (Number.isFinite(nodeEpisode) && nodeEpisode === episode && nodeSeason === season) {
      const direct = node.episode_id ?? node.id ?? node.episodeId;
      if (typeof direct === 'string' || typeof direct === 'number') ids.push(String(direct));
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, Number.isFinite(nodeSeason) ? nodeSeason : inheritedSeason);
    }
  };
  for (const value of Object.values(payload ?? {})) visit(value);
  return [...new Set(ids)].slice(0, 3);
}

/** Query shapes to try, best first; the signed canonical string covers whichever we send. */
export function playbackQueryAttempts(
  query: SourceQuery,
  episodeIds: string[],
): Array<Record<string, string>> {
  if (query.type === 'movie') return [{}, ...episodeIds.slice(0, 1).map((id) => ({ episode_id: id }))];
  const season = String(query.season ?? 1);
  const episode = String(query.episode ?? 1);
  const attempts: Array<Record<string, string>> = [];
  for (const id of episodeIds) attempts.push({ episode_id: id });
  attempts.push({ season, episode });
  return attempts.slice(0, 3);
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

  let episodeIds: string[] = [];
  if (query.type === 'tv') {
    const watch = await signedJson(credentials, `/api/v1/titles/${match.id}/watch`, {}, signal);
    episodeIds = episodeIdsFromWatchPayload(watch, Number(query.season ?? 1), Number(query.episode ?? 1));
  }

  const candidates: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  const attempts = playbackQueryAttempts(query, episodeIds);
  for (const attempt of attempts) {
    const payload = await signedJson(credentials, `/api/v1/titles/${match.id}/playback`, attempt, signal);
    const servers = playbackServers(payload);
    if (servers.length === 0) continue;

    // Pull up to two additional announced servers, bounded and signed.
    const extras = await Promise.all(serverOptions(payload).map(async (key) => {
      const extra = await signedJson(credentials, `/api/v1/titles/${match.id}/playback`, { ...attempt, server: key }, signal);
      return playbackServers(extra);
    }));

    for (const server of [...servers, ...extras.flat()]) {
      const subtitles = subtitleTracks(server?.subtitles);
      for (const candidate of serverRows(server, subtitles)) {
        if (seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        candidate.rank = 60 + candidates.length;
        candidates.push(candidate);
        if (candidates.length >= MAX_CANDIDATES) return candidates;
      }
    }
    // A responding server already gave us rows; do not probe alternate query shapes.
    if (candidates.length > 0) break;
  }
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
