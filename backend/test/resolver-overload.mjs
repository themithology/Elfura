// Deterministic concurrency regression using the real resolver HTTP and probe paths.
import assert from 'node:assert/strict';
import {createResolverServer} from '../../dist/backend/resolver-server.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {ResolverCoalescer} from '../../dist/backend/resolver-coalescer.js';
import {ProbeGate} from '../../dist/backend/sources/probe-gate.js';
import {verifyAndFilterCandidatesDetailed,livenessWorkload} from '../../dist/backend/sources/liveness.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const gate=new ProbeGate(1,2),controller=new AbortController();
const first=await gate.acquire(controller.signal),waitAbort=new AbortController();
const waiting=gate.acquire(waitAbort.signal);waitAbort.abort();assert.equal(await waiting,null);assert.deepEqual(gate.snapshot(),{active:1,waiting:0,limit:1});first();first();assert.equal(gate.snapshot().active,0);

// Coalescing must not leak a result across language, episode, late or retry.
let calls=0;const groups=new ResolverCoalescer(async q=>{calls++;await sleep(25);return {ok:true,media:{type:q.type,tmdbId:q.tmdbId},sources:[],primary:null}});
const base={type:'tv',tmdbId:'123',season:1,episode:1};
await Promise.all([...Array(50)].map(()=>groups.run(base)));assert.equal(calls,1);
await Promise.all([groups.run(base),groups.run({...base,preferredLang:'ja'}),groups.run({...base,episode:2}),groups.run({...base,sourceId:'source-17'}),groups.run({...base,late:true}),groups.run({...base,late:true,retryMissing:true})]);assert.equal(calls,7);
await groups.run(base);assert.equal(calls,8,'no response payload retained after completion');
const bad=new ResolverCoalescer(async()=>{throw Error('fixture')});await assert.rejects(bad.run(base));assert.equal(bad.snapshot().activeKeys,0);
const invalidation=new ResolverCoalescer(async()=>{await sleep(25);return null});const one=invalidation.run(base);invalidation.invalidate();const two=invalidation.run(base);assert.notEqual(one,two);await Promise.all([one,two]);

// Multiple independent requests share the process-wide probe budget. A probe
// that cannot finish in budget is unverified, not removed as dead.
let active=0,peak=0,fetches=0;const original=globalThis.fetch;
globalThis.fetch=async (_input,init)=>{active++;peak=Math.max(peak,active);fetches++;try{await sleep(35);if(init.signal?.aborted)throw new Error('aborted');return new Response(new Uint8Array(64),{status:206,headers:{'content-type':'video/mp4'}})}finally{active--}};
try{
 const sets=Array.from({length:8},(_,n)=>Array.from({length:40},(_,i)=>({key:`${n}-${i}`,url:`https://load.example/${n}/${i}.mp4`,type:'mp4',quality:'auto',rank:1})));
 const results=await Promise.all(sets.map(c=>verifyAndFilterCandidatesDetailed(c,AbortSignal.timeout(2500))));
 assert.equal(fetches,320);assert(peak<=40,`expected <= 40 upstream probes, saw ${peak}`);assert(results.every(x=>x.candidates.length===40&&x.verifiedAliveCount===40));
 assert.deepEqual(livenessWorkload(),{active:0,waiting:0,limit:40});
 console.log(`probe pressure: 320 unique targets across 8 resolves; peak=${peak}, all 320 verified`);
}finally{globalThis.fetch=original}

// Exercise actual HTTP auth, workload metrics, coalescing and distinct requests.
const secret='fixture-resolver-overload-secret-12345',cfg=loadBackendConfig({ELFURA_SECRET:secret});let runs=0;
const registry={resolvePlayback:async q=>{runs++;await sleep(80);return {ok:true,media:{tmdbId:q.tmdbId},primary:null,sources:[]}},health:{setEnabled(){}},listPublicSources:()=>[{id:'source-1'}]};
const {server}=createResolverServer({cfg,registry,token:secret,log:()=>{}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
try{
 const headers={'content-type':'application/json','x-elfura-resolver-token':secret};
 const send=body=>fetch(url+'/resolver/api/playback',{method:'POST',headers,body:JSON.stringify(body)});
 const requests=[...Array.from({length:80},()=>send({type:'movie',tmdbId:'550'})),...Array.from({length:20},(_,i)=>send({type:'movie',tmdbId:String(600+i)}))];
 const responses=await Promise.all(requests);assert(responses.every(x=>x.status===200));assert.equal(runs,21,'80 same-title viewers must share one complete resolution');
 assert.equal((await fetch(url+'/resolver/api/workload')).status,401);
 const stats=await (await fetch(url+'/resolver/api/workload',{headers})).json();assert.equal(stats.playback.shared,79);assert.equal(stats.playback.activeKeys,0);assert(!JSON.stringify(stats).includes('550'));
 console.log('HTTP pressure: 100 viewers, 21 unique titles, 21 resolver computations; metrics authenticated');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
