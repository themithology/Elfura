/**
 * Source 2 — greybox.
 *
 * One GET, plain JSON, no token, no browser, no decryption:
 *
 *   GET /api/player/sources?media=movie|tv&id=<tmdb>[&season=&episode=]
 *     → { sources: [ { provider, label, url, type, quality, height,
 *                      language?, audio: [], subtitles: [], intro?, credits? } ] }
 *
 * It is an aggregator: the payload is not greybox's own media, it is a list of
 * rows the provider has already resolved from several upstreams. That matters
 * for how the rows are read, not for whether they play — each row carries a URL,
 * a language and often intro/credits markers.
 *
 * HOW THIS ROW SET WAS MISREAD ONCE
 * ----------------------------------
 * The research harness judged this lane on the first URL its regex found and
 * recorded 502s, which made greybox look dead. Three separate things were wrong,
 * and all three are addressed here:
 *
 *   1. The harness scored the payload's WORST row. The first URL in the payload
 *      was an absolute `workers.dev` bridge in front of `sacdn.hakunaymatata.com`,
 *      and that bridge answers 502. The majority of rows are root-relative
 *      `/api/media?u=...` paths — greybox's own proxy — which were measured 8/8
 *      returning `#EXTM3U` with `content-type: application/vnd.apple.mpegurl`.
 *      Discarding relative URLs would have thrown away most of this source.
 *   2. TV was judged on a 429. The API answers `429` under a first-call burst,
 *      and the harness retried once after six seconds and gave up. A throttle is
 *      "ask again later", never "this lane is dead", so this adapter backs off
 *      and reports the throttle distinctly from a real failure.
 *   3. Rows were counted, not tokenised. A row that carries a URL but never a
 *      manifest is not a stream; the liveness probe is the judge, and a row only
 *      becomes a candidate after it survives that.
 *
 * WHAT THIS ADAPTER REFUSES
 * -------------------------
 *   - absolute rows on a third-party relay (a `workers.dev` bridge, a worker
 *     subdomain). Proxy-fronted media is somebody else's bandwidth and is not
 *     promoted on this board. Greybox's OWN proxy is not a relay in that sense:
 *     it lives on the provider's origin, next to the API that hands it out.
 *   - rows whose language cannot be read. An unlabelled row can win a
 *     language-filtered race by accident.
 *   - non-HTTPS, non-absolute-after-resolution URLs.
 *
 * The size rule from Source 1 applies here unchanged: rows that survive the
 * probe are ranked by real measured bytes, so a 1080p row beats a 720p row when
 * the bytes say it should, and not because a label claimed it.
 */
import type { RawStreamCandidate, RawTrackRef, SkipSegments, SourceAdapter, SourceQuery } from './types.js';
import { sourceEnv } from './index.js';
import { normalizeLang } from './lang.js';

const DEFAULT_ORIGIN = 'https://greyboxtv.duckdns.org';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_ROWS = 40;
/**
 * The first call for a cold title was MEASURED at 7.4s (movie/550, 64 KB); a
 * warm one at 245 ms and another at 2991 ms. This lane assembles a 12–21 row
 * payload from several upstreams before it answers, which is exactly why it is
 * declared `aggregator`.
 *
 * 8s, not 8s-by-guess: the previous value was 3800 ms, chosen before reading
 * the timings, and it cut the lane off at half its own measured response time —
 * which reads in the log as "TimeoutError", i.e. exactly like a dead source.
 * A timeout that is shorter than the measured answer turns a slow lane into a
 * lie.
 */
const PROVIDER_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 512_000;
/** 429 means "ask again", not "no streams". One backoff inside the deadline. */
const THROTTLE_BACKOFF_MS = 900;

/**
 * A relay/proxy front in front of somebody else's media.
 *
 * Deliberately narrow: greybox's own `/api/media` proxy is not one of these.
 * The pattern covers the URL-worker fronting that produced the 502s — a
 * `*.workers.dev` host, or a `/resource/` or `/dash/` path on a worker domain.
 */
