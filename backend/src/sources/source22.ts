/**
 * Vidly subtitle lane (Source 22)
 * ===============================
 * Vidly (https://vidly.pro) is a TMDB-keyed embed player. Its *streams* are gated
 * by a session token and an obfuscated (not encrypted) payload, which is the kind
 * of dependency that breaks without warning and would need re-porting on every
 * redeploy. Its *subtitle index* is not gated at all:
 *
 *   GET /api/subtitles?kind=movie&tmdb=<id>
 *   GET /api/subtitles?kind=tv&tmdb=<id>&season=<s>&episode=<e>
 *
 * Both answer plain JSON with no token, no cookie and no key:
 *
 *   { "subtitles": [ { "url": "https://cache.vdrk.site/v1/vtt/movie/1010581/Hindi.vtt",
 *                      "lang": "hi", "label": "Hindi", "group": "Hindi",
 *                      "source": "vdrk" }, ... ] }
 *
 * A single title carries 60+ tracks, including the Indic set (Hindi, Malayalam,
 * Tamil, Telugu, Bengali, Punjabi, Urdu) that our dub sources care about and that
 * we otherwise have no way to label correctly.
 *
 * READ THIS BEFORE EXTENDING IT
 * -----------------------------
 * This adapter deliberately does NOT touch `/api/sources`:
 *
 *   - that endpoint requires a per-session token scraped from the page HTML, so
 *     every resolve would cost a full page fetch plus a decrypt;
 *   - the "encryption" is a hand-rolled xorshift keystream keyed by a single
 *     hardcoded string in the public JS bundle, so it is obfuscation with a
 *     shelf life — it changes silently on any redeploy;
 *   - getting it wrong yields garbage rather than an error, which is the worst
 *     kind of failure to debug.
 *
 * Subtitles are worth the small, stable surface. Streams are not worth that
 * dependency when the same upstreams are already reachable through citadel
 * (source-14) and the Workers bridge (source-2).
 *
 * Zero disk, one bounded request, no credentials.
 */
