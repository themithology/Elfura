// Regression: an adapter can finish after response candidates are assembled,
// while subtitles are being awaited. It must remain pending in that response.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
const tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-wave-race-'));
process.env.ROXY_DATA_DIR=tmp;
const original=globalThis.fetch;
const keepAlive=setInterval(()=>{},1000);
const never=()=>new Promise(()=>{});
let onProbe;
globalThis.fetch=async input=>{
  const url=String(input);
  if(url.startsWith('http://localhost:42424/'))return Response.json({title:'Fixture',imdb_id:'tt1234567'});
  if(url.startsWith('https://subs.example/'))return never();
  if(url.startsWith('https://cdn.example.org/')){onProbe?.();return new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}});}
  throw Error('unexpected network request');
};
const candidate=id=>({key:id,url:`https://cdn.example.org/${id}.mp4`,type:'mp4',quality:'auto',rank:0});
const adapter=(id,resolve)=>({id,label:id,enabled:()=>true,resolve});
try {
  const cfg=loadBackendConfig({ELFURA_SECRET:'test-secret',TMDB_API_BASE:'http://localhost:42424',OPENSUBTITLES_BASE:'https://subs.example',OPENSUBTITLES_ENABLED:'1'});
  // A source completing during a subtitle wait should be included in the first
  // coverage snapshot; that wait already existed and need not add latency.
  const firstCoverage=new SourceRegistry(cfg);let releaseDuringWait;
  const almostReady=new Promise(r=>releaseDuringWait=r);
  firstCoverage.adapters=[...['source-1','source-3','source-4'].map(id=>adapter(id,async()=>({candidates:[candidate(id)]}))),
    adapter('source-5',async()=>almostReady)];
  onProbe=()=>{onProbe=undefined;setTimeout(()=>releaseDuringWait({candidates:[candidate('source-5')]}),10);};
  const fuller=await firstCoverage.resolvePlayback({type:'movie',tmdbId:'97530'});
  assert(fuller?.sources.some(s=>s.sourceId==='source-5'),'a source ready during subtitle enrichment should be in the first list');

  const registry=new SourceRegistry(cfg);
  let release;
  const slow=new Promise(r=>release=r);
  registry.adapters=[...['source-1','source-3','source-4'].map(id=>adapter(id,async()=>({candidates:[candidate(id)]}))),
    adapter('source-5',async()=>slow)];
  // release only after selection/coverage has already collected the first list.
  const seal=registry.sealCandidate.bind(registry);let triggered=false;
  registry.sealCandidate=(...args)=>{if(!triggered){triggered=true;setTimeout(()=>release({candidates:[candidate('source-5')]}),10);}return seal(...args);};
  const first=await registry.resolvePlayback({type:'movie',tmdbId:'97531'});
  assert(first);
  assert(!first.sources.some(s=>s.sourceId==='source-5'),'fixture source should finish after candidates were selected');
  assert(first.pendingSources.includes('source-5'),'source completed after selection must remain pending for the next wave');
  await new Promise(r=>setTimeout(r,30));
  const late=await registry.resolvePlayback({type:'movie',tmdbId:'97531',late:true});
  assert(late?.sources.some(s=>s.sourceId==='source-5'),'the follow-up must return the missing source');

  // The same race can occur during a later hydration pass: do not announce a
  // source as complete based on the live stash if that pass took an older copy.
  const other=new SourceRegistry(cfg);let releaseNext;
  const otherSlow=new Promise(r=>releaseNext=r);
  other.adapters=[...['source-1','source-3','source-4'].map(id=>adapter(id,async()=>({candidates:[candidate(id)]}))),
    adapter('source-5',async()=>otherSlow)];
  const initial=await other.resolvePlayback({type:'movie',tmdbId:'97532'});
  assert(initial?.pendingSources.includes('source-5'));
  const otherSeal=other.sealCandidate.bind(other);let fired=false;
  other.sealCandidate=(...args)=>{if(!fired){fired=true;setTimeout(()=>releaseNext({candidates:[candidate('source-5')]}),10);}return otherSeal(...args);};
  const early=await other.resolvePlayback({type:'movie',tmdbId:'97532',late:true});
  assert(early && !early.sources.some(s=>s.sourceId==='source-5'));
  assert(early.pendingSources.includes('source-5'),'late response must retain a source arriving during assembly');
  await new Promise(r=>setTimeout(r,30));
  const following=await other.resolvePlayback({type:'movie',tmdbId:'97532',late:true});
  assert(following?.sources.some(s=>s.sourceId==='source-5'));
  console.log('late wave: sources finishing during first or later assembly remain pending and are returned');
} finally {globalThis.fetch=original;clearInterval(keepAlive);rmSync(tmp,{recursive:true,force:true});}