const RELAY_HOST = /(?:^|\.)workers\.dev$|(?:^|\.)workerscloud\d*\.workers\.(?:dev)$/i;

export interface GreyboxOptions {
  origin?: string;
}

interface GreyboxRow {
  provider?: unknown;
  label?: unknown;
  url?: unknown;
  type?: unknown;
  quality?: unknown;
  height?: unknown;
  language?: unknown;
  audio?: unknown;
  subtitles?: unknown;
  intro?: { start?: unknown; end?: unknown };
  credits?: { start?: unknown; end?: unknown };
}

/** The quality a row advertises, from its height first and its label second. */
export function rowQuality(rawQuality: unknown, rawHeight: unknown): string {
  const height = Number(rawHeight);
  if (Number.isFinite(height) && height >= 200 && height <= 4320) {
    if (height >= 2160) return '2160p';
    if (height >= 1080) return '1080p';
    if (height >= 720) return '720p';
    if (height >= 480) return '480p';
    if (height >= 360) return '360p';
  }
  const match = String(rawQuality ?? '').match(/(\d{3,4})/);
  if (!match) return 'auto';
  const value = Number(match[1]);
  if (value >= 2160) return '2160p';
  if (value >= 1080) return '1080p';
  if (value >= 720) return '720p';
  if (value >= 480) return '480p';
  if (value >= 360) return '360p';
  return 'auto';
}

/**
 * A row's audio language.
 *
 * Real payloads carry qualifiers — `en-2`, `ar-3` meaning "the second English
 * track" — plus junk such as `und` or `x7`. The bare subtag is the useful part;
 * the junk must become nothing rather than a bogus language filter.
 */
export function rowLanguage(raw: unknown): string | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'und' || value === 'x' || /^x\d+$/.test(value)) return null;
  const base = value.split('-')[0];
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  if (base === 'und') return null;
  return normalizeLang(base).code ?? null;
}

/**
 * Resolve a row URL against the API origin.
 *
 * Root-relative `/api/media?u=...` rows are the provider's own proxy and the
 * majority of the payload. They are resolved, never discarded — that single
 * mistake is what made this lane look dead.
 */
