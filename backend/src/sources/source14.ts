/**
 * RiveStream server lanes (Source 14).
 *
 * RiveStream's own backends are served through one AES-bridged source API keyed
 * by TMDB id. Each backend ("citadel", "primevids", "flowcast", …) publishes its
 * own CDN and its own label vocabulary, so every backend is asked separately and
 * the rows are merged:
 *
 *   - `citadel`  signed HLS on `img*.(hscow|fcxmb).com`; the label carries the
 *                audio language ("720p | Hindi"), verified against the manifest
 *                by the shared liveness probe like any other claim.
 *   - `primevids` HLS on `cdn*.slowcloud.live`; labels carry no language, so no
 *                audio claim is made for those rows.
 *   - `flowcast`  MP4 behind a public CORS proxy — rejected: that is somebody
 *                else's relay, not the provider's CDN.
 *   - `quasar` / `guru` / `hindicast` are asked too; they answer only from some
 *                regions (an India-hosted box sees more of them than a US runner),
 *                and a silent lane simply contributes nothing.
 *
 * Captions are ignored: this adapter only adds playable video lanes.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import { candidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { classifyUpstreamUrl, RELAY_RANK_PENALTY } from './provenance.js';
import type { RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://scrapper.rivestream.app/api/provider';
const ORIGIN = 'https://www.rivestream.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
// Measured live against scrapper.rivestream.app: citadel answers in ~200 ms but
// flowcast (which returns three playable MP4 renditions plus a full caption set
// for tmdb 550) needs well over a second to assemble its payload. At 1100 ms it
// was recorded as `timeout` on every resolve, so a working backend was reported
// dead and its rows were lost. 2600 ms stays inside the registry's ~2.7 s
// early-release window while giving the slow backends room to answer.
const PROVIDER_TIMEOUT_MS = 2600;
const MAX_ROWS = 40;
const MAX_CANDIDATES = 16;
const MAX_PROVIDER_JSON_BYTES = 384_000;

/** Provider keys as the source API expects them (no `rive-` prefix). */
export const RIVE_PROVIDERS = ['citadel', 'primevids', 'flowcast', 'quasar', 'guru', 'hindicast'] as const;
export type RiveProvider = (typeof RIVE_PROVIDERS)[number];

/** Citadel's signed CDN hosts; other providers publish unsigned URLs on their own CDNs. */
const CITADEL_HOST = /^img\d*\.(?:hscow|fcxmb)\.com$/i;
const EMBED_PATTERN = /embed|vidara/i;
const LANGUAGE_LABEL = /\b(hindi|english|tamil|telugu|malayalam|kannada|bengali|marathi|punjabi|urdu|gujarati|japanese|korean|spanish|french|german|arabic|portuguese|russian|italian|chinese|thai|indonesian|turkish|dutch|polish)\b/i;

