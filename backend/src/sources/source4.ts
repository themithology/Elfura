/** Anime catalogue lookup + direct NekoMux multi-rendition HLS. */
import { isSafeUpstreamUrl } from '../security.js';
import { extractManifestAudioLangs } from '../relay.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const CATALOG = 'https://animesalttv.to';
const PLAYER = 'https://player.nekomux.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36';
const cleanTitle = (value: string) => value.replace(/&amp;|&#0*38;/gi, '&').replace(/&#0*39;|&apos;/gi, "'").replace(/&quot;/gi, '"').toLowerCase().replace(/[^a-z0-9]+/g, '');

export async function fetchAnimeMultiAudio(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (query.type !== 'tv' || !query.resolveMetaFallback) return [];
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  try {
    const meta = await Promise.race([query.resolveMetaFallback(), new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once:true }))]);
    if (signal.aborted || meta.originalLanguage !== 'ja') return [];
    const title = (meta.rawTitle || meta.title || '').trim();
    const wanted = cleanTitle(title);
    if (wanted.length < 3 || title.length > 200) return [];
    const get = (url: string, referer: string) => fetch(url, { headers: {'User-Agent':UA, Referer:referer, Accept:'*/*'}, signal, redirect:'error' });
    const search = await get(`${CATALOG}/wp-json/wp/v2/anime?search=${encodeURIComponent(title)}&per_page=20&_fields=id,slug,title`, `${CATALOG}/`);
    if (!search.ok) return [];
    const rows = await search.json() as {slug?:unknown;title?:{rendered?:unknown}}[];
    if (!Array.isArray(rows)) return [];
    const matches = rows.filter(row => typeof row?.title?.rendered === 'string' && cleanTitle(row.title.rendered) === wanted && typeof row.slug === 'string' && /^[a-z0-9-]{1,160}$/.test(row.slug));
    // Avoid ambiguous title collisions rather than playing a different show.
    if (matches.length !== 1) return [];
    const season = query.season ?? 1, episode = query.episode ?? 1;
    if (!Number.isInteger(season) || !Number.isInteger(episode) || season < 1 || episode < 1 || season > 999 || episode > 9999) return [];
    const ep = await get(`${CATALOG}/episode/${matches[0].slug}-${season}x${episode}/`, `${CATALOG}/`);
    if (!ep.ok) return [];
    const html = await ep.text();
    const ids = [...html.matchAll(/https?:\/\/player\.nekomux\.com\/episode\/(\d{1,10})(?:["'/?#\s<]|$)/gi)].map(x=>x[1]);
    if (new Set(ids).size !== 1) return [];
    const id = ids[0];
    const player = await get(`${PLAYER}/episode/${id}`, `${CATALOG}/`);
    if (!player.ok) return [];
    const playerHtml = await player.text();
    const pageTitle = playerHtml.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
    const match = pageTitle.match(/^(.*?)\s*[·|–—-]\s*S(\d+)\s*E(\d+)/i);
    if (!match || cleanTitle(match[1]) !== wanted || Number(match[2]) !== season || Number(match[3]) !== episode) return [];
    const response = await get(`${PLAYER}/episode/${id}/source`, `${PLAYER}/episode/${id}`);
    if (!response.ok) return [];
    const data = await response.json() as {ok?:unknown;type?:unknown;url?:unknown};
    if (!data.ok || data.type !== 'hls' || typeof data.url !== 'string' || !isSafeUpstreamUrl(data.url)) return [];
    const u = new URL(data.url);
    if (u.protocol !== 'https:' || u.hostname !== 'play.nekomux.com' || !/^\/p\/[^/]+\/\d+\/\d+\/hls\/[0-9A-Z]{26}\/master\.m3u8$/i.test(u.pathname)) return [];
    const headers = {'User-Agent':UA, Referer:`${PLAYER}/`};
    const manifest = await fetch(u.href, {headers,signal,redirect:'error'});
    if (!manifest.ok) return [];
    const text = await manifest.text();
    const langs = extractManifestAudioLangs(text);
    if (!text.trimStart().startsWith('#EXTM3U') || langs.length < 2) return [];
    return [{key:`nekomux:${id}`,fingerprint:`nekomux:${id}`,url:u.href,type:'hls',quality:'auto',headers,rank:0,multiAudio:true,availableAudioLangs:langs,refreshNekoEpisode:id}];
  } catch { return []; }
}

export function createSource4Adapter(enabled = true): SourceAdapter {
  return {id:'source-4',label:'Source 4',enabled:()=>enabled,async resolve(query){
    const start=Date.now(); const candidates=await fetchAnimeMultiAudio(query);
    query.diag?.push({adapter:'source-4',lane:'anime',ok:candidates.length>0,ms:Date.now()-start,detail:`candidates=${candidates.length}`});
    return {candidates};
  }};
}
