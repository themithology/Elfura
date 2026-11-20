import assert from 'node:assert/strict';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
const keepAlive=setInterval(()=>{},1000);
const never=()=>new Promise(()=>{}), original=globalThis.fetch;
const cfg=loadBackendConfig({ELFURA_SECRET:'startup-test-secret',TMDB_API_BASE:'https://tmdb-timeout.example',TMDB_API_KEY:'x',OPENSUBTITLES_ENABLED:'0'});
const fake=(id,fn,segments=undefined)=>({id,label:id,enabled:()=>true,resolve:fn,...segments?{resolveSegments:segments}:{}});
const good={key:'fast',url:'https://cdn.example.org/fast.mp4',type:'mp4',quality:'auto',rank:0};
globalThis.fetch=async url=>String(url).startsWith('https://cdn.example.org/')?new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}}):never();
try {
 let reg=new SourceRegistry(cfg);reg.adapters=[fake('source-1',async()=>({candidates:[good]}),never),fake('source-2',never)];
 let start=Date.now();const first=await reg.resolvePlayback({type:'movie',tmdbId:'999001'});const fastMs=Date.now()-start;
 assert(first?.sources.length,'Healthy source should not be held by a hung adapter, metadata or skip markers');assert(fastMs<2500,`Fast source took ${fastMs}ms`);
 reg=new SourceRegistry(cfg);reg.adapters=[fake('source-1',never),fake('source-2',never)];start=Date.now();const missing=await reg.resolvePlayback({type:'movie',tmdbId:'999002'});const failMs=Date.now()-start;
 assert.equal(missing,null);assert(failMs<6800,`Hung sources took ${failMs}ms (budget is 6.2 s so slow-but-alive sources are not reported as absent)`);
 // Unknown liveness must remain bounded even if a shared fetch ignores abort.
 globalThis.fetch=async()=>never();reg=new SourceRegistry(cfg);reg.adapters=[fake('source-1',async()=>({candidates:[{...good,key:'slow-probe',url:'https://cdn.example.org/stalled.mp4'}]})),fake('source-2',never)];start=Date.now();await reg.resolvePlayback({type:'movie',tmdbId:'999003'});const probeMs=Date.now()-start;assert(probeMs<6800,`Stalled verification took ${probeMs}ms`);
 // Exercise real newly registered adapters with hung discovery, not just fake adapters.
 globalThis.fetch=async url=>String(url).startsWith('https://cdn.example.org/')?new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}}):never();
 const realCfg=loadBackendConfig({ELFURA_SECRET:'startup-test-secret',TMDB_API_BASE:'https://tmdb-timeout.example',TMDB_API_KEY:'x',OPENSUBTITLES_ENABLED:'0'});
 reg=new SourceRegistry(realCfg);reg.adapters=[fake('source-1',async()=>({candidates:[good]}),never),...reg.adapters.filter(a=>['source-7','source-8','source-9','source-10','source-11','source-12','source-13','source-14','source-15'].includes(a.id))];
 start=Date.now();const mixed=await reg.resolvePlayback({type:'tv',tmdbId:'999004',season:1,episode:1});const newSourcesMs=Date.now()-start;
 assert(mixed?.sources.length,'Existing fast source must remain available');assert(newSourcesMs<4500,`New hung sources delayed startup to ${newSourcesMs}ms (join window may add ~1.3 s to collect a fuller source list)`);
 // Fairness: a fast source answering first must not silence a source that
 // needs ~1.2 s. Both lanes have to be in the very first response.
 const slow={key:'slow',url:'https://cdn.example.org/slow.mp4',type:'mp4',quality:'auto',rank:0};
 const sleeper=ms=>new Promise(r=>setTimeout(r,ms));
 globalThis.fetch=async url=>String(url).startsWith('https://cdn.example.org/')?new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}}):never();
 reg=new SourceRegistry(cfg);reg.adapters=[fake('source-1',async()=>({candidates:[good]})),fake('source-14',async()=>{await sleeper(1200);return{candidates:[slow]};})];
 start=Date.now();const fair=await reg.resolvePlayback({type:'movie',tmdbId:'999005'});const fairMs=Date.now()-start;
 const fairIds=(fair?.sources??[]).map(s=>s.sourceId);
 assert(fairIds.includes('source-1'),`Fast source missing: ${fairIds.join(',')}`);
 assert(fairIds.includes('source-14'),`Slow source must not be cut by a fast one: ${fairIds.join(',')}`);
 assert(fairMs<3000,`Fairness window too slow: ${fairMs}ms`);

 console.log(`✓ Startup budget: fast ${fastMs}ms, no sources ${failMs}ms, stalled verification ${probeMs}ms, new sources stalled ${newSourcesMs}ms, fair join ${fairMs}ms (${fairIds.join(',')}).`);
}finally{globalThis.fetch=original;clearInterval(keepAlive)}