async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > maxBytes) {
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
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

interface ParsedRow extends RawStreamCandidate {
  identity: string;
  lang: string;
}

/** Audio language named by a label, ignoring subtitle/multi-audio wording. */
function labelLanguage(value: string): { code: string; label: string } | null {
  const raw = String(value ?? '');
  if (/subtitle|caption|sub\b|multi|dual|commentary/i.test(raw)) return null;
  const match = raw.match(LANGUAGE_LABEL);
  if (!match) return null;
  const language = normalizeLang(match[1]);
  if (!language.code || language.code === 'und') return null;
  return { code: language.code, label: language.label };
}

function qualityText(value: unknown): string {
  const match = String(value ?? '').match(/\b(2160|1440|1080|720|540|480|360)p\b/i);
  if (match) return `${match[1]}p`;
  const bare = String(value ?? '').trim().match(/^(2160|1440|1080|720|540|480|360)$/);
  return bare ? `${bare[1]}p` : 'auto';
}

/** Parse one source row from any Rive provider. */
export function parseRiveRow(row: unknown, provider: string, rank: number): ParsedRow | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const item = row as {
    url?: unknown;
    quality?: unknown;
    label?: unknown;
    language?: unknown;
    format?: unknown;
    source?: unknown;
    isEmbed?: unknown;
  };
  if (typeof item.url !== 'string' || item.url.length > 8192) return null;
  const format = typeof item.format === 'string' ? item.format.trim().toLowerCase() : '';
  if (format !== 'hls' && format !== 'mp4') return null;
  if (item.isEmbed === true) return null;

  let url: URL;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!isSafeUpstreamUrl(url.href) || EMBED_PATTERN.test(url.href)) return null;
  // A relay/proxy front is somebody else's bandwidth: never promote it as a lane.
  if (classifyUpstreamUrl(url.href) === 'relay') return null;

  if (provider === 'citadel') {
    // Citadel rows must be signed CDN URLs; anything else is a different shape.
    if (!CITADEL_HOST.test(url.hostname)) return null;
    // `/hls/` is the direct rendition; `/hls_mps/` and `/myhls_mps/` are the
    // remuxed ones. The pattern used to require `hls_mps`, so every direct `/hls/`
    // row was silently discarded — and in the live payload that is the 720p
    // rendition, i.e. the best quality citadel publishes. Verified against
    // /api/provider?provider=citadel&id=550, which returns
    //   /hls/78164859/720/index_287.m3u8        (720p, was rejected)
    //   /hls_mps/78164859/480/index_287.m3u8    (480p, was accepted)
    if (!/^\/(?:my)?(?:hls|hls_mps)\/.+\/index_[a-z0-9_-]+\.m3u8$/i.test(url.pathname)) return null;
    const expiry = Number(url.searchParams.get('Expires'));
    const signature = url.searchParams.get('Signature') || '';
    if (!Number.isSafeInteger(expiry) || expiry * 1000 <= Date.now() + 15_000) return null;
    if (url.searchParams.get('KeyName') !== 'Signature') return null;
    if (!/^[A-Za-z0-9_+=/-]{20,256}$/.test(signature)) return null;
    if (format !== 'hls') return null;
  } else if (format === 'hls' && !/\.m3u8(?:[?#]|$)/i.test(url.pathname)) {
    return null;
  }

  const labelText = [item.language, item.quality, item.label]
    .filter((value): value is string => typeof value === 'string')
    .join(' | ')
    .slice(0, 200);
  const language = labelLanguage(labelText);
  if (provider === 'citadel' && !language) return null; // citadel rows always name their audio
  const quality = qualityText(item.quality ?? item.label);
  const identity = url.pathname.replace(/\/index_[a-z0-9_-]+\.m3u8$/i, '/index.m3u8');

  return {
    key: `${url.origin}${identity}:${language?.code ?? 'und'}`,
    fingerprint: `${identity}:${language?.code ?? 'und'}:${quality}`,
    url: url.href,
    type: format,
    quality,
    ...(language
      ? {
          claimedAudioLang: language.code,
          audioLabel: `${language.label} · ${provider.charAt(0).toUpperCase()}${provider.slice(1)} label (unverified)`,
        }
      : {}),
    headers: { 'User-Agent': UA, Referer: `${ORIGIN}/`, Origin: ORIGIN },
    rank: rank + (provider === 'citadel' ? 0 : 10),
    identity,
    lang: language?.code ?? 'und',
  };
}

/** Merge parsed rows: one candidate per URL, conflicting mirror labels dropped. */
function mergeRows(parsed: ParsedRow[]): RawStreamCandidate[] {
  const langsByIdentity = new Map<string, Set<string>>();
  for (const candidate of parsed) {
    if (candidate.lang === 'und') continue;
    const langs = langsByIdentity.get(candidate.identity) ?? new Set<string>();
    langs.add(candidate.lang);
    langsByIdentity.set(candidate.identity, langs);
  }
  const seen = new Set<string>();
  const kept: ParsedRow[] = [];
  for (const candidate of parsed) {
    if ((langsByIdentity.get(candidate.identity)?.size ?? 0) > 1) continue;
    const key = `${candidate.url}:${candidate.lang}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(candidate);
  }
  kept.sort((a, b) => a.rank - b.rank);
  return kept.slice(0, MAX_CANDIDATES).map(({ identity: _identity, lang: _lang, ...candidate }) => candidate);
}

/** Citadel-only parsing (kept as the documented, unit-tested entry point). */
export function citadelCandidates(body: unknown): RawStreamCandidate[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const sources = (data as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  const parsed = sources
    .slice(0, MAX_ROWS)
    .flatMap((row, index) => {
      const candidate = parseRiveRow(row, 'citadel', 20 + index);
      return candidate ? [candidate] : [];
    });
  return mergeRows(parsed);
}

/** Every provider's rows for one title, merged and de-duplicated. */
export function riveCandidatesByProvider(bodies: Record<string, unknown>): RawStreamCandidate[] {
  const parsed: ParsedRow[] = [];
  for (const [provider, body] of Object.entries(bodies)) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    const data = (body as { data?: unknown }).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const sources = (data as { sources?: unknown }).sources;
    if (!Array.isArray(sources)) continue;
    sources.slice(0, MAX_ROWS).forEach((row, index) => {
      const candidate = parseRiveRow(row, provider, 20 + index + (provider === 'citadel' ? 0 : 5));
      if (candidate) parsed.push(candidate);
    });
  }
  return mergeRows(parsed);
}

/**
 * Captions published alongside a provider's streams.
 *
 * citadel publishes 26 tracks for tmdb 550 and flowcast a comparable set, in the
 * same payload as the video rows. Until now this adapter read `data.sources` and
 * ignored `data.captions` entirely, so a title arrived with a working stream and
 * no subtitles while the backend had already sent two dozen languages.
 *
 * Labels are provider-formatted ("हिन्दी - FlowCast", "Germany - Citadel"), so the
 * provider suffix is stripped and the remainder is normalised as a language.
 */
export function captionsByProvider(bodies: Record<string, unknown>): RawTrackRef[] {
  const out: RawTrackRef[] = [];
  const seen = new Set<string>();
  for (const body of Object.values(bodies)) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    const data = (body as { data?: unknown }).data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const captions = (data as { captions?: unknown }).captions;
    if (!Array.isArray(captions)) continue;
    for (const raw of captions.slice(0, 64)) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as { file?: unknown; label?: unknown; language?: unknown; type?: unknown };
      if (typeof row.file !== 'string' || !isSafeUpstreamUrl(row.file)) continue;
      if (row.file.length > 2048) continue;
      const format = String(row.type ?? '').toLowerCase();
      if (format && format !== 'vtt' && format !== 'srt') continue;
      // Drop the provider suffix before reading the language out of the label.
      const rawLabel = typeof row.label === 'string' ? row.label : '';
      const label = rawLabel.replace(/\s*[-–—]\s*[A-Za-z0-9_.]+\s*$/, '').trim().slice(0, 60);
      const declared = typeof row.language === 'string' ? row.language : '';
      const audio = normalizeLang(label) ?? normalizeLang(declared);
      const lang = audio && audio.code !== 'und' ? audio.code : 'und';
      const url = row.file;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        lang,
        label: label || declared || lang,
        url,
        format: format === 'srt' ? 'srt' : 'vtt',
      });
      if (out.length >= 48) return out;
    }
  }
  return out;
}

/** Ask every provider for this title in parallel. */
export async function fetchFromCitadel(query: SourceQuery, trace?: string[]): Promise<RawStreamCandidate[]> {
  return (await fetchProviders(query, trace)).candidates;
}

/**
 * Fetch every provider once, returning both its playable rows and its captions.
 *
 * Kept as a single pass on purpose: the captions arrive in the same response as
 * the rows, so splitting this into two functions would either duplicate the
 * upstream requests or require caching the bodies, and neither is worth it for
 * data that is already in hand.
 */
export async function fetchProviders(
  query: SourceQuery,
  trace?: string[],
): Promise<{ candidates: RawStreamCandidate[]; subtitles: RawTrackRef[] }> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie', 'tv'].includes(query.type)) {
    return { candidates: [], subtitles: [] };
  }
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) {
    return { candidates: [], subtitles: [] };
  }
  // Each provider gets its own short leash: the registry only waits ~2.7 s for
  // adapters, so a region-gated backend that never answers must not hold the
  // whole lane (and the sources around it) hostage.
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(PROVIDER_TIMEOUT_MS)])
    : AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
  const bucket = Math.floor(Date.now() / 3_000_000);

  const results = await Promise.all(
    RIVE_PROVIDERS.map(async (provider) => {
      const endpoint = new URL(API);
      endpoint.searchParams.set('provider', provider);
      endpoint.searchParams.set('id', query.tmdbId);
      if (query.type === 'tv') {
        endpoint.searchParams.set('season', String(season));
        endpoint.searchParams.set('episode', String(episode));
      }
      endpoint.searchParams.set('cb', String(bucket));
      try {
        const response = await fetch(endpoint, {
          headers: { 'User-Agent': UA, Referer: `${ORIGIN}/`, Origin: ORIGIN, Accept: 'application/json' },
          redirect: 'manual',
          signal,
        });
        const body = await readJsonBounded(response, MAX_PROVIDER_JSON_BYTES);
        const count = Array.isArray((body as { data?: { sources?: unknown } })?.data?.sources)
          ? ((body as { data: { sources: unknown[] } }).data.sources.length)
          : 0;
        // Four distinct states, previously all rendered as one number:
        //   ok/<n>      answered with n playable rows
        //   empty       answered 200 with data:null (nothing for this title)
        //   http=<code> answered with an error status
        //   timeout     did not answer inside the leash
        //   net=<name>  never got a response
        const empty = body && typeof body === 'object' && !(body as { data?: unknown }).data;
        trace?.push(
          response.ok
            ? empty
              ? `${provider}=empty`
              : `${provider}=ok/${count}`
            : `${provider}=http=${response.status}`,
        );
        return [provider, body] as const;
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        trace?.push(`${provider}=${timedOut ? 'timeout' : `net=${err instanceof Error ? err.name : 'error'}`}`);
        return [provider, null] as const;
      }
    }),
  );

  // Accumulate per provider instead of merging everything into one body map.
  // The old shape made a six-backend lane report as a single "source-14": when
  // three backends timed out and a fourth answered 200 with zero rows, the result
  // was 12 rows with no indication that half the lane was gone. Now each provider
  // contributes its own rows and tags them, so a partial outage is visible in the
  // row set itself and not only in a trace string.
  const out: RawStreamCandidate[] = [];
  for (const [provider, body] of results) {
    if (!body) continue;
    // `data: null` is a real answer: the provider has nothing for this title. It
    // is not a failure, and conflating the two is exactly how a healthy backend
    // got counted as dead.
    if (!(body as { data?: unknown }).data) continue;
    const rows = riveCandidatesByProvider({ [provider]: body });
    for (const candidate of rows) {
      // The backend name already rides in the key/fingerprint from
      // riveCandidatesByProvider, so nothing extra is attached here; what matters
      // is that each backend contributes separately instead of being merged.
      out.push({
        ...candidate,
        rank: candidate.rank + (classifyUpstreamUrl(candidate.url) === 'relay' ? RELAY_RANK_PENALTY : 0),
      });
    }
  }
  // Deduplicate by URL, not by fingerprint. The fingerprint includes the caption
  // set, which differs per backend, so two backends serving literally the same
  // master produced two fingerprints and both were listed. The URL is the thing
  // the player actually loads, so it is the thing that must be unique.
  const seen = new Set<string>();
  const unique = out.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });

  // Captions come from the responses we already have. No extra request.
  const captionBodies: Record<string, unknown> = {};
  for (const [provider, body] of results) {
    if (body && typeof body === 'object' && (body as { data?: unknown }).data) {
      captionBodies[provider] = body;
    }
  }
  const subtitles = captionsByProvider(captionBodies);
  if (subtitles.length) trace?.push(`captions=${subtitles.length}`);

  return { candidates: unique, subtitles };
}

export function createSource14Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-14',
    label: 'Source 14',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const trace: string[] = [];
      const fetched = await fetchProviders(query, trace);
      const checked = await verifyAndFilterCandidatesDetailed(fetched.candidates, query.signal);
      const alive = checked.candidates.filter((candidate) => !!candidateEvidenceAlive(candidate));
      // Attach the provider's own captions to its rows. These are already
      // correctly labelled per language by the backend, so they beat anything we
      // would infer, and they cost nothing extra.
      const candidates = fetched.subtitles.length
        ? alive.map((candidate) => ({
            ...candidate,
            subtitles: [...(candidate.subtitles ?? []), ...fetched.subtitles],
          }))
        : alive;
      query.diag?.push({
        adapter: 'source-14',
        lane: 'C',
        ok: candidates.length > 0,
        ms: Date.now() - started,
        detail:
          `rows=${fetched.candidates.length},manifestReachable=${candidates.length} ` +
          // Count backends that actually answered with rows, not by scraping the
          // trace for a status code that is no longer formatted the same way.
          `backends=${trace.filter((t) => /=(?:ok\/|empty)/.test(t)).length}/${RIVE_PROVIDERS.length} ` +
          `captions=${fetched.subtitles.length} ` +
          trace.join(' ').trim(),
      });
      return {
        candidates: candidates.map((candidate) => (query.diag ? { ...candidate, diagnosticLane: 'C' } : candidate)),
      };
    },
  };
}

function candidateEvidenceAlive(candidate: RawStreamCandidate): boolean {
  return !!candidateEvidence(candidate)?.alive;
}
