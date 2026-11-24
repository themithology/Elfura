// Network-only research: report counts/statuses, never provider links or secrets.
import {createSource16Adapter} from '../../../dist/backend/sources/source16.js';
import {createSource18Adapter,loadSubDubCatalog,catalogVariants} from '../../../dist/backend/sources/source18.js';
import {createHash} from 'node:crypto';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function req(url, opts={}) {const r=await fetch(url,{...opts,headers:{'User-Agent':ua,Accept:'text/html,application/json,*/*',...(opts.headers??{})},signal:AbortSignal.timeout(8000)});const text=await r.text();return {status:r.status,text,url:r.url};}
const report=[];
for(const [name,id,tmdb] of [['Naruto','20','46260'],['Demon Slayer','101922','85937'],['Jujutsu Kaisen','113415','95479'],['Attack on Titan','16498','1429']]){
 const trace=[];let candidates=[];
 try{const raw=await createSource16Adapter(()=>true).resolve({type:'tv',tmdbId:tmdb,anilistId:id,season:1,episode:1,diag:trace,signal:AbortSignal.timeout(14000)});candidates=raw.candidates;}catch{}
 report.push({name,source:'existing-hindi',count:candidates.length,types:candidates.map(x=>x.type),langs:candidates.map(x=>x.audioLang),trace});
}
console.log('::notice title=Existing Hindi anime::'+JSON.stringify(report));
for(const [name,tmdb] of [['Naruto','46260'],['Demon Slayer','85937'],['Jujutsu Kaisen','95479']]) {
 const catalog=await loadSubDubCatalog(AbortSignal.timeout(12000));
 const labels=catalog?catalogVariants(catalog,'tv',tmdb).map(v=>({language:v.language??null,title:String(v.title??'').slice(0,80)})):[];
 console.log('::notice title=Anime catalog claims::'+JSON.stringify({name,labels}));
 const rows=[];
 for(const episode of [1,2]){
  const diag=[];try {const res=await createSource18Adapter(()=>true).resolve({type:'tv',tmdbId:tmdb,season:1,episode,diag,signal:AbortSignal.timeout(18000)});
   rows.push({episode,count:res.candidates.length,langs:res.candidates.map(x=>x.audioLang??'unknown'),types:res.candidates.map(x=>x.type),hashes:res.candidates.map(x=>createHash('sha256').update(x.url).digest('hex').slice(0,10)),diag});
  }catch(e){rows.push({episode,error:e.name});}
 }
 console.log('::notice title=Existing catalog audit::'+JSON.stringify({name,rows}));
 try{const r=await req('https://api.ani.zip/mappings?themoviedb_id='+tmdb);const j=JSON.parse(r.text);const entries=Object.entries(j.episodes??{}).slice(0,3).map(([k,v])=>({number:k,seasonNumber:v.seasonNumber,episodeNumber:v.episodeNumber}));console.log('::notice title=AniZip episode mapping shape::'+JSON.stringify({name,status:r.status,entries}));}catch(e){console.log('::notice title=AniZip episode mapping shape::'+JSON.stringify({name,error:e.name}));}
}
const candidates=[];
for(const q of ['Naruto','Jujutsu Kaisen','Attack on Titan']){
 const row={query:q};
 try{
  const url='https://www.desidubanime.me/wp-json/wp/v2/anime?search='+encodeURIComponent(q)+'&per_page=10';
  const res=await req(url);row.status=res.status;
  if(res.status===200){
   const data=JSON.parse(res.text);row.count=Array.isArray(data)?data.length:0;
   row.titles=Array.isArray(data)?data.slice(0,5).map(x=>String(x.title?.rendered??'').replace(/<[^>]*>/g,'').slice(0,90)):[];
   const norm=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'');
   const hit=Array.isArray(data)?data.find(x=>norm(String(x.title?.rendered??''))===norm(q)):null;
   if(hit && typeof hit.link==='string' && new URL(hit.link).hostname.endsWith('desidubanime.me')){
    const page=await req(hit.link);row.seriesStatus=page.status;
    const ep=[...page.text.matchAll(/https?:\\?\/\\?\/[^"'\s<>]*desidubanime\.me\\?\/watch\\?\/[^"'\s<>]*/gi)].map(m=>m[0].replace(/\\\//g,'/'));
    row.episodeLinks=ep.length;
    const first=ep.find(x=>/(?:episode|ep)[-_]0?1(?:[-/?.]|$)/i.test(x));
    if(first){const watch=await req(first);row.watchStatus=watch.status;const ids=[...watch.text.matchAll(/data-embed-id=["']([^"']+)["']/gi)];row.servers=ids.slice(0,10).map(m=>{try{const [n,u]=m[1].split(':');const name=Buffer.from(n,'base64').toString('utf8');const decoded=Buffer.from(u??'','base64').toString('utf8');let host='unknown';try{host=new URL(decoded.match(/src=["']([^"']+)/i)?.[1]??decoded).hostname}catch{}return {name:name.slice(0,50),host};}catch{return {name:'unknown'}}});}
   }
  }
 }catch(e){row.error=e.name;}
 candidates.push(row);
}
console.log('::notice title=Hindi anime directory audit::'+JSON.stringify(candidates));
for(const u of ['https://watchanimeworld.one/','https://animedekho.tv/wp-json/dgt/v1/suggest?q=naruto']) {
 try{const r=await req(u);console.log('::notice title=Anime provider access::'+JSON.stringify({provider:new URL(u).hostname,status:r.status,bytes:r.text.length,cloudflare:/cf-chl|just a moment/i.test(r.text)}));}
 catch(e){console.log('::notice title=Anime provider access::'+JSON.stringify({provider:new URL(u).hostname,error:e.name}));}
}