import { isSafeUpstreamUrl } from '../security.js';
import type { RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://vidly.pro';
const CDN_HOST = 'cache.vdrk.site';
const FETCH_TIMEOUT_MS = 4000;
const MAX_BYTES = 512 * 1024;
const MAX_TRACKS = 12;

/**
 * Language priority. Hindi first because this lane's distinguishing value over
 * what we already have is the Indic set; English second because it is the most
 * useful fallback for an unmatched viewer.
 */
const LANG_RANK: Record<string, number> = {
  hi: 0, en: 1, ta: 2, te: 3, ml: 4, bn: 5, pa: 6, ur: 7, ar: 8, es: 9, fr: 10,
};

interface VidlySubtitleRow {
  url?: unknown;
  lang?: unknown;
  label?: unknown;
  group?: unknown;
  source?: unknown;
}

/** Prefer non-"HI" (not hearing-impaired) and earlier language rank. */
function trackScore(row: VidlySubtitleRow): number {
  const lang = typeof row.lang === 'string' ? row.lang.toLowerCase() : '';
  const label = typeof row.label === 'string' ? row.label : '';
  const langRank = LANG_RANK[lang];
  const base = langRank === undefined ? 100 : langRank;
  // Measured against the live index for tmdb 1399: the English group is
  // "English (HI)", "English 4/5 (HI)", "English 2", "English 3", "English 6/7"
  // — there is no bare "English" at all. So a plain count cannot be used, and
  // the ordering has to be explicit: a clean (non-HI) track wins even when it is
  // numbered, because hearing-impaired tracks carry sound-effect cues in the
  // dialogue stream and read badly for ordinary viewing. HI is a fallback.
  const hiPenalty = /(?:^|[\s(])HI\)?$/i.test(label) || /\(HI\)/i.test(label) ? 1 : 0;
  // Among equally clean tracks, prefer the earliest numbered variant.
  const variant = Number(/(\d+)\s*(?:\(HI\))?\s*$/i.exec(label)?.[1] ?? 0);
  return base * 4 + hiPenalty * 2 + Math.min(variant, 9) * 0.01;
}

/**
 * Parse the subtitle index into track refs.
 *
 * Exported for tests: this is the only part that can silently change upstream, so
 * it is pinned by its own case rather than left to a live run to notice.
 */
export function vidlySubtitleTracks(body: unknown): RawTrackRef[] {
  const rows = (body as { subtitles?: unknown })?.subtitles;
  if (!Array.isArray(rows)) return [];
  const usable: VidlySubtitleRow[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as VidlySubtitleRow;
    if (typeof row.url !== 'string') continue;
    const url = row.url.trim();
    if (!/^https:\/\//i.test(url) || url.length > 2048) continue;
    if (!isSafeUpstreamUrl(url)) continue;
    // Only the known sentence cache is accepted. An unexpected host in a
    // third-party index must not become a fetch target for our relays.
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host !== CDN_HOST) continue;
    usable.push(row);
  }
  if (!usable.length) return [];
  usable.sort((a, b) => trackScore(a) - trackScore(b));

  const seenLang = new Set<string>();
  const picked: RawTrackRef[] = [];
  for (const row of usable) {
    const lang = typeof row.lang === 'string' ? row.lang.toLowerCase().slice(0, 12) : 'und';
    // One track per language: a viewer chooses a language, not "English 4".
    // Duplicates add menu noise and nothing else.
    if (seenLang.has(lang)) continue;
    seenLang.add(lang);
    const label = typeof row.label === 'string' ? row.label.slice(0, 60) : lang;
    picked.push({
      lang,
      label,
      url: row.url as string,
      format: 'vtt',
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/vtt,*/*' },
    });
    if (picked.length >= MAX_TRACKS) break;
  }
  return picked;
}

function queryPath(query: SourceQuery): string | null {
  if (!/^\d{1,9}$/.test(query.tmdbId)) return null;
  if (query.type === 'movie') return `/api/subtitles?kind=movie&tmdb=${query.tmdbId}`;
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (!Number.isSafeInteger(season) || season < 0 || season > 100) return null;
  if (!Number.isSafeInteger(episode) || episode < 1) return null;
  // 'tv' is the value this endpoint accepts. 'series' — used by the sibling
  // endpoints — returns {"subtitles":[]} here, which looks like "no subtitles
  // exist for this title" rather than "wrong parameter". Verified live against
  // /api/subtitles?kind=tv&tmdb=1399&season=1&episode=1 (60+ tracks).
  return `/api/subtitles?kind=tv&tmdb=${query.tmdbId}&season=${season}&episode=${episode}`;
}

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function fetchFromVidlySubtitles(
  query: SourceQuery,
  trace?: string[],
): Promise<RawTrackRef[]> {
  const path = queryPath(query);
  if (!path) return [];
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: `${API}/`,
      },
      redirect: 'follow',
      signal,
    });
    const body = await readBounded(response, MAX_BYTES);
    if (!body) {
      trace?.push(`http=${response.status}/no-body`);
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      trace?.push('body=not-json');
      return [];
    }
    const rows = (parsed as { subtitles?: unknown })?.subtitles;
    trace?.push(`http=${response.status} rows=${Array.isArray(rows) ? rows.length : 0}`);
    return vidlySubtitleTracks(parsed);
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    trace?.push(`net=${name}${cause ? `/${cause}` : ''}`);
    return [];
  }
}

/**
 * A subtitle lane produces no video candidate. Returning a fake one would make a
 * subtitles-only title look playable and would be ranked as a stream — the exact
 * class of bug that reports a JPEG as a reachable stream.
 *
 * Instead the tracks are exposed here and the registry attaches them to whichever
 * streams it already has for the same title. `resolve` therefore returns nothing
 * and is only kept so the adapter satisfies SourceAdapter.
 */
export const vidlySubtitleLane = {
  async tracks(query: SourceQuery, trace?: string[]): Promise<RawTrackRef[]> {
    return fetchFromVidlySubtitles(query, trace);
  },
};

export function createSource22Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-22',
    label: 'Source 22',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const trace: string[] = [];
      const tracks = await fetchFromVidlySubtitles(query, trace);
      const langs = [...new Set(tracks.map((t) => t.lang))];
      query.diag?.push({
        adapter: 'source-22',
        lane: 'VT',
        // `ok` means "the index answered", not "this title is playable". The
        // panel must not read a subtitle hit as a working stream.
        ok: false,
        ms: Date.now() - started,
        detail:
          `subtitles-only tracks=${tracks.length} ` +
          `langs=${langs.slice(0, 10).join('/') || 'none'} ${trace.join(' ')}`,
      });
      // Attach to the query so the registry can merge them onto its streams.
      if (tracks.length) query.extraSubtitles = tracks;
      return { candidates: [] };
    },
  };
}
