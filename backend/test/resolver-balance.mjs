import assert from 'node:assert/strict';
import http from 'node:http';
import { createBalancedPlaybackResolver } from '../../dist/backend/playback-resolver-balanced.js';
import { RemotePlaybackResolver } from '../../dist/backend/playback-resolver-remote.js';
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
  // Slow failures cannot add two full independent timeout windows.
  a.state.mode='ok'; b.state.mode='ok'; a.state.delay=500; b.state.delay=500;
  const bounded = createBalancedPlaybackResolver(client(a),client(b),{budgetMs:180,log:()=>{}});
  const start=Date.now(); await assert.rejects(bounded.resolve(request));
  assert.ok(Date.now()-start < 450,'pooled call exceeded its overall deadline');
  assert.ok(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'https://two.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1',ELFURA_SECRET:'shared'}));
  assert.equal(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'https://two.example',ELFURA_SECRET:'shared'}),null);
  assert.equal(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'http://two.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'}),null);
  assert.equal(resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'https://user:pass@two.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'}),null);
  resolverConfig({ELFURA_RESOLVER_URL:'wrong'}); const reason=resolverFallbackReason();
  resolverBackupConfig({ELFURA_RESOLVER_BACKUP_URL:'https://two.example',ELFURA_RESOLVER_ALLOW_PUBLIC:'1'});
  assert.equal(resolverFallbackReason(),reason,'backup must not overwrite primary diagnostics');
  console.log('resolver balancing: round robin, failover, cooldown/recovery, auth, switches and deadline OK');
} finally {
  for (const n of [a,b]) {n.srv.closeAllConnections(); await new Promise(r=>n.srv.close(r));}
}
