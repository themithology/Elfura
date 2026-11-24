/**
 * Source 1 — the citadel lane.
 *
 * One provider, one API, one shape. The retired Source 14 asked six backends and
 * merged them; this asks one, because the measurements were unambiguous: citadel
 * was the only lane that produced playable bytes on both research runs, 4/4
 * titles, with a first call around 1 s and real segments at ~250 ms.
 *
 *   GET https://scrapper.rivestream.app/api/provider?provider=citadel&id=<tmdb>
 *     → JSON: data.sources[].{url,quality,label,language,format,isEmbed}
 *     → signed HLS on img*.hscow.com / img*.fcxmb.com
 *
 * What this adapter does NOT do, and why:
 *   - It does not trust the row's `quality` label. The liveness probe reads the
 *     real playlist, and the size measurement counts real bytes; the ranking
 *     then prefers the bigger stream. Labels were wrong on the old board, and a
 *     viewer notices a wrong size long before they notice a wrong badge.
 *   - It does not keep a row whose signature has expired. A citadel URL carries
 *     `Expires`; handing the player a dead signature looks exactly like a dead
 *     source.
 *   - It does not accept a row on any host but citadel's own CDN. A relay front
 *     is someone else's bandwidth, and on this board that is a different lane's
 *     business at best.
 */
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';
import { sourceEnv } from './index.js';
import { normalizeLang } from './lang.js';

const DEFAULT_API = 'https://scrapper.rivestream.app/api/provider';
const DEFAULT_REFERER = 'https://www.rivestream.app/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** Citadel's signed CDN. Anything else is a different lane's row. */
const CITADEL_HOST = /^img\d*\.(?:hscow|fcxmb)\.com$/i;
const CITADEL_PATH = /^\/(?:my)?(?:hls|hls_mps)\/.+\/index_[a-z0-9_-]+\.m3u8$/i;

/** Every audio language citadel has been observed to label a row with. */
const LANGUAGE_WORD =
  /\b(hindi|english|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi|urdu|gujarati|japanese|korean|spanish|french|german|arabic|portuguese|russian|italian|chinese|thai|indonesian|turkish|dutch|polish)\b/i;

const MAX_ROWS = 40;
const MAX_CANDIDATES = 16;
const MAX_BODY_BYTES = 384_000;
/** The API assembles its payload; 1037 ms was measured on a runner. */
const PROVIDER_TIMEOUT_MS = 4000;

export interface CitadelOptions {
  /** Override for operators and for the contract test. */
  apiBase?: string;
  referer?: string;
}

interface ParsedRow {
  /** URL without the per-rendition `index_*.m3u8`, so mirrors collapse. */
  identity: string;
  lang: string;
  candidate: RawStreamCandidate;
}

/** The audio language a row names, ignoring subtitle and multi-audio wording. */
export function rowLanguage(value: string): { code: string; label: string } | null {
  const raw = String(value ?? '');
  if (/subtitle|caption|\bsub\b|multi|dual|commentary/i.test(raw)) return null;
  const match = raw.match(LANGUAGE_WORD);
  if (!match) return null;
  const language = normalizeLang(match[1]);
  if (!language.code || language.code === 'und') return null;
  return { code: language.code, label: language.label };
}

/**
 * Parse one API row into a candidate, or reject it.
 *
 * Rejection is the common case: a row arrives with an expired signature, an
 * embed URL, a host that is not citadel's CDN, or no language label at all. Every
 * one of those would become a stream the viewer cannot play.
 */
export function parseCitadelRow(row: unknown, rank: number, now = Date.now()): ParsedRow | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const item = row as {
    url?: unknown;
    quality?: unknown;
    label?: unknown;
    language?: unknown;
    format?: unknown;
    isEmbed?: unknown;
  };
  if (typeof item.url !== 'string' || item.url.length > 8192) return null;
  const format = typeof item.format === 'string' ? item.format.trim().toLowerCase() : '';
  if (format !== 'hls') return null;
  if (item.isEmbed === true) return null;

  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!CITADEL_HOST.test(url.hostname)) return null;
  if (!CITADEL_PATH.test(url.pathname)) return null;

  // The signature is the difference between a stream and a 403.
  const expires = Number(url.searchParams.get('Expires'));
  const signature = url.searchParams.get('Signature') ?? '';
  if (!Number.isSafeInteger(expires)) return null;
  if (expires * 1000 <= now + 15_000) return null;
  if (url.searchParams.get('KeyName') !== 'Signature') return null;
  if (!/^[A-Za-z0-9_+=/-]{20,256}$/.test(signature)) return null;

  const language = rowLanguage([item.language, item.quality, item.label].filter((v) => typeof v === 'string').join(' | '));
  // A citadel row always names its audio; one that does not would be listed with
  // no language and could win a language-filtered race by accident.
  if (!language) return null;

  const qualityMatch = String(item.quality ?? item.label ?? '').match(/\b(2160|1440|1080|720|540|480|360)p\b/i);
  const quality = qualityMatch ? `${qualityMatch[1]}p` : 'auto';
  const stem = url.pathname.replace(/\/index_[a-z0-9_-]+\.m3u8$/i, '/index.m3u8');

  return {
    identity: `${url.origin}${stem}`,
    lang: language.code,
    candidate: {
      // The query is dropped from the key: two rows for the same rendition differ
      // only by signature, and those are the same stream.
      key: `${url.origin}${stem}:${language.code}`,
      fingerprint: `${stem}:${language.code}:${quality}`,
      url: url.href,
      type: 'hls',
      quality,
      claimedAudioLang: language.code,
      // Explicitly a provider label, not a manifest measurement. The liveness
      // probe replaces this with what the playlist actually carries.
      audioLabel: language.label,
      headers: { 'User-Agent': UA, Referer: DEFAULT_REFERER, Origin: DEFAULT_REFERER.replace(/\/$/, '') },
      rank: rank,
    },
  };
}

