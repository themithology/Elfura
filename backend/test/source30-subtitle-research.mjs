import {createSource30Adapter} from '../../dist/backend/sources/source30.js';
import {restrictedFetchWithRedirects} from '../../dist/backend/restricted-fetch.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
const adapter=createSource30Adapter(()=>true,{mapEpisode:async()=>({anilistId:'20',episode:1})});
const out=[];
for(const c of (await adapter.resolve({type:'tv',tmdbId:'46260',season:1,episode:1})).candidates){
 const row={lane:c.audioVariant,tracks:[]};
 for(const t of (c.subtitles??[]).slice(0,2)){
  const track={lang:t.lang,format:t.format,host:new URL(t.url).hostname,attempts:[]};
  for(const ref of [t.headers?.Referer,'https://megaplay.buzz/','https://anikototv.to/'])try{
   const r=await restrictedFetchWithRedirects(t.url,{headers:{'User-Agent':t.headers?.['User-Agent']??'Mozilla/5.0',Referer:ref},signal:AbortSignal.timeout(8000)},'*public*');
   const text=await readBoundedText(r,400000);track.attempts.push({refKind:ref===t.headers?.Referer?'page':ref.includes('anikoto')?'site':'root',status:r.status,bytes:text?.length??0,vtt:!!text?.trimStart().startsWith('WEBVTT'),hasCues:!!text?.includes('-->')});
  }catch(e){track.attempts.push({error:e.name});}
  row.tracks.push(track);
 }
 out.push(row);
}
console.log('::notice title=MegaPlay subtitle probe::'+JSON.stringify(out));
