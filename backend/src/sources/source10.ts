/** VidNest direct media lanes, including MovieBox. Encrypted responses must
 * authenticate before parsing. Embed URLs and third-party relays are rejected. */
import crypto from 'node:crypto';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import { cachedCandidateEvidence, diagnoseCandidatePlayback, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const API = 'https://new.vidnest.fun';
const PLAYER = 'https://vidnest.fun';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
// Public player protocol constant; not a server credential. Can rotate.
const SECRET = 'K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2';
const LANES = ['moviebox','allmovies','nextgencloudfabric','vidzee','vidlink','onehd'] as const;
const HEADERS = { 'User-Agent': UA, Referer: PLAYER + '/', Origin: PLAYER, Accept: 'application/json' };

export function decodeVidNestV2(envelope: unknown, nonce: string): unknown {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid envelope');
  const v = envelope as {v?: unknown; n?: unknown; d?: unknown};
  if (v.v !== 2 || v.n !== nonce || typeof v.d !== 'string' || v.d.length > 1_400_000 || !/^[A-Za-z0-9_-]+$/.test(v.d)) throw new Error('invalid envelope');
  const bytes = Buffer.from(v.d, 'base64url');
  if (bytes.length < 29) throw new Error('short envelope');
  const key = crypto.createHash('sha256').update(`${nonce}|${SECRET}`).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)), decipher.final()]).toString('utf8')) as unknown;
}
async function readJson(res: Response): Promise<unknown> {
  const max = 1_048_576;
  if (!res.ok || !res.body || Number(res.headers.get('content-length') || 0) > max) { await res.body?.cancel(); return null; }
  const reader = res.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('oversized'); chunks.push(value); } return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  finally { await reader.cancel().catch(() => {}); }
}
function object(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function cleanHeaders(input: unknown): Record<string,string> {
  const result: Record<string,string> = { 'User-Agent': UA, Referer: PLAYER + '/', Origin: PLAYER };
  for (const [key, value] of Object.entries(object(input) ?? {})) {
    if (!/^(referer|origin|user-agent)$/i.test(key) || typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value)) continue;
    if (/^(referer|origin)$/i.test(key) && !isSafeUpstreamUrl(value)) continue;
    result[/^referer$/i.test(key) ? 'Referer' : /^origin$/i.test(key) ? 'Origin' : 'User-Agent'] = value;
  }
  return result;
}
function mapPayload(payload: unknown): RawStreamCandidate[] {
  const root = object(payload); if (!root) return [];
  const list: { row: Record<string,unknown>; headers: unknown }[] = [];
  const append = (value: unknown, headers: unknown) => { const row = object(value); if (row && list.length < 30) list.push({row,headers}); };
  if (typeof root.url === 'string') append(root,root.headers);
  for (const key of ['url','streams','sources']) if (Array.isArray(root[key])) for (const row of (root[key] as unknown[]).slice(0,30)) append(row,root.headers);
  const nested = object(object(root.data)?.stream); if (nested?.playlist) append({url:nested.playlist,type:'hls'},root.headers);
  const out: RawStreamCandidate[] = [];
  for (const {row,headers} of list) {
    const url = typeof row.url === 'string' ? row.url : typeof row.link === 'string' ? row.link : typeof row.file === 'string' ? row.file : '';
    if (!isSafeUpstreamUrl(url) || /vidara/i.test(url) || row.isEmbed || /embed/i.test(String(row.type || ''))) continue;
    const mediaType = /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : /\.mp4(?:[?#]|$)/i.test(url) ? 'mp4' : null;
    if (!mediaType) continue;
    const label = typeof row.language === 'string' ? row.language : typeof row.lang === 'string' ? row.lang : '';
    const lang = !/sub|caption|multi|dual/i.test(label) ? normalizeLang(label) : normalizeLang('und');
    out.push({key:url,url,type:mediaType,quality:'auto',rank:25,headers:cleanHeaders(row.headers ?? headers),...(lang.code !== 'und' ? {audioLang:lang.code,audioLabel:lang.label} : {})});
  }
  return out;
}
export async function fetchFromVidNest(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie','tv'].includes(query.type)) return [];
  const season = query.season ?? 1, episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) return [];
  const path = query.type === 'movie' ? `/movie/${query.tmdbId}` : `/tv/${query.tmdbId}/${season}/${episode}`;
  const signal = query.signal ? AbortSignal.any([query.signal,AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000);
  const all = await Promise.all(LANES.map(async lane => {
    try {
      const nonce = crypto.randomBytes(16).toString('base64url');
      const url = new URL(`${API}/${lane}${path}`); url.searchParams.set('_n',nonce);
      const response = await fetch(url, {headers:HEADERS,redirect:'error',signal});
      return mapPayload(decodeVidNestV2(await readJson(response),nonce));
    } catch { return []; }
  }));
  const unique = new Map<string, RawStreamCandidate>();
  for (const c of all.flat()) if (!unique.has(c.url)) unique.set(c.url,c);
  return [...unique.values()].slice(0,30);
}
export function createSource10Adapter(enabled: () => boolean): SourceAdapter {
  return {id:'source-10',label:'Source 10',enabled,async resolve(query) {
    const start = Date.now(), raw = await fetchFromVidNest(query);
    const verified = await verifyAndFilterCandidatesDetailed(raw,query.signal);
    const reachable = verified.candidates.filter(c => {
      const evidence = cachedCandidateEvidence(c);
      return !!evidence?.alive && (new Set(evidence.discoveredAudioLangs ?? []).size > 1 || !!c.audioLang && c.audioLang !== 'und');
    }).slice(0, 3);
    const playback = await Promise.all(reachable.map(async candidate => ({
      candidate,
      result: await diagnoseCandidatePlayback(candidate, 'full'),
    })));
    const candidates = playback
      .filter(({ result }) => (result.manifest.status === 'ok' || result.manifest.status === 'not-applicable') && result.media.status === 'ok')
      .map(({ candidate }) => candidate);
    query.diag?.push({adapter:'source-10',lane:'V',ok:candidates.length>0,ms:Date.now()-start,detail:`candidates=${raw.length},segment-verified=${candidates.length}`});
    return {candidates:candidates.map(c=>query.diag ? {...c,diagnosticLane:'V'} : c)};
  }};
}