/**
 * Pick the candidates out of the API payload.
 *
 * Two mirrors of the same rendition that disagree about audio are dropped: one of
 * them is mislabelled and there is no way to tell which, so neither is offered
 * as that language. This is the rule the old adapter earned the hard way.
 */
export function citadelCandidates(body: unknown, now = Date.now()): RawStreamCandidate[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const rows = (data as { sources?: unknown }).sources;
  if (!Array.isArray(rows)) return [];

  const parsed = rows
    .slice(0, MAX_ROWS)
    .flatMap((row, index) => {
      const candidate = parseCitadelRow(row, index, now);
      return candidate ? [candidate] : [];
    });
  if (parsed.length === 0) return [];

  const langsByRendition = new Map<string, Set<string>>();
  for (const row of parsed) {
    const langs = langsByRendition.get(row.identity) ?? new Set<string>();
    langs.add(row.lang);
    langsByRendition.set(row.identity, langs);
  }

  const seen = new Set<string>();
  const kept: RawStreamCandidate[] = [];
  for (const row of parsed) {
    if ((langsByRendition.get(row.identity)?.size ?? 0) > 1) continue;
    if (seen.has(row.candidate.key)) continue;
    seen.add(row.candidate.key);
    kept.push(row.candidate);
  }
  kept.sort((a, b) => a.rank - b.rank);
  return kept.slice(0, MAX_CANDIDATES);
}

async function readJson(response: Response, max: number): Promise<unknown> {
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
export function citadelUrl(query: Pick<SourceQuery, 'type' | 'tmdbId'>, apiBase = DEFAULT_API): string | null {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return null;
  const url = new URL(apiBase);
  url.searchParams.set('provider', 'citadel');
  url.searchParams.set('id', query.tmdbId);
  if (query.type === 'tv') {
    const season = (query as SourceQuery).season ?? 1;
    const episode = (query as SourceQuery).episode ?? 1;
    url.searchParams.set('season', String(season));
    url.searchParams.set('episode', String(episode));
  }
  // Time-bucketed cache buster, as the measured lane used. A CDN-cached empty
  // body must not become "this title has no streams" for the next few minutes.
  url.searchParams.set('cb', String(Math.floor(Date.now() / 3_000_000)));
  return url.href;
}

export function createCitadelAdapter(options: CitadelOptions = {}): SourceAdapter {
  const env = sourceEnv();
  const apiBase = options.apiBase ?? (env.ELFURA_CITADEL_API?.trim() || DEFAULT_API);
  const referer = options.referer ?? DEFAULT_REFERER;

  return {
    id: 'source-1',
    label: 'Source 1',
    traits: [],
    enabled: () => (env.ELFURA_CITADEL_ENABLED ?? '1') !== '0',

    async resolve(query: SourceQuery) {
      const url = citadelUrl(query, apiBase);
      if (!url) return { candidates: [] };
      const signal = query.signal
        ? AbortSignal.any([query.signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)])
        : AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            Referer: referer,
          },
          // `manual`, as measured: a redirect from the provider is an answer we
          // want to see (and refuse), not a network error to swallow.
          redirect: 'manual',
          signal,
        });
        const body = await readJson(response, MAX_BODY_BYTES);
        const candidates = citadelCandidates(body);
        if (candidates.length) {
          console.log(`[elfura-citadel] ${query.type}/${query.tmdbId}: ${candidates.length} row(s)`);
        }
        return { candidates };
      } catch (error) {
        // A timeout is a lane we could not ask, not a lane that has nothing.
        const reason = (error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.name ?? 'error';
        console.warn(`[elfura-citadel] ${query.type}/${query.tmdbId}: ${reason}`);
        return { candidates: [] };
      }
    },
  };
}
