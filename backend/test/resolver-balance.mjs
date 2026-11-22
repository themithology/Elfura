import assert from 'node:assert/strict';
import {createBalancedPlaybackResolver} from '../../dist/backend/playback-resolver-balanced.js';
import {ResolverUnavailableError} from '../../dist/backend/playback-resolver-remote.js';
import {resolverBackupConfig,resolverConfig,resolverFallbackReason} from '../../dist/backend/playback-resolver.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,what){for(let i=0;i<100;i++){if(await fn())return;await sleep(10);}throw Error(`timed out waiting for ${what}`);}
function mock(label){
  const state={calls:0,checks:0,authChecks:0,healthy:true,authenticated:true,fail:false,empty:false,toggles:0};
  return {label,state,
    async resolve(){state.calls++; if(state.handler)return state.handler();if(state.fail)throw new ResolverUnavailableError('offline');return state.empty?null:{ok:true,node:label};},
    async probe(){state.checks++;return {reachable:state.healthy,detail:'health'};},
    async authProbe(){state.authChecks++;return {authenticated:state.authenticated,detail:'auth'};},
    async sourceStatus(){return [];},
    async setSourceEnabled(){state.toggles++;return true;},
  };
}
const a=mock('a'),b=mock('b'),c=mock('c');
const pool=createBalancedPlaybackResolver(a,b,{additionalClients:[c],healthIntervalMs:30,budgetMs:200,log:()=>{}});
const request={type:'movie',tmdbId:'1'};
try {
  const got=[];for(let i=0;i<9;i++)got.push((await pool.resolve(request)).node);
  assert.deepEqual(got,['a','b','c','a','b','c','a','b','c']);
  a.state.fail=true;a.state.healthy=false;
  assert.equal((await pool.resolve(request)).node,'b');
  const after=a.state.calls;
  const remaining=[];for(let i=0;i<6;i++)remaining.push((await pool.resolve(request)).node);
  assert.deepEqual(remaining,['b','c','b','c','b','c']);
  assert.equal(a.state.calls,after,'no playback to down node');
  assert.equal(await pool.setSourceEnabled('source-1',true),false);
  assert.equal(a.state.toggles,0,'no source writes to down node');
  await until(()=>a.state.checks>=2,'background checks without traffic');
  assert.equal(a.state.calls,after);
  a.state.healthy=true;a.state.fail=false;
  await until(async()=> (await pool.probe()).nodes[0].available,'recovery');
  const recovered=[];for(let i=0;i<6;i++)recovered.push((await pool.resolve(request)).node);
  assert.equal(recovered.filter(x=>x==='a').length,2);
  const one={...request,lateAffinityKey:'session-1'},two={...request,lateAffinityKey:'session-2'};
  const owner=(await pool.resolve(one)).node;
  await pool.resolve(two);
  assert.equal((await pool.resolve({...one,late:true})).node,owner);
  await pool.resolve({...one,sourceId:'source-29'});
  assert.equal((await pool.resolve({...one,late:true})).node,owner);
  // Health may answer even when playback fails: the node must stay paused
  // until two later health checks, not get called repeatedly by retries.
  for(const n of [a,b,c]) {n.state.fail=true;n.state.healthy=false;}
  await assert.rejects(pool.resolve(request),{name:'ResolverUnavailableError'});
  const counts=[a,b,c].map(n=>n.state.calls);
  await assert.rejects(pool.resolve(request),{name:'ResolverUnavailableError'});
  assert.deepEqual([a,b,c].map(n=>n.state.calls),counts,'all-down cannot send playback');
  b.state.healthy=true;b.state.fail=false;
  await until(async()=> (await pool.probe()).nodes[1].available,'one node recovered');
  assert.equal((await pool.resolve(request)).node,'b');
  assert.deepEqual([a,c].map(n=>n.state.calls),[counts[0],counts[2]]);
} finally {pool.close();}

