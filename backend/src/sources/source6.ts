/** Optional Vidmody HLS fallback. Do not claim audio languages from a label;
 * the shared liveness verifier checks the returned manifest instead. */
import type { SourceAdapter, SourceQuery, RawStreamCandidate } from './types.js';
const ORIGIN = 'https://vidmody.com';
const HEADERS = { Referer: ORIGIN + '/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36' };
export async function fetchFromVidmody(query: SourceQuery): Promise<RawStreamCandidate[]> {
  try {
    const imdbId = query.imdbId || (await query.resolveMetaFallback?.())?.imdbId;
    if (!imdbId || !/^tt\d{1,12}$/.test(imdbId)) return [];
    const season = query.season ?? 1, episode = query.episode ?? 1;
    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 0 || episode < 1) return [];
    const url = `${ORIGIN}/vs/${imdbId}${query.type === 'tv' ? `/s${season}/e${String(episode).padStart(2,'0')}` : ''}`;
    const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500);
    const response = await fetch(url, { headers: { ...HEADERS, Range: 'bytes=0-65535' }, redirect: 'error', signal });
    if (!response.ok || !response.body) { await response.body?.cancel(); return []; }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try { while (length < 65536) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); length += value.length; } }
    finally { await reader.cancel().catch(() => {}); }
    if (!/^\s*#EXTM3U/.test(Buffer.concat(chunks).subarray(0,65536).toString('utf8'))) return [];
    return [{ key: url, url, type: 'hls', headers: HEADERS, quality: 'auto', rank: 30 }];
  } catch { return []; }
}
export function createSource6Adapter(enabled: () => boolean): SourceAdapter {
  return { id: 'source-6', label: 'Source 6', enabled, async resolve(query) {
    const start = Date.now(); const candidates = await fetchFromVidmody(query);
    query.diag?.push({adapter:'source-6',lane:'V',ok:candidates.length > 0,ms:Date.now()-start,detail:`candidates=${candidates.length}`});
    return { candidates: candidates.map(c => query.diag ? {...c,diagnosticLane:'V'} : c) };
  } };
}
