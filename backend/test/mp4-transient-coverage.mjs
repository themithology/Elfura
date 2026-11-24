// Temporary MP4 probe failures are not proof a stream is gone. Exercise both
// the probe and the real registry, with RAM caching on and off in separate runs.
import assert from 'node:assert/strict';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';

const original = globalThis.fetch;
const keepAlive = setInterval(() => {}, 1000);
const lane = (suffix) => ({key:suffix,url:`https://mp4-flaky.example/${suffix}.mp4`,type:'mp4',quality:'auto',rank:0});
try {
  for (const status of [403,408,425,429,500,502,503,504,416]) {
    let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response('temporarily unavailable',{status,headers:{'content-type':'text/html'}});};
    const candidate=lane(`status-${status}`);
    const first=await verifyAndFilterCandidatesDetailed([candidate]);
    assert.equal(first.candidates.length,1,`MP4 HTTP ${status} must remain as an unverified fallback`);
    assert.equal(first.probedDead.size,0,`MP4 HTTP ${status} must not be recorded as dead`);
    assert.equal(first.verifiedAliveCount,0,`MP4 HTTP ${status} must not be advertised as verified`);
    globalThis.fetch=async()=>{calls++;return new Response(new Uint8Array(128),{status:206,headers:{'content-type':'video/mp4'}});};
    const recovered=await verifyAndFilterCandidatesDetailed([candidate]);
    assert.equal(recovered.verifiedAliveCount,1,`MP4 HTTP ${status} must not poison the liveness cache`);
    assert.equal(calls,2,'the second check actually reached the upstream');
  }
  for(const status of [404,410,451]) {
    globalThis.fetch=async()=>new Response('gone',{status});
    const result=await verifyAndFilterCandidatesDetailed([lane(`gone-${status}`)]);
    assert.equal(result.candidates.length,0,`MP4 HTTP ${status} remains confirmed dead`);
  }
  globalThis.fetch=async input=>{
    const url=String(input);
    if(url.includes('/blocked.'))return new Response('busy',{status:403});
    if(url.includes('/range.'))return new Response('range',{status:416});
    if(url.includes('/gone.'))return new Response('gone',{status:404});
    if(url.includes('/working.'))return new Response(new Uint8Array(128),{status:206,headers:{'content-type':'video/mp4'}});
    return new Response('',{status:404});
  };
  const registry=new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'mp4-test-secret',OPENSUBTITLES_ENABLED:'0',TMDB_API_KEY:''}));
  registry.adapters=['working','blocked','range','gone'].map((suffix,i)=>({id:`source-${i+1}`,label:`Source ${i+1}`,enabled:()=>true,resolve:async()=>({candidates:[lane(suffix)]})}));
  const result=await registry.resolvePlayback({type:'movie',tmdbId:'98765'});
  const ids=new Set(result?.sources.map(s=>s.sourceId));
  for(const id of ['source-1','source-2','source-3'])assert(ids.has(id),`${id} should reach the player`);
  assert(!ids.has('source-4'),'a confirmed 404 must not be reintroduced by the coverage pass');
  assert.equal(result.primary.sourceId,'source-1','verified stream is ranked before unverified fallbacks');
  console.log('MP4 coverage: temporary refusals retained unverified, recovery works, 404/410/451 removed');
} finally {globalThis.fetch=original;clearInterval(keepAlive);}