// Four nodes retain equal routing, skip each failed node, and recover solely
// through periodic checks even after the whole pool went down.
const four=[mock('one'),mock('two'),mock('three'),mock('four')];
const pool4=createBalancedPlaybackResolver(four[0],four[1],{additionalClients:four.slice(2),healthIntervalMs:30,log:()=>{}});
try {
  const first=[];for(let i=0;i<8;i++)first.push((await pool4.resolve(request)).node);
  assert.deepEqual(first,['one','two','three','four','one','two','three','four']);
  for(let i=0;i<3;i++)await pool4.resolve({...request,lateAffinityKey:`other-${i}`});
  const fourthSession={...request,lateAffinityKey:'fourth-session'};
  assert.equal((await pool4.resolve(fourthSession)).node,'four');
  assert.equal((await pool4.resolve({...fourthSession,late:true})).node,'four');
  assert.equal((await pool4.resolve({...fourthSession,sourceId:'source-1'})).node,'four');
  four[3].state.fail=true;four[3].state.healthy=false;
  for(let i=0;i<4;i++)await pool4.resolve(request);
  const stopped=four[3].state.calls;
  const survivors=[];for(let i=0;i<6;i++)survivors.push((await pool4.resolve(request)).node);
  assert.equal(four[3].state.calls,stopped);
  for(const name of ['one','two','three'])assert.equal(survivors.filter(n=>n===name).length,2);
  four[2].state.fail=true;four[2].state.healthy=false;
  for(let i=0;i<3;i++)await pool4.resolve(request);
  const two=[];for(let i=0;i<6;i++)two.push((await pool4.resolve(request)).node);
  assert.equal(two.filter(n=>n==='one').length,3);assert.equal(two.filter(n=>n==='two').length,3);
  four[1].state.fail=true;four[1].state.healthy=false;
  for(let i=0;i<2;i++)assert.equal((await pool4.resolve(request)).node,'one');
  four[0].state.fail=true;four[0].state.healthy=false;
  await assert.rejects(pool4.resolve(request),{name:'ResolverUnavailableError'});
  const counts=four.map(n=>n.state.calls);
  await assert.rejects(pool4.resolve(request),{name:'ResolverUnavailableError'});
  assert.deepEqual(four.map(n=>n.state.calls),counts,'all-down requests must not hit any resolver');
  four[3].state.healthy=true;four[3].state.fail=false;
  await until(async()=> (await pool4.probe()).nodes[3].available,'fourth resolver recovery');
  assert.equal((await pool4.resolve(request)).node,'four');
  assert.deepEqual(four.slice(0,3).map(n=>n.state.calls),counts.slice(0,3));
} finally {pool4.close();}

// Source-specific enrichment belongs to the same owner as the initial
// discovery, so it can reuse that resolver's in-flight work and cache.
const r1=mock('r1'),r2=mock('r2'),r3=mock('r3');
const recoveryPool=createBalancedPlaybackResolver(r1,r2,{additionalClients:[r3],healthIntervalMs:10000,log:()=>{}});
try {
  const title={...request,lateAffinityKey:'recovery-viewer'};
  assert.equal((await recoveryPool.resolve(title)).node,'r1');
  assert.equal((await recoveryPool.resolve({...request,lateAffinityKey:'other-viewer'})).node,'r2');
  assert.equal((await recoveryPool.resolve({...title,sourceId:'source-29'})).node,'r1','source-specific recovery must use the discovery owner');
  assert.equal((await recoveryPool.resolve({...title,late:true})).node,'r1');
  assert.equal(r3.state.calls,0,'recovery must not start fresh discovery on another node');
  r1.state.fail=true;
  assert.equal((await recoveryPool.resolve({...title,sourceId:'source-29'})).node,'r2','recovery may fail over to a healthy peer');
  const failedCalls=r1.state.calls;
  await recoveryPool.resolve({...title,sourceId:'source-29'});
  await recoveryPool.resolve({...title,late:true});
  assert.equal(r1.state.calls,failedCalls,'neither recovery nor late requests may hit an unavailable owner');
} finally {recoveryPool.close();}

// A health endpoint can be healthy while playback fails: no immediate repeat,
// and recovery checks cannot guarantee that the next playback will work.
const h=mock('h'),j=mock('j');h.state.fail=true;
const pingOnly=createBalancedPlaybackResolver(h,j,{healthIntervalMs:40,log:()=>{}});
try {
  assert.equal((await pingOnly.resolve(request)).node,'j');
  const calls=h.state.calls;
  for(let k=0;k<4;k++)assert.equal((await pingOnly.resolve(request)).node,'j');
  assert.equal(h.state.calls,calls);
  await until(async()=> (await pingOnly.probe()).nodes[0].available,'healthy probes after playback failure');
  for(let k=0;k<2;k++) assert.equal((await pingOnly.resolve(request)).node,'j'); // h is tried once and fails
  assert.equal(h.state.calls,calls+1);
} finally {pingOnly.close();}

// Idle nodes are removed by probes, without waiting for a viewer to hit them.
const idle=mock('idle'),live=mock('live');idle.state.healthy=false;
const watched=createBalancedPlaybackResolver(idle,live,{healthIntervalMs:25,log:()=>{}});
try {
  await until(async()=> !(await watched.probe()).nodes[0].available,'idle health failure');
  assert.equal((await watched.resolve(request)).node,'live');assert.equal(idle.state.calls,0);
} finally {watched.close();}

// A very slow failed first attempt is not duplicated speculatively and a peer
// is not poisoned by the tiny remaining timeout window.
const slow=mock('slow'),peer=mock('peer');
slow.state.handler=async()=>{await sleep(150);throw new ResolverUnavailableError('timeout',true);};
const bounded=createBalancedPlaybackResolver(slow,peer,{budgetMs:200,healthIntervalMs:10000,log:()=>{}});
try {
  const pending=bounded.resolve(request);await sleep(30);assert.equal(peer.state.calls,0,'no speculative hedge');
  await assert.rejects(pending);assert.equal(peer.state.calls,0,'no starved retry');
  assert.equal((await bounded.probe()).nodes[1].available,true);
  assert.equal((await bounded.resolve(request)).node,'peer');
} finally {bounded.close();}

