/** VixSrc signed HLS discovery. All outputs flow through Elfura's relay. */
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';
const BASE = 'https://vixsrc.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: BASE + '/', Origin: BASE };

function embeddedValue(html: string, pattern: RegExp): string | null {
  const raw = pattern.exec(html)?.[1];
  if (!raw) return null;
  // VixSrc's server-rendered player sometimes JSON-escapes URL separators and
  // query ampersands; mirror the upstream extractor's decoding before parsing.
  const slash = String.fromCharCode(92);
  return raw.replaceAll(slash.repeat(2) + 'u0026', '&')
    .replaceAll(slash + 'u0026', '&')
    .replaceAll(slash.repeat(2) + '/', '/')
    .replaceAll(slash + '/', '/')
    .replaceAll(slash.repeat(2), slash);
}

async function boundedText(res: Response, max: number): Promise<string> {
  if (!res.ok || !res.body || Number(res.headers.get('content-length') || 0) > max) { await res.body?.cancel(); throw new Error('upstream response'); }
  const reader = res.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('oversized'); chunks.push(value); } return Buffer.concat(chunks).toString('utf8'); }
  finally { await reader.cancel().catch(() => {}); }
}

export async function fetchFromVixSrc(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId) || !['movie','tv'].includes(query.type)) return [];
  const s = query.season ?? 1, e = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(s) || s < 0 || !Number.isSafeInteger(e) || e < 1)) return [];
  const path = query.type === 'movie' ? `/api/movie/${query.tmdbId}` : `/api/tv/${query.tmdbId}/${s}/${e}`;
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000);
  try {
    const api = await fetch(BASE + path, {headers:HEADERS, redirect:'error', signal});
    const data = JSON.parse(await boundedText(api, 65536)) as {src?: unknown};
    if (typeof data.src !== 'string' || data.src.length > 4096 || !/^\/embed\/\d+(?:\?|$)/.test(data.src)) return [];
    const embedUrl = new URL(data.src, BASE);
    if (embedUrl.origin !== BASE) return [];
    const page = await fetch(embedUrl, {headers:HEADERS, redirect:'error', signal});
    const html = await boundedText(page, 512_000);
    // Token values are kept server-side; never evaluate remote player JS.
    const token = embeddedValue(html, /['"]?token['"]?\s*:\s*['"]([^'"]{1,2048})['"]/)?.trim();
    const expires = embeddedValue(html, /['"]?expires['"]?\s*:\s*['"](\d{1,12})['"]/)?.trim();
    const playlist = embeddedValue(html, /\burl['"]?\s*:\s*['"]([^'"]{1,4096})['"]/)?.trim();
    const langRaw = embeddedValue(html, /\blang(?:uage)?['"]?\s*:\s*['"]([a-z]{2,5})['"]/i);
    const lang = langRaw && /^[a-z]{2,5}$/i.test(langRaw) ? langRaw.toLowerCase() : 'en';
    if (!token || !expires || Number(expires) * 1000 <= Date.now() + 30_000 || !playlist || !isSafeUpstreamUrl(playlist)) return [];
    const stream = new URL(playlist);
    if (stream.protocol !== 'https:' || !/\.m3u8$/i.test(stream.pathname)) return [];
    stream.searchParams.set('token', token); stream.searchParams.set('expires', expires); stream.searchParams.set('h', '1'); stream.searchParams.set('lang', lang);
    const url = stream.toString();
    return [{key:url,url,type:'hls',quality:'auto',rank:25,headers:{...HEADERS,Referer:embedUrl.toString()}}];
  } catch { return []; }
}
export function createSource9Adapter(enabled: () => boolean): SourceAdapter {
  return {id:'source-9',label:'Source 9',enabled,async resolve(query) {
    const start = Date.now(); const raw = await fetchFromVixSrc(query);
    const verified = await verifyAndFilterCandidatesDetailed(raw,query.signal);
    const candidates = verified.candidates.filter(c => {
      const evidence = cachedCandidateEvidence(c);
      return !!evidence?.alive;
    });
    query.diag?.push({adapter:'source-9',lane:'V',ok:candidates.length>0,ms:Date.now()-start,detail:`candidates=${raw.length},multi=${candidates.length}`});
    return {candidates:candidates.map(c=>query.diag ? {...c,diagnosticLane:'V'} : c)};
  }};
}
