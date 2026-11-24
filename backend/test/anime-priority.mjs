import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {selectPlaybackCandidates} from '../../dist/backend/sources/selection.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';

const original=globalThis.fetch;
const keepAlive=setInterval(()=>{},1000);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const adapter=(id,resolve)=>({id,label:id,enabled:()=>true,resolve});
const cand=(id,more={})=>({key:id,url:`https://anime-priority.example/${id}.mp4`,type:'mp4',quality:'auto',rank:0,...more});
const cfg=loadBackendConfig({ELFURA_SECRET:'test',TMDB_API_BASE:'http://localhost:42424',OPENSUBTITLES_ENABLED:'0'});
let requests=[];
globalThis.fetch=async input=>{
  const u=new URL(String(input));
  if(u.hostname==='localhost') {
    const anime=!u.pathname.includes('13571');
    return Response.json({name:'Fixture',original_language:anime?'ja':'en',genres:[{name:anime?'Animation':'Drama'}],images:{logos:[]},external_ids:{},episode_run_time:[24]});
  }
  requests.push(u.pathname);
  if(u.pathname.includes('dead'))return new Response('',{status:404});
  if(u.pathname.includes('unknown'))throw Error('network unavailable');
  return new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}});
};
try {
  // Slow anime lane joins the initial response even when ordinary sources are ready.
  const reg=new SourceRegistry(cfg);
  reg.adapters=[...['source-1','source-2','source-3'].map(id=>adapter(id,async()=>({candidates:[cand(id)]}))),
    adapter('source-28',async()=>{await wait(1800);return {candidates:[cand('28-live')]};}),
    adapter('source-29',async()=>({candidates:[cand('29-dead',{audioVariant:'sub'}),cand('29-unknown',{audioVariant:'dub'})]})),
    adapter('source-30',async()=>({candidates:[cand('30-live',{audioVariant:'sub'})]}))];
  const result=await reg.resolvePlayback({type:'tv',tmdbId:'13570',season:1,episode:1});
  assert(result);
  assert(result.sources.some(x=>x.sourceId==='source-28'&&x.animePriority));
  assert(result.sources.some(x=>x.sourceId==='source-30'&&x.animePriority));
  assert.deepEqual(result.sources.filter(x=>x.sourceId==='source-29').map(x=>x.audioVariant),['dub'],'dead variant must not be listed');
  const unknown=result.sources.find(x=>x.sourceId==='source-29');
  assert(unknown?.animeUnverified && !unknown.animePriority,'unverified variant survives without promotion');
  assert(['source-28','source-30'].includes(result.primary.sourceId));
  assert(result.sources.some(x=>x.sourceId==='source-1'),'other providers remain fallbacks');

  // The anime first-wave grace allows all three already-running priority
  // adapters to join rather than cutting them at the first fast response.
  const broad=new SourceRegistry(cfg);
  broad.adapters=[...['source-1','source-2','source-3'].map(id=>adapter(id,async()=>({candidates:[cand(`broad-${id}`)]}))),
    ...['source-28','source-29','source-30'].map((id,i)=>adapter(id,async()=>{await wait(2800+i*350);return {candidates:[cand(`broad-${id}`)]};}))];
  const broadFirst=await broad.resolvePlayback({type:'tv',tmdbId:'13577',season:1,episode:1});
  for(const id of ['source-28','source-29','source-30'])assert(broadFirst.sources.some(s=>s.sourceId===id),`${id} should join the anime first wave`);

  // Language matching beats anime source priority.
  const langReg=new SourceRegistry(cfg);
  langReg.adapters=[adapter('source-1',async()=>({candidates:[cand('hi',{audioLang:'hi'})]})),adapter('source-28',async()=>({candidates:[cand('anime-ja',{audioLang:'ja'})]}))];
  const lang=await langReg.resolvePlayback({type:'tv',tmdbId:'13572',season:1,episode:1,preferredLang:'hi'});
  assert.equal(lang.primary.sourceId,'source-1');

  // Mock anime-labelled adapters for a non-anime title: no ranking metadata.
  const non=new SourceRegistry(cfg);
  non.adapters=[adapter('source-1',async()=>({candidates:[cand('non-live',{multiAudio:true})]})),adapter('source-28',async()=>({candidates:[cand('non28')]}))];
  const ordinary=await non.resolvePlayback({type:'tv',tmdbId:'13571',season:1,episode:1});
  assert(ordinary.sources.every(x=>!x.animePriority&&!x.animeUnverified));

  const movie=await non.resolvePlayback({type:'movie',tmdbId:'13574'});
  assert(movie.sources.every(x=>!x.animePriority&&!x.animeUnverified));
  const laterSeason=await non.resolvePlayback({type:'tv',tmdbId:'13575',season:2,episode:1});
  assert(laterSeason.sources.every(x=>!x.animePriority&&!x.animeUnverified));

  const failedReg=new SourceRegistry(cfg);
  failedReg.adapters=[adapter('source-1',async()=>({candidates:[cand('fallback-live')]})),adapter('source-28',async()=>({candidates:[cand('priority-dead')]}))];
  const fallback=await failedReg.resolvePlayback({type:'tv',tmdbId:'13576',season:1,episode:1});
  assert.equal(fallback.primary.sourceId,'source-1');
  assert(!fallback.sources.some(x=>x.sourceId==='source-28'));

  // Anime candidates that finish after the bounded window remain recoverable.
  const lateReg=new SourceRegistry(cfg);let release;
  const pending=new Promise(r=>release=r);
  lateReg.adapters=[...['source-1','source-2','source-3'].map(id=>adapter(id,async()=>({candidates:[cand(`late-${id}`)]}))),adapter('source-29',async()=>pending)];
  const first=await lateReg.resolvePlayback({type:'tv',tmdbId:'13573',season:1,episode:1});
  assert(first.pendingSources.includes('source-29'));
  release({candidates:[cand('late29',{audioVariant:'sub'})]});await wait(20);
  const late=await lateReg.resolvePlayback({type:'tv',tmdbId:'13573',season:1,episode:1,late:true});
  assert(late.sources.some(x=>x.sourceId==='source-29'&&x.animePriority));

  // Probe scheduling gives priority lanes the first wave even against 25 multi-audio streams.
  requests=[];
  const others=Array.from({length:25},(_,i)=>cand(`bulk-${i}`,{multiAudio:true}));
  const priority=cand('priority-probe');
  await verifyAndFilterCandidatesDetailed([...others,priority],undefined,new Set([priority.url]));
  assert(requests.slice(0,20).includes('/priority-probe.mp4'));
  const unverifiedVariant=cand('select-unknown',{audioVariant:'sub'});
  assert(selectPlaybackCandidates([{adapter:adapter('source-30',()=>{}),candidate:unverifiedVariant}]).length===1);

  // Run the real player comparator, including late-list refresh and language changes.
  const bundled=await build({entryPoints:['src/core/player.ts'],bundle:true,platform:'node',format:'esm',write:false,external:['hls.js','dashjs']});
  const {ElfuraPlayer}=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const p=Object.create(ElfuraPlayer.prototype);
  p.failedSourceIds=new Set();p.failedFingerprints=new Set();p.currentSource=null;p.desiredAudioLang=null;p.currentAudio=null;p.emit=()=>{};
  const opt=(id,extra={})=>({id,sourceId:id,url:id,quality:'auto',audioTracks:[],...extra});
  p.sources=[opt('fallback',{audioLang:'en'}),opt('preferred',{animePriority:true,audioLang:'ja'}),opt('unknown',{animeUnverified:true})];
  p.sortSourcesForDisplay();assert.equal(p.sources[0].id,'preferred');
  p.sortSourcesForDisplay('en');assert.equal(p.sources[0].id,'fallback');
  p.sources=[opt('fallback',{audioLang:'en'}),opt('preferred',{animePriority:true,audioLang:'ja'})];
  p.reorderSourcesHierarchy();assert.equal(p.sources[0].id,'preferred');
  const prior=opt('source-29',{animeUnverified:true});
  assert(p.mergeSourceEvidence(prior,opt('source-29',{animePriority:true})));
  assert(prior.animePriority&&!prior.animeUnverified);
  assert(!p.mergeSourceEvidence(opt('source-1'),opt('source-29',{animePriority:true})));
  p.currentSource=p.sources.find(s=>s.id==='fallback');p.desiredAudioLang='en';
  p.sortSourcesForDisplay('en');assert.equal(p.sources[0].id,'fallback','current language stays selected on refresh');
  p.currentSource=null;p.desiredAudioLang=null;
  p.failedSourceIds.add('preferred');p.sortSourcesForDisplay();assert.equal(p.sources[0].id,'fallback');
  console.log('anime priority: initial, late, language, probes, fallback, confidence and non-anime passed');
} finally {globalThis.fetch=original;clearInterval(keepAlive);}