export function absolveRowUrl(raw: unknown, origin: string): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : value.startsWith('/') ? `${origin}${value}` : `${origin}/${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (RELAY_HOST.test(url.hostname)) return null;
  return url.href;
}

/** Greybox serves HLS from `/api/media` with no extension at all. */
export function rowType(raw: unknown, url: string): 'hls' | 'dash' | 'mp4' | null {
  const declared = String(raw ?? '').toLowerCase();
  if (declared === 'dash' || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (declared === 'mp4' || /\.mp4(?:[?#]|$)/i.test(url)) return 'mp4';
  if (declared === 'hls' || /hls|m3u8/i.test(declared)) return 'hls';
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  // `/api/media?u=` rows carry no extension and were measured as HLS.
  return 'hls';
}

function subtitleTracks(row: GreyboxRow, origin: string, headers: Record<string, string>): RawTrackRef[] {
  if (!Array.isArray(row.subtitles)) return [];
  const tracks: RawTrackRef[] = [];
  const seen = new Set<string>();
  for (const raw of row.subtitles as { url?: unknown; language?: unknown; label?: unknown; format?: unknown }[]) {
    const url = absolveRowUrl(raw?.url, origin);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const lang = rowLanguage(raw?.language) ?? 'und';
    const format = String(raw?.format ?? '').toLowerCase();
    tracks.push({
      lang,
      label: typeof raw?.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 60) : lang.toUpperCase(),
      url,
      ...(format === 'vtt' || format === 'srt' || format === 'ass' ? { format } : {}),
      headers,
    });
  }
  return tracks;
}

/**
 * Parse the payload into candidates.
 *
 * Rows are de-duplicated by URL. The provider's own priority is kept as the
 * candidate rank, so ties inside one size class still resolve in the order the
 * provider meant.
 */
export function greyboxCandidates(body: unknown, origin = DEFAULT_ORIGIN): {
  candidates: RawStreamCandidate[];
  segments: SkipSegments;
  languages: string[];
} {
  const empty = { candidates: [], segments: {}, languages: [] };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return empty;
  const rows = (body as { sources?: unknown }).sources;
  if (!Array.isArray(rows)) return empty;

  const headers = { 'User-Agent': UA, Referer: `${origin}/`, Origin: origin };
  const languages = new Set<string>();
  const segments: SkipSegments = {};
  const seen = new Set<string>();
  const candidates: RawStreamCandidate[] = [];

  for (const raw of rows.slice(0, MAX_ROWS) as GreyboxRow[]) {
    if (!raw || typeof raw !== 'object') continue;
    const url = absolveRowUrl(raw.url, origin);
    if (!url || seen.has(url)) continue;
    const type = rowType(raw.type, url);
    if (!type) continue;

    const lang = rowLanguage(raw.language);
    // Every language the payload declares, for the response's language set. This
    // is separate from the row's own language: a multi-audio row still tells us
    // which languages exist on the title.
    if (lang) languages.add(lang);
    if (Array.isArray(raw.audio)) {
      for (const track of raw.audio) {
        const code = rowLanguage(typeof track === 'string' ? track : (track as { language?: unknown })?.language);
        if (code) languages.add(code);
      }
    }
    // A row with no readable language is not offered: it could win a
    // language-filtered race by accident and then play the wrong audio.
    if (!lang) continue;

    seen.add(url);
    const height = Number(raw.height);
    const quality = rowQuality(raw.quality, raw.height);
    const tracks = subtitleTracks(raw, origin, headers);

    // Intro/credits markers are the provider's, and they belong to the first row
    // that carries them rather than being merged across rows.
    if (!segments.intro && raw.intro && Number.isFinite(Number(raw.intro.start)) && Number.isFinite(Number(raw.intro.end))) {
      segments.intro = [Number(raw.intro.start), Number(raw.intro.end)];
    }
    if (!segments.outro && raw.credits && Number.isFinite(Number(raw.credits.start)) && Number.isFinite(Number(raw.credits.end))) {
      segments.outro = [Number(raw.credits.start), Number(raw.credits.end)];
    }

    candidates.push({
      key: url,
      // The fingerprint decides whether two rows are "the same stream" for the
      // client's dedupe. Two different providers on the same title are not the
      // same stream even at the same height, so the provider is part of it.
      fingerprint: `${String(raw.provider ?? 'greybox')}:${url}`,
      url,
      type,
      quality,
      ...(Number.isFinite(height) && height >= 200 ? { qualityLadder: [height], qualityOptions: 1 } : {}),
      claimedAudioLang: lang,
      ...(languages.size ? { availableAudioLangs: [...languages] } : {}),
      ...(tracks.length ? { subtitles: tracks } : {}),
      headers,
      rank: candidates.length,
    });
    if (candidates.length >= MAX_ROWS) break;
  }

  return { candidates, segments, languages: [...languages] };
}

async function readJson(response: Response, max: number): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** The API URL for one title. */
export function greyboxUrl(
  query: Pick<SourceQuery, 'type' | 'tmdbId' | 'season' | 'episode'>,
  origin = DEFAULT_ORIGIN,
): string | null {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return null;
  const url = new URL(`${origin.replace(/\/+$/, '')}/api/player/sources`);
  url.searchParams.set('media', query.type);
  url.searchParams.set('id', query.tmdbId);
  if (query.type === 'tv') {
    url.searchParams.set('season', String(query.season ?? 1));
    url.searchParams.set('episode', String(query.episode ?? 1));
  }
  return url.href;
}

export function createGreyboxAdapter(options: GreyboxOptions = {}): SourceAdapter {
  const env = sourceEnv();
  const origin = (options.origin ?? env.ELFURA_GREYBOX_ORIGIN?.trim() ?? DEFAULT_ORIGIN).replace(/\/+$/, '');

  return {
    id: 'source-2',
    label: 'Source 2',
    // It fronts several upstreams by design; a manual pick should exhaust its
    // own servers before the player switches groups.
    traits: ['aggregator'],
    discoveryTimeoutMs: PROVIDER_TIMEOUT_MS,
    enabled: () => (env.ELFURA_GREYBOX_ENABLED ?? '1') !== '0',

    async resolve(query: SourceQuery) {
      const url = greyboxUrl(query, origin);
      if (!url) return { candidates: [] };

      // The registry hands a lane that declares `aggregator` a signal sized by
      // `discoveryTimeoutMs`. Composing our own shorter deadline on top of it is
      // what made a measured 7.4s lane report TimeoutError, so the caller's
      // signal IS the budget here; the local timer exists only for the case
      // where no caller signal was supplied at all.
      const signal = query.signal ?? AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      const headers = {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `${origin}/`,
        Origin: origin,
      };

      const ask = async (): Promise<{ status: number; body: unknown } | null> => {
        let response: Response;
        try {
          response = await fetch(url, { headers, signal });
        } catch (error) {
          // A timeout is "nothing came back", which the caller may retry once.
          // Anything else — a reset, a refused connection — is final.
          if ((error as Error)?.name === 'TimeoutError' || signal.aborted) return null;
          throw error;
        }
        if (response.status === 429) {
          await response.body?.cancel().catch(() => {});
          return { status: 429, body: null };
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { status: response.status, body: null };
        }
        return { status: response.status, body: await readJson(response, MAX_BODY_BYTES) };
      };

      try {
        let answer = await ask();
        // One retry for a cold timeout: the first call for a title is the one
        // that assembles everything (7.4s measured), and a second attempt
        // usually lands inside the leash. Only when NOTHING came back — a real
        // answer, even an error, is never re-asked.
        if (answer === null && !signal.aborted) {
          console.warn(`[elfura-greybox] ${query.type}/${query.tmdbId}: cold timeout, asking once more`);
          answer = await ask();
        }
        if (answer?.status === 429) {
          // A throttle is not a dead lane. One backoff without the raw 429
          // reaching the caller, and say so, because a silent retry hides a
          // source that is rate-limiting the whole board.
          console.warn(`[elfura-greybox] ${query.type}/${query.tmdbId}: throttled, retrying once`);
          await new Promise((resolve) => setTimeout(resolve, THROTTLE_BACKOFF_MS));
          if (signal.aborted) return { candidates: [] };
          answer = await ask();
        }
        if (!answer) {
          console.warn(`[elfura-greybox] ${query.type}/${query.tmdbId}: timed out after two attempts`);
          return { candidates: [] };
        }
        if (answer.status !== 200) {
          if (answer?.status === 429) {
            console.warn(`[elfura-greybox] ${query.type}/${query.tmdbId}: still throttled after one retry`);
          } else if (answer) {
            console.warn(`[elfura-greybox] ${query.type}/${query.tmdbId}: http=${answer.status}`);
          }
          return { candidates: [] };
        }

        const parsed = greyboxCandidates(answer.body, origin);
        if (parsed.candidates.length) {
          console.log(
            `[elfura-greybox] ${query.type}/${query.tmdbId}: ${parsed.candidates.length} row(s), ` +
              `langs=${parsed.languages.length}`,
          );
        } else {
          console.warn(`[elfura-greybox] ${query.type}/${query.tmdbId}: answered with no usable row`);
        }
        return {
          candidates: parsed.candidates,
          ...(Object.keys(parsed.segments).length ? { segments: parsed.segments } : {}),
        };
      } catch (error) {
        const reason = (error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.name ?? 'error';
        console.warn(`[elfura-greybox] ${query.type}/${query.tmdbId}: ${reason}`);
        return { candidates: [] };
      }
    },
  };
}
