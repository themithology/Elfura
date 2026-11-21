// Real SourceRegistry + resolver HTTP server, with deterministic provider
// fixtures. A source that never completes must not permanently reject viewers.
import assert from 'node:assert/strict';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { createResolverServer } from '../../dist/backend/resolver-server.js';

const oldLimit=process.env.ELFURA_RESOLVER_MAX_CONCURRENT;
delete process.env.ELFURA_RESOLVER_MAX_CONCURRENT;
const originalFetch=globalThis.fetch;
const originalWarn=console.warn;
const secret='registry-capacity-secret';
const never=()=>new Promise(()=>{});
const fast={key:'fast',url:'https://cdn.example.org/fast.mp4',type:'mp4',quality:'auto',rank:0};
const adapter=(id,resolve)=>({id,label:id,enabled:()=>true,resolve});
globalThis.fetch=async url=>String(url).startsWith('https://cdn.example.org/')
  ? new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}})
  : new Response('{}',{status:404,headers:{'content-type':'application/json'}});
console.warn=()=>{};
const cfg=loadBackendConfig({ELFURA_SECRET:secret,TMDB_API_KEY:'',TMDB_BEARER_TOKEN:'',OPENSUBTITLES_ENABLED:'0'});
const registry=new SourceRegistry(cfg);
registry.adapters=[adapter('source-1',async()=>({candidates:[fast]})),adapter('source-20',never)];
const {server}=createResolverServer({cfg,registry,token:secret,log:()=>{}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
const headers={'content-type':'application/json','x-elfura-resolver-token':secret};
const status=async()=>(await originalFetch(url+'/resolver/api/capacity',{headers})).json();
try {
  for(let wave=0;wave<2;wave++) {
    const responses=await Promise.all(Array.from({length:20},(_,i)=>originalFetch(url+'/resolver/api/playback',{
      method:'POST',headers,body:JSON.stringify({type:'movie',tmdbId:String(70000+wave*20+i)}),signal:AbortSignal.timeout(12000),
    })));
    assert.ok(responses.every(r=>r.status===200),`wave ${wave}: ${responses.map(r=>r.status).join(',')}`);
    const payloads=await Promise.all(responses.map(r=>r.json()));
    assert.ok(payloads.every(p=>p.ok && p.sources?.some(s=>s.sourceId==='source-1')),'the actual registry must return playable fixture sources');
    assert.ok(payloads.every(p=>p.pendingSources?.includes('source-20')),'the hung source remains available for late discovery');
    const info=await status();
    assert.equal(info.active,0);
    assert.equal(info.maxConcurrent,0);
    assert.equal(info.ready,true);
    assert.ok(info.backgroundPending>=20*(wave+1),'stuck background discovery is tracked but does not block the next wave');
  }
  console.log('real registry + resolver HTTP: 40 concurrent-wave playable fixture searches survive never-settling late sources');
} finally {
  globalThis.fetch=originalFetch; console.warn=originalWarn;
  if(oldLimit===undefined) delete process.env.ELFURA_RESOLVER_MAX_CONCURRENT; else process.env.ELFURA_RESOLVER_MAX_CONCURRENT=oldLimit;
  server.closeAllConnections(); await new Promise(r=>server.close(r));
}
