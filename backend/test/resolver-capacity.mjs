import assert from 'node:assert/strict';
import { createResolverServer } from '../../dist/backend/resolver-server.js';
import { RemotePlaybackResolver } from '../../dist/backend/playback-resolver-remote.js';

const previous=process.env.ELFURA_RESOLVER_MAX_CONCURRENT;
process.env.ELFURA_RESOLVER_MAX_CONCURRENT='1';
const secret='capacity-fixture-secret';
const releases=[];
const backgroundReleases=[];
let calls=0;
const registry={
  listPublicSources:()=>[], health:{snapshot:()=>[],setEnabled:()=>{}},
  resolvePlayback:async(request)=>{
    calls++;
    request.onDiscoverySettled(new Promise(r=>backgroundReleases.push(r)));
    await new Promise(r=>releases.push(r));
    return {ok:true,sources:[]};
  },
};
const {server}=createResolverServer({cfg:{},registry,token:secret,log:()=>{}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}`;
const headers={'content-type':'application/json','x-elfura-resolver-token':secret};
const body=JSON.stringify({type:'movie',tmdbId:'1'});
const capacity=async()=>(await fetch(url+'/resolver/api/capacity',{headers})).json();
try {
  assert.equal((await fetch(url+'/resolver/api/capacity')).status,401,'capacity is authenticated');
  const controller=new AbortController();
  const first=fetch(url+'/resolver/api/playback',{method:'POST',headers,body,signal:controller.signal}).catch(()=>null);
  for(let i=0;i<50 && !releases.length;i++) await new Promise(r=>setTimeout(r,10));
  assert(releases.length,'first request must enter provider work');
  assert.deepEqual(await capacity(),{ok:true,active:1,backgroundPending:1,maxConcurrent:1,ready:false});
  const blocked=await fetch(url+'/resolver/api/playback',{method:'POST',headers,body});
  assert.equal(blocked.status,503); assert.equal(blocked.headers.get('retry-after'),'5');
  assert.equal((await blocked.json()).reason,'resolver-busy');
  assert.equal(calls,1,'rejected work never reaches the registry');
  const remote=new RemotePlaybackResolver(url,secret,()=>{});
  await assert.rejects(remote.resolve({type:'movie',tmdbId:'1'}),{name:'ResolverBusyError'});
  controller.abort(); await first;
  await new Promise(r=>setTimeout(r,50));
  assert.equal((await capacity()).active,1,'disconnect does not release a slot while provider work continues');
  assert.equal((await fetch(url+'/resolver/api/playback',{method:'POST',headers,body})).status,503);
  releases[0]();
  for(let i=0;i<50 && (await capacity()).active;i++) await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(await capacity(),{ok:true,active:0,backgroundPending:1,maxConcurrent:1,ready:true},'background work is observable without trapping the admission slot');
  const second=fetch(url+'/resolver/api/playback',{method:'POST',headers,body});
  for(let i=0;i<50 && releases.length<2;i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(releases.length,2,'a stuck late source must not lock out the next viewer');
  releases[1](); assert.equal((await second).status,200);
  backgroundReleases.forEach(r=>r());
  for(let i=0;i<50 && (await capacity()).backgroundPending;i++) await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(await capacity(),{ok:true,active:0,backgroundPending:0,maxConcurrent:1,ready:true});
  console.log('resolver admission: opt-in foreground limit, busy response, disconnect and background accounting OK');
} finally {
  if(previous===undefined) delete process.env.ELFURA_RESOLVER_MAX_CONCURRENT; else process.env.ELFURA_RESOLVER_MAX_CONCURRENT=previous;
  server.closeAllConnections(); await new Promise(r=>server.close(r));
}
