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
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://scrapper.rivestream.app/api/provider';
const ORIGIN = 'https://www.rivestream.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const PROVIDER_TIMEOUT_MS = 1100;
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
    if (!/^\/(?:my)?hls_mps\/.+\/index_[a-z0-9_-]+\.m3u8$/i.test(url.pathname)) return null;
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

/** Ask every provider for this title in parallel. */
export async function fetchFromCitadel(query: SourceQuery, trace?: string[]): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie', 'tv'].includes(query.type)) return [];
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) {
    return [];
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
          redirect: 'error',
          signal,
        });
        const body = await readJsonBounded(response, MAX_PROVIDER_JSON_BYTES);
        const count = Array.isArray((body as { data?: { sources?: unknown } })?.data?.sources)
          ? ((body as { data: { sources: unknown[] } }).data.sources.length)
          : 0;
        trace?.push(`${provider}=${response.status}/${count}`);
        return [provider, body] as const;
      } catch (err) {
        trace?.push(`${provider}=${err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'error'}`);
        return [provider, null] as const;
      }
    }),
  );

  const bodies: Record<string, unknown> = {};
  for (const [provider, body] of results) if (body) bodies[provider] = body;
  return riveCandidatesByProvider(bodies).map((candidate) => ({
    ...candidate,
    rank: candidate.rank + (classifyUpstreamUrl(candidate.url) === 'relay' ? RELAY_RANK_PENALTY : 0),
  }));
}

export function createSource14Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-14',
    label: 'Source 14',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const trace: string[] = [];
      const raw = await fetchFromCitadel(query, trace);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter((candidate) => !!candidateEvidenceAlive(candidate));
      query.diag?.push({
        adapter: 'source-14',
        lane: 'C',
        ok: candidates.length > 0,
        ms: Date.now() - started,
        detail: `rows=${raw.length},manifestReachable=${candidates.length} ${trace.join(' ')}`.trim(),
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
