// The TGVIDX background wave must survive a slow upstream without delaying
// first paint or changing the ordinary adapter deadline.
import assert from 'node:assert/strict';
import {SourceRegistry} from '../../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../../dist/backend/config.js';
const original=globalThis.fetch,keep=setInterval(()=>{},1000);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const candidate=id=>({key:id,url:`https://late-source17.example/${id}.mp4`,type:'mp4',quality:'auto',rank:0});
const fast={id:'source-1',label:'Source 1',enabled:()=>true,resolve:async()=>({candidates:[candidate('fast')]})};
let attempts=0,aborted=false,ordinaryAborted=false;
function delayed(id,ms){return {id,label:id,enabled:()=>true,async resolve(q){attempts++;return new Promise(resolve=>{const timer=setTimeout(()=>resolve({candidates:[candidate(id)]}),ms);q.signal.addEventListener('abort',()=>{clearTimeout(timer);if(id==='source-17')aborted=true;else ordinaryAborted=true;resolve({candidates:[]})},{once:true})})}}}
try{
 globalThis.fetch=async input=>String(input).includes('localhost')?Response.json({title:'Fixture',runtime:100,images:{logos:[]}}):new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}});
 const cfg=loadBackendConfig({ELFURA_SECRET:'fixture',RESOLVE_TIMEOUT_MS:'2000',TMDB_API_BASE:'http://localhost:42424',OPENSUBTITLES_ENABLED:'0'});
 const reg=new SourceRegistry(cfg);reg.adapters=[fast,delayed('source-17',3300),delayed('source-3',3300)];
 const begin=Date.now();const first=await reg.resolvePlayback({type:'movie',tmdbId:'50441'});
 assert(first?.sources.some(s=>s.sourceId==='source-1'));assert(!first.sources.some(s=>s.sourceId==='source-17'));assert(Date.now()-begin<3200,'slow TGVIDX must not extend first response');
 await wait(Math.max(0,3500-(Date.now()-begin)));
 const late=await reg.resolvePlayback({type:'movie',tmdbId:'50441',late:true,retryMissing:true});
 assert(late?.sources.some(s=>s.sourceId==='source-17'),'slow TGVIDX must join original late wave');
 assert(!aborted,'TGVIDX was cut off by the shared 2s signal');assert(ordinaryAborted,'other adapters must retain the configured deadline');
 assert(attempts<=3,'in-flight TGVIDX must not be launched twice');
 // A focused source request keeps the same overall HTTP deadline, but its
 // discovery must not be aborted by the shorter per-adapter signal either.
 const focused=new SourceRegistry(cfg);focused.adapters=[delayed('source-17',3300)];
 const only=await focused.resolvePlayback({type:'movie',tmdbId:'50442',sourceId:'source-17'});
 assert(only?.sources.some(s=>s.sourceId==='source-17'),'focused TGVIDX must survive the short shared signal');
 console.log('TGVIDX background and focused discovery, ordinary deadline: OK');
}finally{globalThis.fetch=original;clearInterval(keep)}
