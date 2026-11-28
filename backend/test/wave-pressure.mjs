import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {selectPlaybackCandidates} from '../../dist/backend/sources/selection.js';

const original=globalThis.fetch;
const keepAlive=setInterval(()=>{},1000);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const candidate=(id,title)=>({key:`${id}-${title}`,url:`https://waves.example/${title}/${id}.mp4`,type:'mp4',quality:'auto',rank:0});
const adapter=(id,resolve)=>({id,label:id,enabled:()=>true,resolve});
const cfg=loadBackendConfig({ELFURA_SECRET:'wave-pressure-secret',OPENSUBTITLES_ENABLED:'0',TMDB_API_KEY:''});
globalThis.fetch=async input=>String(input).startsWith('https://waves.example/')
 ? new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}})
 : new Response('',{status:404});
try {
 // A verified playable source should be returned quickly; slower adapters
 // remain in the pending late wave rather than holding up first playback.
 const broad=new SourceRegistry(cfg);
 broad.adapters=[...['fixture-fast-1','fixture-fast-2','fixture-fast-3'].map(id=>adapter(id,async q=>({candidates:[candidate(id,q.tmdbId)]}))),
   ...['fixture-slow-1','fixture-slow-2'].map(id=>adapter(id,async q=>{await wait(1800);return {candidates:[candidate(id,q.tmdbId)]};})),
   ...['fixture-hung-1','fixture-hung-2','fixture-hung-3'].map(id=>adapter(id,()=>new Promise(()=>{})))];
 const broadInitial=await broad.resolvePlayback({type:'movie',tmdbId:'39999'});
 assert(broadInitial.sources.some(x=>x.sourceId==='fixture-fast-1'),'a playable first-wave source is returned');
 assert(broadInitial.pendingSources.includes('fixture-slow-1')&&broadInitial.pendingSources.includes('fixture-slow-2'),
   'slow nearby sources remain discoverable in the late wave');

 // Memory stays bounded by payload size as well as title count; a stale
 // callback cannot recreate an evicted wave.
 const bounded=new SourceRegistry(cfg);
 const wa={expiresAt:Date.now()+60000,entries:new Map(),retried:new Set(),bytes:0};
 const wb={expiresAt:Date.now()+60000,entries:new Map(),retried:new Set(),bytes:0};
 const a=adapter('fixture-fast-1',async()=>({candidates:[]}));
 bounded.finishedLate.set('a',wa);bounded.finishedLate.set('b',wb);
 bounded.recordWaveResult('a',wa,a,{candidates:[{...candidate('a','1'),headers:{'X-Test':'x'.repeat(17*1024*1024)}}]});
 bounded.recordWaveResult('b',wb,a,{candidates:[{...candidate('b','1'),headers:{'X-Test':'y'.repeat(17*1024*1024)}}]});
 assert(bounded.finishedLateBytes<=32*1024*1024 && !bounded.finishedLate.has('a'));
 bounded.recordWaveResult('a',wa,a,{candidates:[candidate('stale','1')]});
 assert(!bounded.finishedLate.has('a'),'evicted wave cannot be resurrected');

 // A busy resolver with more than eight distinct titles must retain each
 // active wave; don't accidentally test only one title repeatedly.
 const reg=new SourceRegistry(cfg);const calls=new Map();
 reg.adapters=[...['fixture-fast-1','fixture-fast-3','fixture-slow-1'].map(id=>adapter(id,async q=>({candidates:[candidate(id,q.tmdbId)]}))),
   adapter('fixture-slow-late',async q=>{calls.set(q.tmdbId,(calls.get(q.tmdbId)??0)+1);await wait(3000);return {candidates:[candidate('fixture-slow-late',q.tmdbId)]};})];
 const burstStarted=Date.now();
 const first=await Promise.all(Array.from({length:12},(_,i)=>reg.resolvePlayback({type:'movie',tmdbId:String(40000+i)})));
 assert(first.every(x=>x?.pendingSources.includes('fixture-slow-late')));
 await wait(Math.max(0,3200-(Date.now()-burstStarted)));
 const late=await Promise.all(first.map((_,i)=>reg.resolvePlayback({type:'movie',tmdbId:String(40000+i),late:true})));
 assert(late.every(x=>x?.sources.some(s=>s.sourceId==='fixture-slow-late')),'late waves must survive a burst of distinct titles');
 assert.equal([...calls.values()].reduce((a,b)=>a+b,0),12);

 // Variant lanes from every provider survive selection; timed-out variants
 // are unverified fallbacks, while confirmed dead ones are not returned.
 const modes=[
   {adapter:adapter('fixture-variant-a',()=>{}),candidate:candidate('16-sub','1')},
   {adapter:adapter('fixture-variant-a',()=>{}),candidate:candidate('16-dub','1')},
   {adapter:adapter('fixture-variant-b',()=>{}),candidate:candidate('29-sub','1')},
   {adapter:adapter('fixture-variant-c',()=>{}),candidate:candidate('30-dub','1')},
   {adapter:adapter('fixture-variant-a',()=>{}),candidate:candidate('16-dead','1')},
 ].map((entry,i)=>({...entry,candidate:{...entry.candidate,audioVariant:i%2?'dub':'sub',...(i===4?{measuredThisRequest:{alive:false}}:{})}}));
 const variantResults=selectPlaybackCandidates(modes);
 assert.equal(variantResults.length,4);assert.equal(variantResults.filter(x=>x.adapter.id==='fixture-variant-a').length,2);
 assert(variantResults.every(x=>!x.candidate.measuredThisRequest?.alive),'unverified variants were not marked live');

 // An adapter may return one lane early, then report further lanes via callback.
 const partial=new SourceRegistry(cfg);
 partial.adapters=[adapter('fixture-fast-1',async q=>{
   setTimeout(()=>q.onLateResult?.({candidates:[candidate('early',q.tmdbId),candidate('extra',q.tmdbId)]}),300);
   return {candidates:[candidate('early',q.tmdbId)]};
 })];
 const initial=await partial.resolvePlayback({type:'movie',tmdbId:'50000'});
 assert.equal(initial.sources.length,1);
 await wait(400);
 const joined=await partial.resolvePlayback({type:'movie',tmdbId:'50000',late:true});
 assert.equal(joined?.sources.length,2,'late callback must update the wave even with payload cache disabled');

 // Empty providers get one shared asynchronous retry, not one retry per
 // viewer. Running providers and already nonempty providers are not restarted.
 const retry=new SourceRegistry(cfg);let attempts=0, steady=0;
 retry.adapters=[adapter('fixture-fast-1',async q=>{steady++;return {candidates:[candidate('steady',q.tmdbId)]};}),
   adapter('fixture-fast-3',async q=>{attempts++;return {candidates:attempts===1?[]:[candidate('recovered',q.tmdbId)]};})];
 const beforeRetry=await retry.resolvePlayback({type:'movie',tmdbId:'50001'});
 assert(beforeRetry && attempts===1);
 await Promise.all(Array.from({length:20},()=>retry.resolvePlayback({type:'movie',tmdbId:'50001',late:true,retryMissing:true})));
 await wait(30);
 const afterRetry=await retry.resolvePlayback({type:'movie',tmdbId:'50001',late:true});
 assert(afterRetry?.sources.some(s=>s.sourceId==='fixture-fast-3'));
 assert.equal(attempts,2,'twenty viewers cause one retry of the empty source');
 assert.equal(steady,1,'a nonempty source must not be rediscovered');

 // The actual player must request partial updates even when the same source
 // is already in the list and no entirely new source is pending.
 const bundled=await build({entryPoints:['src/core/player.ts'],bundle:true,platform:'node',format:'esm',write:false,external:['hls.js','dashjs']});
 const {ElfuraPlayer}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
 const p=Object.create(ElfuraPlayer.prototype);
 p.input={config:{tmdb:'50000',mediaType:'movie',api:'/api/v1/playback'}};
 p.sources=[{id:'source-1:1',sourceId:'source-1',fingerprint:'old',url:'/old',quality:'auto',audioTracks:[]}];
 p.pendingSourceGroups=[];p.lateHydrationToken=0;p.destroyed=false;p.failedFingerprints=new Set();p.failedSourceIds=new Set();p.audioTracks=[];p.currentSource=null;p.desiredAudioLang=null;p.currentAudio=null;p.measuredRttByFp=new Map();
 p.emit=()=>{};p.mergeNativeAudio=()=>{};let switched;
 p.currentSource=p.sources[0];p.currentSource.audioLang='en';p.desiredAudioLang='ja';p.setAudio=async lang=>{switched=lang;};
 globalThis.window={location:{href:'https://viewer.example/embed'}};
 let requested=0;
 globalThis.fetch=async input=>{assert.equal(new URL(input).searchParams.get('late'),'1');requested++;return Response.json({ok:true,pendingSources:[],sources:[{id:'source-1:2',sourceId:'source-1',fingerprint:'new',url:'/new',quality:'auto',audioLang:'ja',audioTracks:[]}]});};
 p.scheduleLateSourceHydration(x=>x,true);
 await wait(1600);
 assert.equal(requested,1,'the player must poll for partial-source additions');
 assert(p.sources.some(x=>x.fingerprint==='new'),'late addition must reach the UI list');
 assert.equal(switched,'ja','a newly confirmed preferred language can be selected');
 p.lateHydrationToken++;
 // A prewarmed episode must resume the same late-wave machinery.
 const next=Object.create(ElfuraPlayer.prototype);let scheduled;
 Object.assign(next,{
   destroyed:false,input:{config:{tmdb:'42',mediaType:'tv',season:1,episode:1}},episodeGeneration:0,resolveGeneration:0,lateHydrationToken:0,audioSearchSeq:0,engineLoadSeq:0,
   video:{pause(){},removeAttribute(){},load(){}},failedSourceIds:new Set(),failedFingerprints:new Set(),desiredAudioLang:'en',mediaInfo:null,
   prewarmedNext:{season:1,episode:2,sources:[{id:'source-1:1',sourceId:'source-1',url:'/video',quality:'auto',audioTracks:[]}],fastest:{id:'source-1:1',sourceId:'source-1',url:'/video',quality:'auto',audioTracks:[]},sourceGroups:['source-1','source-4'],pendingSources:['source-4'],waveUpdates:true},
   teardownEngine(){},recomputeNextEpisodeTarget(){},emit(){},fetchSeasonEpisodes:async()=>{},reorderSourcesHierarchy(){},activateSourceOption:async()=>{},playSelectedEpisode(){},
   scheduleLateSourceHydration(_resolve,partial){scheduled=partial;},
 });
 await next.loadEpisode(1,2);
 assert.equal(scheduled,true,'prewarmed episodes must hydrate late sources');
 assert.deepEqual(next.pendingSourceGroups,['source-4']);

 const nativeSetTimeout=globalThis.setTimeout;
 try {
   globalThis.setTimeout=(fn,ms,...args)=>nativeSetTimeout(fn,Math.min(ms,10),...args);
   const q=Object.create(ElfuraPlayer.prototype);
   Object.assign(q,{input:{config:{tmdb:'50002',mediaType:'movie',api:'/api/v1/playback'}},sources:[],pendingSourceGroups:[],lateHydrationToken:0,destroyed:false,failedFingerprints:new Set(),failedSourceIds:new Set(),audioTracks:[],currentSource:null,desiredAudioLang:null,currentAudio:null,measuredRttByFp:new Map(),emit:()=>{},mergeNativeAudio:()=>{}});
   let emptyAttempts=0;
   globalThis.fetch=async input=>{assert.equal(new URL(input).searchParams.get('late'),'1');emptyAttempts++;return emptyAttempts<2?new Response('',{status:404}):Response.json({ok:true,sources:[{id:'s'}]});};
   const emptyResult=await q.retryEmptyWave(new URL('https://viewer.example/api/v1/playback?tmdb=1'),{},new AbortController().signal);
   assert.equal(emptyResult?.status,200);assert.equal(emptyAttempts,2,'empty first wave checks the existing late discovery');
   const calls=[];
   globalThis.fetch=async input=>{const u=new URL(input);calls.push(u.searchParams.get('late'));return u.searchParams.has('late')?new Response('',{status:404}):Response.json({ok:true,sources:[{id:'fixture-fast-2:1',sourceId:'fixture-fast-2',fingerprint:'rescued',url:'/rescued',quality:'auto',audioTracks:[]}]});};
   q.scheduleLateSourceHydration(x=>x,true);
   await new Promise(r=>nativeSetTimeout(r,150));
   assert.deepEqual(calls,['1','1','1','1','1',null],'lost wave gets one full fallback, not a per-source storm');
   assert(q.sources.some(s=>s.fingerprint==='rescued'));
   q.lateHydrationToken++;
 } finally {globalThis.setTimeout=nativeSetTimeout;}
 console.log('wave pressure: 12 concurrent titles, cache-off callbacks, and partial UI updates passed');
} finally {globalThis.fetch=original;clearInterval(keepAlive);}
