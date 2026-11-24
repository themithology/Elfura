// Codec hints in Source 4 manifests, aggregated only; never log URLs or media.
import {fetchFromBingr} from '../../dist/backend/sources/source4.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
const samples=[{name:'Fight Club',type:'movie',tmdbId:'550'},{name:'Game of Thrones E1',type:'tv',tmdbId:'1399',season:1,episode:1},{name:'Naruto E1',type:'tv',tmdbId:'46260',season:1,episode:1}];
const hint=/(?:^|[_/.-])(?:h265|hevc|x265)(?:[_/.-]|$)/i;
const rows=[];
for(const s of samples){const row={sample:s.name};try{
 const raw=await fetchFromBingr({...s,diag:[],signal:AbortSignal.timeout(10000)});row.candidates=raw.length;
 const checked=[];
 for(let i=0;i<Math.min(16,raw.length);i+=4){
 const batch=await Promise.all(raw.slice(i,i+4).map(async c=>{try{
  const r=await fetch(c.url,{headers:c.headers,redirect:'error',signal:AbortSignal.timeout(7000)});const text=await readBoundedText(r,500000);
  const valid=!!r.ok&&!!text?.trimStart().startsWith('#EXTM3U');const codecs=[...text?.matchAll(/CODECS="([^"]+)"/g)??[]].map(m=>m[1]);
  const uris=(text??'').split(/\r?\n/).filter(x=>x&&!x.startsWith('#')).slice(0,8);const base=new URL(c.url);
  return {valid,baseHevc:hint.test(c.url)||hint.test(base.searchParams.get('url')??''),childHevc:uris.some(u=>hint.test(u)),declaresHevc:codecs.some(x=>/hvc1|hev1/i.test(x)),declaresAvc:codecs.some(x=>/avc1|avc3/i.test(x)),declaresOther:codecs.some(x=>!/(hvc1|hev1|avc1|avc3)/i.test(x))};
 }catch{return {valid:false}}}));checked.push(...batch);
 }
 row.checked=checked.length;row.valid=checked.filter(x=>x.valid).length;row.hevcHint=checked.filter(x=>x.valid&&(x.baseHevc||x.childHevc||x.declaresHevc)).length;row.declaredAvc=checked.filter(x=>x.valid&&x.declaresAvc).length;row.noHevcHint=checked.filter(x=>x.valid&&!x.baseHevc&&!x.childHevc&&!x.declaresHevc).length;
}catch(e){row.error=e?.cause?.code??e.name;}rows.push(row);}
console.log('::notice title=Source 4 codec survey::'+JSON.stringify(rows));
