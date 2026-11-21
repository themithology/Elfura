import assert from 'node:assert/strict';
import http from 'node:http';
import { createBalancedPlaybackResolver } from '../../dist/backend/playback-resolver-balanced.js';
import { RemotePlaybackResolver, ResolverUnavailableError } from '../../dist/backend/playback-resolver-remote.js';
import { createResilientPlaybackResolver, resolverBackupConfig, resolverConfig, resolverFallbackReason } from '../../dist/backend/playback-resolver.js';

function server(id) {
  const state = { id, mode: 'ok', calls: 0, changes: 0, token: 'shared-token', delay: 0 };
  const srv = http.createServer((req, res) => {
    if (req.url === '/resolver/api/health') return res.end(JSON.stringify({ok:true,sources:['source-1']}));
    if (req.headers['x-elfura-resolver-token'] !== state.token) {res.writeHead(401); return res.end(JSON.stringify({error:'unauthorized'}));}
    if (req.url === '/resolver/api/sources') {
      if (req.method === 'POST') state.changes++;
      return res.end(JSON.stringify({sources:[{id:'source-1'}]}));
    }
    if (req.url !== '/resolver/api/playback') {res.writeHead(404); return res.end();}
    state.calls++;
    if (state.mode === 'disconnect') return req.socket.destroy();
    if (state.mode === 'fail') {res.writeHead(503); return res.end(JSON.stringify({error:'down'}));}
    if (state.mode === 'invalid') {res.writeHead(400); return res.end(JSON.stringify({error:'bad request'}));}
    if (state.mode === 'limited') {res.writeHead(429); return res.end(JSON.stringify({error:'rate limited'}));}
    const body = state.mode === 'empty' ? {ok:false} : {ok:true,node:id};
    setTimeout(() => res.end(JSON.stringify(body)), state.delay);
  });
  return new Promise(resolve => srv.listen(0,'127.0.0.1',()=>resolve({state,srv,url:`http://127.0.0.1:${srv.address().port}`})));
}
const a = await server('a'), b = await server('b');
try {
  const client = n => new RemotePlaybackResolver(n.url, 'shared-token', () => {});
  let now = 1000;
  const pool = createBalancedPlaybackResolver(client(a), client(b), {now:()=>now, cooldownMs:30000, log:()=>{}});
  const request = {type:'movie',tmdbId:'1'};
  const results = await Promise.all(Array.from({length:20},()=>pool.resolve(request)));
  assert.equal(results.filter(x=>x.node === 'a').length,10);
  assert.equal(results.filter(x=>x.node === 'b').length,10);
  // Outage switches to peer, and cooldown avoids repeated requests to it.
  a.state.mode = 'fail';
  assert.equal((await pool.resolve(request)).node,'b');
  const failedCalls = a.state.calls;
  for (let i=0;i<4;i++) assert.equal((await pool.resolve(request)).node,'b');
  assert.equal(a.state.calls,failedCalls,'failed resolver should be skipped in cooldown');
  a.state.mode = 'ok'; now += 30001;
  const recovered = [];
  for (let i=0;i<4;i++) recovered.push((await pool.resolve(request)).node);
  assert.equal(recovered.filter(x=>x==='a').length,2);
  assert.equal(recovered.filter(x=>x==='b').length,2);
  assert.equal((await pool.probe()).reachable,true);
  const diagnostics=await pool.probe();
  assert.equal(diagnostics.detail,'resolver pool: 2/2 reachable and authenticated');
  assert.equal(diagnostics.nodes.length,2);
  assert.ok(diagnostics.nodes.every(n=>n.authenticated && n.attempts>0));
  assert.ok(diagnostics.nodes[0].failures>0);
  assert.equal(await pool.setSourceEnabled('source-1',false),true);
  assert.equal(a.state.changes,1); assert.equal(b.state.changes,1);
  b.state.token='other';
  assert.equal(await pool.setSourceEnabled('source-1',true),false,'partial switch must be reported');
  assert.equal(a.state.changes,2); assert.equal(b.state.changes,1);
  b.state.token='shared-token';
  // An empty search and invalid requests are answers, not an outage.
  const solo = createBalancedPlaybackResolver(client(a),client(b),{log:()=>{}});
  a.state.mode='empty'; const before=b.state.calls;
  assert.equal(await solo.resolve(request),null); assert.equal(b.state.calls,before);
  a.state.mode='invalid';
  const invalid = createBalancedPlaybackResolver(client(a),client(b),{log:()=>{}});
  assert.equal(await invalid.resolve(request),null); assert.equal(b.state.calls,before);
  // Authentication failure and Cloudflare rate limits must try the other node,
  // rather than masquerading as a title with no sources.
  a.state.mode='ok';
  const badToken = createBalancedPlaybackResolver(new RemotePlaybackResolver(a.url,'wrong',()=>{}),client(b),{log:()=>{}});
  assert.equal((await badToken.resolve(request)).node,'b');
  const authStatus=await badToken.probe();
  assert.equal(authStatus.nodes[0].authenticated,false);
  assert.match(authStatus.nodes[0].detail,/401/);
  assert.equal(authStatus.nodes[1].authenticated,true);
  assert.equal(authStatus.detail,'resolver pool: 1/2 reachable and authenticated');
  a.state.mode='limited';
  const limited=createBalancedPlaybackResolver(client(a),client(b),{log:()=>{}});
  assert.equal((await limited.resolve(request)).node,'b');
  a.state.mode='disconnect'; b.state.mode='disconnect';
  const bothDown = createResilientPlaybackResolver({remote:createBalancedPlaybackResolver(client(a),client(b),{log:()=>{}})});
  await assert.rejects(bothDown.resolve(request),{name:'ResolverBackendDownError'});
  // Late discovery is local to the node that served the initial request. Even
  // with interleaved viewers, late calls must not follow round-robin to a node
  // whose in-memory stash cannot contain that player's slow anime sources.
  a.state.mode='ok'; b.state.mode='ok';
  const sticky = createBalancedPlaybackResolver(client(a),client(b),{log:()=>{}});
  const one = {...request, lateAffinityKey:'title|session-one'};
  const two = {...request, lateAffinityKey:'title|session-two'};
  assert.equal((await sticky.resolve(one)).node,'a');
  assert.equal((await sticky.resolve(two)).node,'b');
  assert.equal((await sticky.resolve({...one,late:true})).node,'a');
  assert.equal((await sticky.resolve({...two,late:true})).node,'b');
  // A source-specific recovery must not overwrite the main discovery route.
  await sticky.resolve({...one,sourceId:'source-29'});
  assert.equal((await sticky.resolve({...one,late:true})).node,'a');
  // If the pinned node is unavailable, the ordinary failover path still works.
  a.state.mode='fail';
  assert.equal((await sticky.resolve({...one,late:true})).node,'b');
  // Blackholed first node, healthy but non-instant second node. The old code
  // spent almost the entire budget on A and left B too little time to resolve.
  a.state.mode='ok'; b.state.mode='ok'; a.state.delay=2000; b.state.delay=300;
  let hedgeNow=1000;
  const hedged = createBalancedPlaybackResolver(client(a),client(b),{now:()=>hedgeNow,budgetMs:800,hedgeDelayMs:100,cooldownMs:30000,log:()=>{}});
  const hedgeStarted=Date.now();
  assert.equal((await hedged.resolve(request)).node,'b');
  assert.ok(Date.now()-hedgeStarted<750,'healthy backup should have time to answer');
  const aAfterHedge=a.state.calls;
  assert.equal((await hedged.resolve(request)).node,'b');
  assert.equal(a.state.calls,aAfterHedge+1,'slow primary may hedge to the stalled peer as a last resort');
  await new Promise(r=>setTimeout(r,160));
  const hedgeStatus=await hedged.probe();
  assert.ok(hedgeStatus.nodes[0].failures>0 && hedgeStatus.nodes[0].cooldownMs>0,'a genuine timeout enters cooldown');
  const aDuringCooldown=a.state.calls;
  assert.equal((await hedged.resolve(request)).node,'b');
  assert.equal(a.state.calls,aDuringCooldown+1,'a slow primary may hedge even onto a cooling peer');
  a.state.delay=0; hedgeNow+=30001;
  const recoveredAfterStall=[];
  for(let i=0;i<4;i++) recoveredAfterStall.push((await hedged.resolve(request)).node);
  assert.ok(recoveredAfterStall.includes('a'),'a recovered node should rejoin after cooldown');
  assert.equal((await hedged.probe()).nodes[0].cooldownMs,0);
  // Exercise the same timeout when the backup is the failed first choice.
  a.state.delay=300; b.state.delay=2000;
  const reversed=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:800,hedgeDelayMs:100,log:()=>{}});
  assert.equal((await reversed.resolve(request)).node,'a');
  assert.equal((await reversed.resolve(request)).node,'a');
  // A slow but healthy node must not be marked down just because the other
  // node answered the hedged request first.
  a.state.delay=450; b.state.delay=20;
  const healthySlow=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:900,hedgeDelayMs:50,log:()=>{}});
  assert.equal((await healthySlow.resolve(request)).node,'b');
  await new Promise(r=>setTimeout(r,500));
  assert.equal((await healthySlow.probe()).nodes[0].failures,0);
  // A quick empty answer from a hedged peer must not hide the first node's
  // still-pending real result.
  a.state.delay=160; b.state.delay=10; b.state.mode='empty';
  const noFalseEmpty=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:800,hedgeDelayMs:40,log:()=>{}});
  assert.equal((await noFalseEmpty.resolve(request)).node,'a');
  // A late request must prefer its original stash owner, even when the peer
  // could return an immediate successful but empty late payload.
  a.state.delay=0; b.state.mode='ok'; b.state.delay=0;
  const lateSlow=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:800,hedgeDelayMs:40,log:()=>{}});
  const lateRequest={...request,lateAffinityKey:'slow-late'};
  assert.equal((await lateSlow.resolve(lateRequest)).node,'a');
  a.state.delay=160;
  const beforeLate=b.state.calls;
  assert.equal((await lateSlow.resolve({...lateRequest,late:true})).node,'a');
  assert.equal(b.state.calls,beforeLate+1,'a late hedge is allowed, but its answer cannot replace the stash owner');
  a.state.delay=2000; b.state.delay=100;
  assert.equal((await lateSlow.resolve({...lateRequest,late:true})).node,'b','when the stash owner fails, a completed peer answer is available');
  // A previous transient failure put B in cooldown, then A blackholes while B
  // recovers. B still needs enough time to answer before the overall deadline.
  a.state.mode='ok'; a.state.delay=0; b.state.mode='fail'; b.state.delay=0;
  const cooledPeer=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:800,hedgeDelayMs:100,log:()=>{}});
  assert.equal((await cooledPeer.resolve(request)).node,'a');
  assert.equal((await cooledPeer.resolve(request)).node,'a'); // B fails and cools.
  a.state.delay=2000; b.state.mode='ok'; b.state.delay=300;
  assert.equal((await cooledPeer.resolve(request)).node,'b','recovered cooldown peer needs a full hedge window');
  // A previously hedged A is still in flight. If B then stalls, a new request
  // must not wait for B to time out before trying the now-healthy A.
  a.state.delay=2000; b.state.delay=100;
  const busyPeer=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:800,hedgeDelayMs:100,log:()=>{}});
  assert.equal((await busyPeer.resolve(request)).node,'b');
  a.state.delay=300; b.state.delay=2000;
  assert.equal((await busyPeer.resolve(request)).node,'a','busy peer must still get time to answer');
  // If both were in cooldown, one recovery must still be tried rather than
  // only rechecking the still-dead node.
  a.state.delay=0; b.state.delay=0; a.state.mode='fail'; b.state.mode='fail';
  const recovering=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:800,hedgeDelayMs:50,log:()=>{}});
  await assert.rejects(recovering.resolve(request));
  b.state.mode='ok';
  assert.equal((await recovering.resolve(request)).node,'b');
  // If the event loop stalls until almost the overall deadline, a peer gets
  // only the remaining budget. Its short timeout is not evidence it is down.
  const healthClient={probe:async()=>({reachable:true}),authProbe:async()=>({authenticated:true})};
  const delayedFailure={...healthClient,label:'delayed',resolve:async()=>{
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,320);
    throw new ResolverUnavailableError('offline');
  }};
  const starvedPeer={...healthClient,label:'starved',resolve:async(_request,ms)=>{
    await new Promise(r=>setTimeout(r,ms));
    throw new ResolverUnavailableError('timeout',true);
  }};
  const starvation=createBalancedPlaybackResolver(delayedFailure,starvedPeer,{budgetMs:400,hedgeDelayMs:50,log:()=>{}});
  await assert.rejects(starvation.resolve(request));
  assert.equal((await starvation.probe()).nodes[1].failures,0,'a starved timeout must not poison node health');
  // Slow failures cannot add two full independent timeout windows.
  a.state.mode='ok'; b.state.mode='ok'; a.state.delay=500; b.state.delay=500;
  const bounded = createBalancedPlaybackResolver(client(a),client(b),{budgetMs:180,log:()=>{}});
  const start=Date.now(); await assert.rejects(bounded.resolve(request));
  assert.ok(Date.now()-start < 450,'pooled call exceeded its overall deadline');
  assert.ok(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'https://two.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1',ELFURA_SECRET:'shared'}));
  assert.equal(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'https://two.example',ELFURA_SECRET:'shared'}),null);
  assert.equal(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'http://203.0.113.9:3002',ELFURA_RESOLVER_ALLOW_PUBLIC:'1',ELFURA_SECRET:'shared'})?.url,'http://203.0.113.9:3002');
  assert.equal(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'http://203.0.113.9:3002',ELFURA_SECRET:'shared'}),null,'public HTTP still requires explicit opt-in');
  assert.equal(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'https://user:pass@two.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'}),null);
  resolverConfig({ELFURA_RESOLVER_URL:'wrong'}); const reason=resolverFallbackReason();
  resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'https://two.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'});
  assert.equal(resolverFallbackReason(),reason,'backup must not overwrite primary diagnostics');
  console.log('resolver balancing: round robin, failover, cooldown/recovery, auth, switches and deadline OK');
} finally {
  for (const n of [a,b]) {n.srv.closeAllConnections(); await new Promise(r=>n.srv.close(r));}
}
