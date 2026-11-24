import { restrictedFetch } from '../restricted-fetch.js';
import { isPublicMediaUrl } from '../security.js';
import { extractMegaPlayDetails } from '../vendor/anivexa/extractors/megaplay-safe.js';
import { resolveDirectAnimeEpisode } from './anime-direct-mapping.js';
import { normalizeLang } from '../../src/sources/lang.js';
import { readBoundedText } from './upstream-fetch.js';
import type { RawSourceResult, RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from '../../src/sources/types.js';

const ORIGIN='https://megaplay.buzz';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const empty=(): RawSourceResult => ({candidates:[]});

function subtitles(raw: unknown[]): RawTrackRef[] {
  const result: RawTrackRef[]=[];
  for(const entry of raw.slice(0,24)) {
    if(!entry || typeof entry !== 'object') continue;
    const track=entry as {file?:unknown;url?:unknown;label?:unknown;kind?:unknown};
    if(track.kind!=='captions' && track.kind!=='subtitles') continue;
    const ref=track.file ?? track.url;
    if(typeof ref!=='string') continue;
    const label=typeof track.label==='string'?track.label.slice(0,80):'';
    const lang=normalizeLang(null,label).code;
    if(lang==='und')continue;
    try {
      const url=new URL(ref,ORIGIN);
      if(!isPublicMediaUrl(url.href))continue;
      const ext=url.pathname.match(/\.(vtt|srt|ass|ssa)$/i)?.[1]?.toLowerCase();
      if(!ext)continue;
      result.push({url:url.href,lang,label:label||lang,format:ext==='ssa'?'ass':ext as 'vtt'|'srt'|'ass',headers:{'User-Agent':UA,Referer:ORIGIN+'/'}});
    } catch { /* skip malformed track */ }
  }
  return result;
}

export function createSource30Adapter(enabled:()=>boolean=()=>true, options:{fetchImpl?:typeof fetch;mapEpisode?:typeof resolveDirectAnimeEpisode}={}):SourceAdapter {
  const f=options.fetchImpl ?? fetch;
  const mapEpisode=options.mapEpisode ?? resolveDirectAnimeEpisode;
  return {
    id:'source-30',label:'Source 30',enabled,
    async resolve(query:SourceQuery):Promise<RawSourceResult> {
      if(!enabled())return empty();
      const mapping=await mapEpisode(query,f);
      if(!mapping)return empty();
      const signal=query.signal?AbortSignal.any([query.signal,AbortSignal.timeout(8500)]):AbortSignal.timeout(8500);
      const lane=async(mode:'sub'|'dub'):Promise<RawStreamCandidate[]>=>{
        const page=`${ORIGIN}/stream/ani/${mapping.anilistId}/${mapping.episode}/${mode}`;
        let requests=0;
        // The extractor is static bundled code, not the provider's JS. All
        // its discovery requests remain on the fixed provider origin.
        const guarded:typeof fetch=async(input,init={})=>{
          const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
          if(++requests>14 || url.origin!==ORIGIN || url.username || url.password || !isPublicMediaUrl(url.href)) throw new Error('blocked discovery request');
          const response=await restrictedFetch(url,{...init,signal},f);
          if(!response.ok) {await response.body?.cancel().catch(()=>{});return new Response('',{status:response.status});}
          const text=await readBoundedText(response, url.pathname.endsWith('.js')?150_000:1_000_000);
          if(text===null)throw new Error('oversize');
          return new Response(text,{status:response.status,headers:{'content-type':response.headers.get('content-type')??''}});
        };
        try {
          const data=await extractMegaPlayDetails(page,{fetchImpl:guarded,userAgent:UA,referer:ORIGIN+'/',signal});
          const tracks=subtitles(data.tracks);
          return data.sources.slice(0,2).flatMap((source):RawStreamCandidate[]=>{
            if(typeof source.url!=='string'||!isPublicMediaUrl(source.url))return [];
            return [{key:source.url,url:source.url,restrictedOrigin:'*public*',type:'hls',quality:'auto',rank:20,
              audioVariant:mode,claimedAudioLang:mode==='dub'?'en':'ja',audioLabel:mode==='dub'?'Dub':'Sub',
              headers:{'User-Agent':UA,Referer:ORIGIN+'/'},subtitles:tracks}];
          });
        } catch {return [];}
      };
      const [sub,dub]=await Promise.all([lane('sub'),lane('dub')]);
      return {candidates:[...sub,...dub]};
    },
  };
}
