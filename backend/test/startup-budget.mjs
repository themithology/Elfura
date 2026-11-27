// Synthetic adapter fixtures exercise first-response and late-wave budgets.
// The real-registry case only includes the four currently approved source IDs.
import assert from 'node:assert/strict';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
const keepAlive=setInterval(()=>{},1000);
const never=()=>new Promise(()=>{}), original=globalThis.fetch;
const cfg=loadBackendConfig({ELFURA_SECRET:'startup-test-secret',TMDB_API_BASE:'https://tmdb-timeout.example',TMDB_API_KEY:'x',OPENSUBTITLES_ENABLED:'0'});
const fake=(id,fn,segments=undefined)=>({id,label:`Fixture ${id}`,enabled:()=>true,resolve:fn,...segments?{resolveSegments:segments}:{}});
const good={key:'fast',url:'https://cdn.example.org/fast.mp4',type:'mp4',quality:'auto',rank:0};
globalThis.fetch=async url=>String(url).startsWith('https://cdn.example.org/')?new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}}):never();
try {
 let reg=new SourceRegistry(cfg);reg.adapters=[fake('fixture-fast',async()=>({candidates:[good]}),never),fake('fixture-hung',never)];
 let start=Date.now();const first=await reg.resolvePlayback({type:'movie',tmdbId:'999001'});const fastMs=Date.now()-start;
 assert(first?.sources.length,'Healthy source should not be held by a hung adapter, metadata or skip markers');assert(fastMs<2500,`Fast source took ${fastMs}ms`);
 reg=new SourceRegistry(cfg);reg.adapters=[fake('fixture-hung-a',never),fake('fixture-hung-b',never)];start=Date.now();const missing=await reg.resolvePlayback({type:'movie',tmdbId:'999002'});const failMs=Date.now()-start;
 assert.equal(missing,null);assert(failMs<3800,`No-source lookup waited too long for a stalled adapter fixture: ${failMs}ms`);
 // Unknown liveness must remain bounded even if a shared fetch ignores abort.
 globalThis.fetch=async()=>never();reg=new SourceRegistry(cfg);reg.adapters=[fake('fixture-stalled-probe',async()=>({candidates:[{...good,key:'slow-probe',url:'https://cdn.example.org/stalled.mp4'}]})),fake('fixture-hung',never)];start=Date.now();await reg.resolvePlayback({type:'movie',tmdbId:'999003'});const probeMs=Date.now()-start;assert(probeMs<3100,`Stalled verification was repeated or held playback too long: ${probeMs}ms`);
 // Exercise real newly registered adapters with hung discovery, not just fake adapters.
 globalThis.fetch=async url=>String(url).startsWith('https://cdn.example.org/')?new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}}):never();
 const realCfg=loadBackendConfig({ELFURA_SECRET:'startup-test-secret',TMDB_API_BASE:'https://tmdb-timeout.example',TMDB_API_KEY:'x',OPENSUBTITLES_ENABLED:'0'});
 reg=new SourceRegistry(realCfg);reg.adapters=[fake('fixture-fast',async()=>({candidates:[good]}),never),...reg.adapters.filter(a=>['source-2','source-3','source-4'].includes(a.id))];
 start=Date.now();const mixed=await reg.resolvePlayback({type:'tv',tmdbId:'999004',season:1,episode:1});const newSourcesMs=Date.now()-start;
 assert(mixed?.sources.length,'Existing fast fixture must remain available');assert(newSourcesMs<4500,`Current approved adapters delayed startup to ${newSourcesMs}ms (join window may add ~1.3 s to collect a fuller source list)`);
 // A verified first lane must not wait for a slower trait fixture to finish.
 globalThis.fetch=async url=>{
  const value=String(url);
  if(value.startsWith('https://cdn.example.org/'))return new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}});
  if(value.startsWith('https://tmdb-timeout.example/')){
   const parsed=new URL(value);
   return Response.json(parsed.pathname.includes('/season/')?{name:'Episode',runtime:24}:{name:'Fixture Series',original_language:'ja',genres:[{name:'Animation'}],episode_run_time:[24]});
  }
  return never();
 };
 const slowTrait={...fake('fixture-slow-trait',async()=>{await new Promise(r=>setTimeout(r,1200));return{candidates:[{...good,key:'slow-trait',url:'https://cdn.example.org/slow-trait.mp4'}]};}),traits:['animeEpisode']};
 reg=new SourceRegistry(cfg);reg.adapters=[fake('fixture-fast',async()=>({candidates:[good]})),...['fixture-hung-a','fixture-hung-b','fixture-hung-c'].map(id=>fake(id,never)),slowTrait];
 start=Date.now();const traitFirst=await reg.resolvePlayback({type:'tv',tmdbId:'999006',season:1,episode:1});const traitMs=Date.now()-start;
 assert(traitFirst?.sources.some(source=>source.sourceId==='fixture-fast'),'Fast verified fixture must be returned before slower trait fixture');
 assert(traitFirst.pendingSources.includes('fixture-slow-trait'),'Slow trait fixture should remain pending for late hydration');
 assert(traitMs<1600,`Trait enrichment held first playback for ${traitMs}ms`);
 // Fairness: a fast fixture answering first must not silence one that needs ~1.2 s.
 const slow={key:'slow',url:'https://cdn.example.org/slow.mp4',type:'mp4',quality:'auto',rank:0};
 const sleeper=ms=>new Promise(r=>setTimeout(r,ms));
 globalThis.fetch=async url=>String(url).startsWith('https://cdn.example.org/')?new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}}):never();
 reg=new SourceRegistry(cfg);reg.adapters=[fake('fixture-fast',async()=>({candidates:[good]})),fake('fixture-slow',async()=>{await sleeper(1200);return{candidates:[slow]};})];
 start=Date.now();const fair=await reg.resolvePlayback({type:'movie',tmdbId:'999005'});const fairMs=Date.now()-start;
 const fairIds=(fair?.sources??[]).map(s=>s.sourceId);
 assert(fairIds.includes('fixture-fast'),`Fast fixture missing: ${fairIds.join(',')}`);
 if (!fairIds.includes('fixture-slow')) assert(fair?.pendingSources?.includes('fixture-slow'),`Slow fixture was neither listed nor left pending: ${JSON.stringify(fair?.pendingSources)}`);
 assert(fairMs<1800,`Fast first response was held by the late fixture: ${fairMs}ms`);

 console.log(`✓ Startup budget: fixture fast ${fastMs}ms, no sources ${failMs}ms, stalled verification ${probeMs}ms, current registry ${newSourcesMs}ms, trait fixture ${traitMs}ms, late join ${fairMs}ms.`);
}finally{globalThis.fetch=original;clearInterval(keepAlive)}
