/** Direct VAPlayer HLS discovery. Upstream 'original' is not evidence of a
 * language: only manifest-proven multi-audio results are returned. */
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';
const API = 'https://streamdata.vaplayer.ru/api.php';
const ORIGIN = 'https://brightpathsignals.com';
const HEADERS = { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36', Referer:ORIGIN+'/', Origin:ORIGIN, Accept:'application/json' };
async function readJson(res: Response): Promise<unknown> {
  const max = 128_000;
  if (!res.ok || !res.body || Number(res.headers.get('content-length') || 0) > max) { await res.body?.cancel(); return null; }
  const reader = res.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('oversized'); chunks.push(value); } return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  finally { await reader.cancel().catch(() => {}); }
}
export async function fetchFromVAPlayer(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie','tv'].includes(query.type)) return [];
  const season = query.season ?? 1, episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 0 || !Number.isSafeInteger(episode) || episode < 1)) return [];
  const endpoint = new URL(API); endpoint.searchParams.set('tmdb',query.tmdbId); endpoint.searchParams.set('type',query.type);
  if (query.type === 'tv') { endpoint.searchParams.set('season',String(season)); endpoint.searchParams.set('episode',String(episode)); }
  const signal = query.signal ? AbortSignal.any([query.signal,AbortSignal.timeout(3500)]) : AbortSignal.timeout(3500);
  try {
    const response = await fetch(endpoint,{headers:HEADERS,redirect:'error',signal});
    const data = await readJson(response);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    const root = data as {status_code?: unknown; data?: unknown};
    if (String(root.status_code) !== '200' || !root.data || typeof root.data !== 'object' || Array.isArray(root.data)) return [];
    const body = root.data as {stream_urls?: unknown; season?: unknown; episode?: unknown};
    if (query.type === 'tv' && ((body.season != null && String(body.season) !== String(season)) || (body.episode != null && String(body.episode) !== String(episode)))) return [];
    if (!Array.isArray(body.stream_urls)) return [];
    const urls = new Set<string>();
    for (const url of body.stream_urls.slice(0,12)) {
      if (typeof url !== 'string' || !isSafeUpstreamUrl(url) || !/\.m3u8(?:[?#]|$)/i.test(url) || /vidara/i.test(url)) continue;
      urls.add(url);
    }
    return [...urls].map((url,rank)=>({key:url,url,type:'hls',quality:'auto',headers:{...HEADERS},rank:30+rank}));
  } catch { return []; }
}
export function createSource11Adapter(enabled: () => boolean): SourceAdapter {
  return {id:'source-11',label:'Source 11',enabled,async resolve(query) {
    const start = Date.now(), raw = await fetchFromVAPlayer(query);
    const verified = await verifyAndFilterCandidatesDetailed(raw,query.signal);
    const candidates = verified.candidates.filter(c => {
      const evidence = cachedCandidateEvidence(c);
      return !!evidence?.alive && new Set(evidence.discoveredAudioLangs ?? []).size > 1;
    });
    query.diag?.push({adapter:'source-11',lane:'A',ok:candidates.length>0,ms:Date.now()-start,detail:`candidates=${raw.length},multi=${candidates.length}`});
    return {candidates:candidates.map(c=>query.diag ? {...c,diagnosticLane:'A'} : c)};
  }};
}