// A valid empty result is not a failure and must not fan out.
const empty=mock('empty'),unused=mock('unused');empty.state.empty=true;
const noFanout=createBalancedPlaybackResolver(empty,unused,{healthIntervalMs:10000,log:()=>{}});
try {assert.equal(await noFanout.resolve(request),null);assert.equal(unused.state.calls,0);}
finally {noFanout.close();}

// A check started before a playback failure cannot clear that later failure.
const p=mock('p'),q=mock('q');let releaseProbe, probeStarted;
const started=new Promise(r=>probeStarted=r);
p.probe=async()=>{probeStarted();return new Promise(r=>releaseProbe=r);};
const staleCheck=createBalancedPlaybackResolver(p,q,{healthIntervalMs:20,log:()=>{}});
try {
  await Promise.race([started,sleep(100).then(()=>{throw Error('probe did not start');})]);p.state.fail=true;
  assert.equal((await staleCheck.resolve(request)).node,'q');
  releaseProbe({reachable:true,detail:'old response'});await sleep(5);
  assert.equal(p.state.calls,1);
  for(let k=0;k<3;k++)assert.equal((await staleCheck.resolve(request)).node,'q');
  assert.equal(p.state.calls,1,'stale probe must not restore failed node');
} finally {staleCheck.close();}

// No arbitrary admission limit: concurrent requests are still shared equally.
const u=mock('u'),v=mock('v'),w=mock('w');let release;
const gate=new Promise(r=>release=r);
for(const item of [u,v,w]) item.state.handler=async()=>{await gate;return {ok:true,node:item.label};};
const concurrent=createBalancedPlaybackResolver(u,v,{additionalClients:[w],healthIntervalMs:10000,log:()=>{}});
try {
  const pending=Array.from({length: 90},()=>concurrent.resolve(request));
  assert.deepEqual([u,v,w].map(n=>n.state.calls),[30,30,30]);
  release();assert.equal((await Promise.all(pending)).length,90);
} finally {concurrent.close();}

// A late, older in-flight failure must not undo a newer successful result.
const x=mock('x'),y=mock('y');let rejectOld;
x.state.handler=()=>new Promise((_,reject)=>rejectOld=reject);
const race=createBalancedPlaybackResolver(x,y,{healthIntervalMs:10000,log:()=>{}});
try {
  const old=race.resolve(request); await race.resolve(request); // x pending; y answers
  x.state.handler=async()=>({ok:true,node:'x'});
  assert.equal((await race.resolve(request)).node,'x');
  rejectOld(new ResolverUnavailableError('old failure'));
  assert.equal((await old).node,'y');
  assert.equal((await race.probe()).nodes[0].available,true);
} finally {race.close();}

// A stale success must not revive a node which a newer request marked down.
const m=mock('m'),n=mock('n');let resolveOld;
m.state.handler=()=>new Promise(resolve=>resolveOld=resolve);
const stale=createBalancedPlaybackResolver(m,n,{healthIntervalMs:10000,log:()=>{}});
try {
  const old=stale.resolve(request);await stale.resolve(request);
  m.state.handler=async()=>{throw new ResolverUnavailableError('new failure');};
  assert.equal((await stale.resolve(request)).node,'n');
  resolveOld({ok:true,node:'m'});await old;
  assert.equal((await stale.probe()).nodes[0].available,false);
} finally {stale.close();}

assert.ok(resolverBackupConfig({ELFURA_RESOLVER_FOURTH_URL:'https://four.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'},'fourth'));
assert.equal(resolverBackupConfig({ELFURA_RESOLVER_FOURTH_URL:'https://four.example'},'fourth'),null);
assert.equal(resolverBackupConfig({ELFURA_RESOLVER_FOURTH_URL:'https://user:pass@four.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'},'fourth'),null);
assert.ok(resolverBackupConfig({ELFURA_RESOLVER_THIRD_URL:'https://three.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'},'third'));
assert.equal(resolverBackupConfig({ELFURA_RESOLVER_THIRD_URL:'https://three.example'},'third'),null);
assert.equal(resolverBackupConfig({ELFURA_RESOLVER_THIRD_URL:'https://user:pass@three.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'},'third'),null);
resolverConfig({ELFURA_RESOLVER_URL:'wrong'});const reason=resolverFallbackReason();
resolverBackupConfig({ELFURA_RESOLVER_THIRD_URL:'https://three.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'},'third');
assert.equal(resolverFallbackReason(),reason);
console.log('resolver pool: equal distribution, down-only checks, recovery, all-down, affinity and concurrency OK');
