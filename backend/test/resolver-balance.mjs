import assert from 'node:assert/strict';
import http from 'node:http';
import { createBalancedPlaybackResolver } from '../../dist/backend/playback-resolver-balanced.js';
import { RemotePlaybackResolver, ResolverUnavailableError } from '../../dist/backend/playback-resolver-remote.js';
import { createResilientPlaybackResolver, ResolverBusyError, resolverBackupConfig, resolverThirdConfig, resolverConfig, resolverFallbackReason } from '../../dist/backend/playback-resolver.js';

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
    if (state.mode === 'busy') {res.writeHead(503); return res.end(JSON.stringify({reason:'resolver-busy',error:'busy'}));}
    if (state.mode === 'invalid') {res.writeHead(400); return res.end(JSON.stringify({error:'bad request'}));}
    if (state.mode === 'limited') {res.writeHead(429); return res.end(JSON.stringify({error:'rate limited'}));}
    const body = state.mode === 'empty' ? {ok:false} : {ok:true,node:id};
    setTimeout(() => res.end(JSON.stringify(body)), state.delay);
  });
  return new Promise(resolve => srv.listen(0,'127.0.0.1',()=>resolve({state,srv,url:`http://127.0.0.1:${srv.address().port}`})));
}
const a = await server('a'), b = await server('b'), c = await server('c');
try {
  const client = n => new RemotePlaybackResolver(n.url, 'shared-token', () => {});
  let now = 1000;
  const pool = createBalancedPlaybackResolver(client(a), client(b), {now:()=>now, random:()=>0.5, cooldownMs:30000, maxInFlight:32, log:()=>{}});
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
  assert.ok(recovered.includes('a'));
  assert.ok(recovered.includes('b'));
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
  // A slow but healthy scan is not fanned out to every resolver. Only one
  // speculative call can run at a time and the global token budget is bounded.
  a.state.mode='ok'; b.state.mode='ok'; c.state.mode='ok';
  a.state.delay=300; b.state.delay=300; c.state.delay=300;
  const limitedHedge=createBalancedPlaybackResolver(client(a),client(b),{additionalClients:[client(c)],budgetMs:900,hedgeDelayMs:50,hedgeEvery:20,maxInFlight:20,log:()=>{}});
  const starts=[a.state.calls,b.state.calls,c.state.calls];
  const slowResults=await Promise.all(Array.from({length:12},()=>limitedHedge.resolve(request)));
  assert.equal(slowResults.length,12);
  const work=[a.state.calls,b.state.calls,c.state.calls].reduce((sum,x,i)=>sum+x-starts[i],0);
  assert.equal(work,13,'12 slow searches may launch at most one hedge, not 24-36 requests');
  await new Promise(r=>setTimeout(r,350)); // let the bounded loser finish

  // Fast failure opens the circuit: slow healthy traffic and hedges never
  // send more playback work to that node while the circuit is open.
  let clock=1000;
  a.state.mode='fail'; a.state.delay=0; b.state.delay=300;
  const breaker=createBalancedPlaybackResolver(client(a),client(b),{now:()=>clock,random:()=>0.5,budgetMs:900,hedgeDelayMs:50,cooldownMs:1000,log:()=>{}});
  assert.equal((await breaker.resolve(request)).node,'b');
  const breakerFailedCalls=a.state.calls;
  for(let i=0;i<5;i++) assert.equal((await breaker.resolve(request)).node,'b');
  assert.equal(a.state.calls,breakerFailedCalls,'no hedges or playback requests to an open circuit');
  assert.equal((await breaker.probe()).nodes[0].circuit,'open');
  // Once due, only one half-open trial is admitted, even under a burst. It
  // recovers the node on success; other viewers continue on the healthy peer.
  clock+=1001; a.state.mode='ok'; a.state.delay=300; b.state.delay=100;
  const beforeRecovery=a.state.calls;
  const recoveryResults=await Promise.all(Array.from({length:4},()=>breaker.resolve(request)));
  assert.equal(a.state.calls,beforeRecovery+1,'only one half-open request');
  assert.equal(recoveryResults.length,4);
  await new Promise(r=>setTimeout(r,300));
  assert.equal((await breaker.probe()).nodes[0].circuit,'closed');

  // Failed half-open trials back off exponentially. All-open circuits do not
  // get hammered while waiting, and one trial is allowed after the delay.
  let backoffNow=1000;
  a.state.mode='fail'; b.state.mode='fail'; a.state.delay=0; b.state.delay=0;
  const backoff=createBalancedPlaybackResolver(client(a),client(b),{now:()=>backoffNow,random:()=>0.5,cooldownMs:1000,log:()=>{}});
  await assert.rejects(backoff.resolve(request));
  const beforeOpen=[a.state.calls,b.state.calls];
  await Promise.all(Array.from({length:10},()=>assert.rejects(backoff.resolve(request))));
  assert.deepEqual([a.state.calls,b.state.calls],beforeOpen,'open circuits must receive no requests');
  backoffNow+=1001;
  await assert.rejects(backoff.resolve(request));
  const statusBackoff=await backoff.probe();
  assert.ok(statusBackoff.nodes.every(n=>n.cooldownMs===2000),'failed recovery doubles cooldown');
  b.state.mode='ok'; backoffNow+=2001;
  assert.equal((await backoff.resolve(request)).node,'b');

  // A real overload response opens the busy circuit, fails over, and reports
  // busy (rather than falsely claiming both nodes are down) when all reject.
  let busyNow=1000; a.state.mode='busy'; b.state.mode='ok';
  const overloaded=createBalancedPlaybackResolver(client(a),client(b),{now:()=>busyNow,random:()=>0.5,busyCooldownMs:1000,log:()=>{}});
  assert.equal((await overloaded.resolve(request)).node,'b');
  assert.equal((await overloaded.probe()).nodes[0].circuit,'open');
  b.state.mode='busy';
  await assert.rejects(overloaded.resolve(request),{name:'ResolverBusyError'});
  const busyCounts=[a.state.calls,b.state.calls];
  await assert.rejects(overloaded.resolve(request),{name:'ResolverBusyError'});
  assert.deepEqual([a.state.calls,b.state.calls],busyCounts);
  busyNow+=1001; a.state.mode='ok';
  assert.equal((await overloaded.resolve(request)).node,'a');

  // An old in-flight success must not close a circuit opened by a newer call.
  let fakeCalls=0;
  const fakeCommon={probe:async()=>({reachable:true}),authProbe:async()=>({authenticated:true})};
  const raceA={...fakeCommon,label:'race-a',resolve:async()=>{
    if(++fakeCalls===1) {await new Promise(r=>setTimeout(r,180)); return {ok:true,node:'a'};}
    throw new ResolverUnavailableError('failed');
  }};
  const raceB={...fakeCommon,label:'race-b',resolve:async()=>{await new Promise(r=>setTimeout(r,100));return {ok:true,node:'b'};}};
  const race=createBalancedPlaybackResolver(raceA,raceB,{budgetMs:900,hedgeDelayMs:300,random:()=>0.5,log:()=>{}});
  await Promise.all([race.resolve(request),race.resolve(request),race.resolve(request)]);
  assert.equal((await race.probe()).nodes[0].circuit,'open','stale success must not undo a newer outage');

  // Node capacity is bounded and routing prefers the least busy available node.
  a.state.mode='ok'; b.state.mode='ok'; a.state.delay=300; b.state.delay=300;
  const capacity=createBalancedPlaybackResolver(client(a),client(b),{maxInFlight:1,budgetMs:900,hedgeDelayMs:800,log:()=>{}});
  const firstPending=capacity.resolve(request);
  const secondPending=capacity.resolve(request);
  await assert.rejects(capacity.resolve(request),{name:'ResolverBusyError'});
  assert.deepEqual((await Promise.all([firstPending,secondPending])).map(x=>x.node),['a','b']);
  assert.equal((await capacity.probe()).nodes.reduce((s,n)=>s+n.active,0),0);

  // A blackholed first node gets at most one spare-capacity hedge, leaving a
  // realistically slow healthy peer time to answer within the shared deadline.
  a.state.delay=2000; b.state.delay=300;
  const stalled=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:800,hedgeDelayMs:100,log:()=>{}});
  assert.equal((await stalled.resolve(request)).node,'b');
  await new Promise(r=>setTimeout(r,500));
  assert.equal((await stalled.probe()).nodes[0].circuit,'open');
  const stalledCalls=a.state.calls;
  assert.equal((await stalled.resolve(request)).node,'b');
  assert.equal(a.state.calls,stalledCalls);

  // Pinned late discovery stays with its stash owner and is never hedged.
  a.state.delay=0; b.state.delay=0;
  const stickySlow=createBalancedPlaybackResolver(client(a),client(b),{budgetMs:800,hedgeDelayMs:50,log:()=>{}});
  const pin={...request,lateAffinityKey:'pin'};
  assert.equal((await stickySlow.resolve(pin)).node,'a');
  a.state.delay=160; const beforeLate=b.state.calls;
  assert.equal((await stickySlow.resolve({...pin,late:true})).node,'a');
  assert.equal(b.state.calls,beforeLate);
  a.state.delay=0;
  const limitedLate=createBalancedPlaybackResolver(client(a),client(b),{maxInFlight:1,budgetMs:800,hedgeDelayMs:50,log:()=>{}});
  assert.equal((await limitedLate.resolve(pin)).node,'a');
  a.state.delay=200;
  const pendingLate=limitedLate.resolve({...pin,late:true});
  const latePeerCalls=b.state.calls;
  await assert.rejects(limitedLate.resolve({...pin,late:true}),{name:'ResolverBusyError'});
  assert.equal(b.state.calls,latePeerCalls,'a saturated stash owner must not look like an empty peer');
  assert.equal((await pendingLate).node,'a');

  // Three nodes round-robin, recover, and get source switch broadcasts.
  a.state.delay=0; b.state.delay=0; c.state.delay=0;
  const three=createBalancedPlaybackResolver(client(a),client(b),{additionalClients:[client(c)],log:()=>{}});
  const threeResults=[];
  for(let i=0;i<9;i++) threeResults.push((await three.resolve({...request,lateAffinityKey:`three-${i}`})).node);
  assert.deepEqual(threeResults,['a','b','c','a','b','c','a','b','c']);
  assert.equal((await three.resolve({...request,lateAffinityKey:'three-2',late:true})).node,'c');
  assert.equal((await three.probe()).nodes.length,3);
  const changes=[a.state.changes,b.state.changes,c.state.changes];
  assert.equal(await three.setSourceEnabled('source-1',true),true);
  assert.deepEqual([a.state.changes,b.state.changes,c.state.changes],changes.map(x=>x+1));
  c.state.token='wrong'; assert.equal(await three.setSourceEnabled('source-1',true),false); c.state.token='shared-token';
  a.state.mode='fail'; b.state.mode='fail';
  assert.equal((await three.resolve(request)).node,'c','two fast failures route to the third');
  const thirdOnly=[a.state.calls,b.state.calls];
  for(let i=0;i<3;i++) assert.equal((await three.resolve(request)).node,'c');
  assert.deepEqual([a.state.calls,b.state.calls],thirdOnly);
  assert.equal(resolverThirdConfig({ELFURA_RESOLVER_THIRD_URL:'https://three.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1',ELFURA_SECRET:'shared'})?.token,'shared');
  assert.equal(resolverThirdConfig({ELFURA_RESOLVER_THIRD_URL:'https://three.example',ELFURA_SECRET:'shared'}),null);
  assert.equal(resolverThirdConfig({ELFURA_RESOLVER_THIRD_URL:'https://user:pass@three.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'}),null);
  const resilientBusy=createResilientPlaybackResolver({remote:{...three,resolve:async()=>{throw new ResolverBusyError();}}});
  await assert.rejects(resilientBusy.resolve(request),{name:'ResolverBusyError'});
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
  for (const n of [a,b,c]) {n.srv.closeAllConnections(); await new Promise(r=>n.srv.close(r));}
}
