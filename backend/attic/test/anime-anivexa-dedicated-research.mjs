// Research-only examination of the previously bundled, authorised provider.
// Never print provider responses, streams, URLs or error messages.
import handler from '../../dist/backend/vendor/anivexa/providers/anikoto.js';
import {anilistIdForTmdb} from '../../dist/backend/sources/anime-db.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {createHash} from 'node:crypto';
const original=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
 const url=typeof input==='string'?input:input.url??String(input);
 if(!isSafeUpstreamUrl(url))throw new Error('unsafe');
 const signal=init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000);
 return original(input,{...init,signal});
};
const samples=[['Naruto','46260'],['Jujutsu Kaisen','95479'],['Attack on Titan','1429']];
try{
 for(const [title,id] of samples){
  const map=await anilistIdForTmdb(id);if(!map){console.log('::notice title=Bundled anime extractor sample::'+JSON.stringify({title,error:'mapping'}));continue;}
  for(const lane of ['sub','dub']){
   const row={title,lane};try{
    const request=new Request(`https://test.invalid/watch/anikoto/${map.anilistId}/${lane}/anikoto-1`);
    const res=await handler.fetch(request);row.status=res.status;
    const data=await res.json();
    if(res.status!==200){const err=typeof data.error==='string'?data.error:'';row.reason=/No data found for AniList ID/.test(err)?'anilist-metadata-unavailable':/No confident Anikoto/.test(err)?'identity-unconfirmed':/HTTP\s\d{3}/.test(err)?err.match(/HTTP\s\d{3}/)[0]:'other';}
    const direct=(data.streams??[]).filter(s=>s?.type==='hls'&&typeof s.url==='string');
    row.returned=direct.length;row.types=direct.map(s=>s.subtitleType??'unknown').slice(0,12);row.subtitleCounts=direct.map(s=>Array.isArray(s.subtitles)?s.subtitles.length:0).slice(0,12);
    row.fingerprints=direct.map(s=>createHash('sha256').update(s.url).digest('hex').slice(0,12)).slice(0,12);
   }catch(e){row.error=e.name;}console.log('::notice title=Bundled anime extractor sample::'+JSON.stringify(row));
  }
 }
}finally{globalThis.fetch=original;}
