/** Experimental direct VidZee HLS discovery. Only manifest-proven
 * multilingual streams and reachable language-labelled dubs leave this adapter. No subtitle or embed proxy. */
import { normalizeLang } from './lang.js';
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://core.vidzee.wtf';
const PLAYER = 'https://player.vidzee.wtf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const SERVERS = ['dcloud', 'tik', 'ipcloud', 'v6:Hindi'] as const;

function safeHeaders(value: unknown): Record<string, string> {
  const result: Record<string, string> = { 'User-Agent': UA, Referer: PLAYER + '/' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string' || raw.length > 2048 || /[\r\n]/.test(raw)) continue;
    if (!/^(referer|origin|user-agent)$/i.test(key)) continue;
    if (/^(referer|origin)$/i.test(key) && !isSafeUpstreamUrl(raw)) continue;
    result[/^referer$/i.test(key) ? 'Referer' : /^origin$/i.test(key) ? 'Origin' : 'User-Agent'] = raw;
  }
  return result;
}

async function readJsonBounded(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > 128_000) {
    await response.body?.cancel(); return null;
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 128_000) throw new Error('oversized response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchFromVidZee(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie', 'tv'].includes(query.type)) return [];
  const season = query.season ?? 1, episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) return [];
  const path = query.type === 'movie' ? `/streams/movie/${query.tmdbId}` : `/streams/tv/${query.tmdbId}/${season}/${episode}`;
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3500)]) : AbortSignal.timeout(3500);
  const results = await Promise.all(SERVERS.map(async server => {
    try {
      const url = new URL(API + path); url.searchParams.set('s', server); url.searchParams.set('e', '0');
      const response = await fetch(url, { redirect: 'error', headers: { 'User-Agent': UA, Referer: PLAYER + '/', Origin: PLAYER, Accept: 'application/json' }, signal });
      const data = await readJsonBounded(response);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      const row = data as { url?: unknown; headers?: unknown; language?: unknown };
      if (typeof row.url !== 'string' || !isSafeUpstreamUrl(row.url) || !/\.m3u8(?:[?#]|$)/i.test(row.url) || /vidara/i.test(row.url)) return null;
      const rawLang = typeof row.language === 'string' ? row.language.trim() : '';
      const lang = !/sub|caption|multi|dual/i.test(rawLang) ? normalizeLang(rawLang) : normalizeLang('und');
      return { key: row.url, url: row.url, type: 'hls', quality: 'auto', rank: 20, headers: safeHeaders(row.headers), ...(lang.code !== 'und' ? { audioLang: lang.code, audioLabel: lang.label } : {}) } satisfies RawStreamCandidate;
    } catch { return null; }
  }));
  const unique = new Map<string, RawStreamCandidate>();
  for (const candidate of results) if (candidate && !unique.has(candidate.url)) unique.set(candidate.url, candidate);
  return [...unique.values()];
}

export function createSource8Adapter(enabled: () => boolean): SourceAdapter {
  return { id: 'source-8', label: 'Source 8', enabled, async resolve(query) {
    const start = Date.now();
    const raw = await fetchFromVidZee(query);
    const verified = await verifyAndFilterCandidatesDetailed(raw, query.signal);
    const usable = verified.candidates.filter(c => {
      const evidence = cachedCandidateEvidence(c);
      return !!evidence?.alive && (new Set(evidence.discoveredAudioLangs ?? []).size > 1 || !!c.audioLang && c.audioLang !== 'und');
    });
    query.diag?.push({ adapter: 'source-8', lane: 'Z', ok: usable.length > 0, ms: Date.now() - start, detail: `candidates=${raw.length},usable=${usable.length}` });
    return { candidates: usable.map(c => query.diag ? { ...c, diagnosticLane: 'Z' } : c) };
  } };
}
