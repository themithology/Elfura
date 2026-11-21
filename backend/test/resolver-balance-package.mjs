// End-to-end deployment test: the actual ZIP, a real .env, one HTTPS proxy
// and one public HTTP proxy, and the real resolver HTTP/auth implementation. Provider work
// is replaced with deterministic registry fixtures (no external media sites).
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,appendFileSync} from 'node:fs';
import { createResolverServer } from '../../dist/backend/resolver-server.js';

const secret='test-package-secret-0123456789-abcdef';
const requestCounts=[0,0,0];
const servers=[];
const children=[];
const tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-pool-package-'));
const keyPath=path.join(tmp,'test-key.pem'), certPath=path.join(tmp,'test-ca.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
const tls={key:readFileSync(keyPath),cert:readFileSync(certPath)};
async function listen(server) { servers.push(server); await new Promise(r=>server.listen(0,'127.0.0.1',r)); return server.address().port; }
async function node(id, useHttps) {
  const state={blocked:false,hang:false,delay:0,backgroundHang:false};
  const registry={
    listPublicSources:()=>[{id:'source-1',label:'Source 1'}],
    health:{snapshot:()=>[{id:'source-1',label:'Source 1'}],setEnabled:()=>{}},
    resolvePlayback:async(request)=>{
      if(state.backgroundHang) request.onDiscoverySettled(new Promise(()=>{}));
      return {ok:true,node:id};
    },
  };
  const real=createResolverServer({cfg:{},registry,token:secret,log:()=>{}}).server;
  const resolverPort=await listen(real);
  const handler=(req,res)=>{
    if(state.blocked && req.url !== '/resolver/api/health') {res.writeHead(403,{'content-type':'text/html'});return res.end('Access denied');}
    if(req.url==='/resolver/api/playback') {
      requestCounts[id-1]++;
      if(state.hang) { req.resume(); return; }
    }
    const forward=()=>{
      if(res.destroyed) return;
      const upstream=http.request({host:'127.0.0.1',port:resolverPort,path:req.url,method:req.method,headers:req.headers},origin=>{
        res.writeHead(origin.statusCode,origin.headers);origin.pipe(res);
      });
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
      req.pipe(upstream);
    };
    if(req.url==='/resolver/api/playback' && state.delay) setTimeout(forward,state.delay);
    else forward();
  };
  const proxy=useHttps ? https.createServer(tls,handler) : http.createServer(handler);
  const proxyPort=await listen(proxy);
  // The test-only DNS hook below maps this public-classified hostname to our
  // local HTTP fixture, exercising public URL validation without external hosts.
  return {state,url:useHttps ? `https://127.0.0.1:${proxyPort}` : `http://resolver-public.test:${proxyPort}`};
}
try {
  const a=await node(1,true),b=await node(2,false);
  execFileSync('unzip',['-oq',path.resolve('elfura-pterodactyl.zip'),'-d',tmp]);
  const portSocket=net.createServer();await new Promise(r=>portSocket.listen(0,'127.0.0.1',r));
  const port=portSocket.address().port;await new Promise(r=>portSocket.close(r));
  writeFileSync(path.join(tmp,'.env'),[
    `ELFURA_SECRET=${secret}`,`ELFURA_RESOLVER_TOKEN=${secret}`,
    `ELFURA_RESOLVER_URL=${a.url}`,`ELFURA_RESOLVER_BACKUP_URL=${b.url}`,
    'ELFURA_RESOLVER_ALLOW_PUBLIC=1','ELFURA_RESOLVER_ALLOW_LOCAL=0',
    'REQUIRE_PLAYBACK_TOKEN=0','ALLOWED_ORIGINS=*','ELFURA_SELF_TEST=0',
  ].join('\n')+'\n');
  const dnsHook=path.join(tmp,'test-dns.cjs');
  writeFileSync(dnsHook, `const dns=require('node:dns'); const lookup=dns.lookup; dns.lookup=function(host,...rest){return lookup.call(this,host==='resolver-public.test'?'127.0.0.1':host,...rest)};`);
  const env={...process.env,HOST:'127.0.0.1',PORT:String(port),SERVER_PORT:String(port),NODE_ENV:'test',ELFURA_SUPERVISE:'0',NODE_EXTRA_CA_CERTS:certPath,NODE_OPTIONS:`--require=${dnsHook}`};
  // The test must actually load these values from the installed .env, not a
  // convenient parent environment that hides a launcher or Pterodactyl bug.
  for(const key of ['ELFURA_SECRET','ELFURA_RESOLVER_TOKEN','ELFURA_RESOLVER_URL','ELFURA_RESOLVER_BACKUP_URL','ELFURA_RESOLVER_THIRD_URL','ELFURA_RESOLVER_ALLOW_PUBLIC','ELFURA_RESOLVER_ALLOW_LOCAL','REQUIRE_PLAYBACK_TOKEN','ALLOWED_ORIGINS','ELFURA_SELF_TEST']) delete env[key];
  const child=spawn(process.execPath,['index.js'],{cwd:tmp,env,detached:true,stdio:['ignore','pipe','pipe']});children.push(child);
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const base=`http://127.0.0.1:${port}`;
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/v1/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert(ready,`packaged media failed to start: ${logs}`);
  assert.match(logs,/2 resolver URLs configured/,'startup must confirm balancing');
  assert.match(logs,/capacity-aware routing and circuit breaker enabled/,'package must contain the overload-safe failover');
  assert.match(logs,/public HTTP backup is unencrypted/,'insecure transport must be clearly reported');
  async function playback(id){
    const response=await fetch(`${base}/api/v1/playback?type=movie&tmdb=${id}`,{headers:{origin:base,'user-agent':'Mozilla/5.0'}});
    assert.equal(response.status,200,`playback failed: ${await response.clone().text()}\n${logs}`);return response.json();
  }
  const got=[];for(let i=1;i<=8;i++)got.push((await playback(i)).node);
  assert.deepEqual(got,[1,2,1,2,1,2,1,2]);assert.deepEqual(requestCounts,[4,4,0]);
  const login=await fetch(base+'/roxy/api/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password:secret})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  async function panel(){return (await fetch(base+'/roxy/api/sources',{headers:{origin:base,cookie}})).json();}
  let status=await panel();
  assert.equal(status.resolver.nodes.length,2);
  assert.deepEqual(status.resolver.nodes.map(n=>n.attempts),[4,4]);
  assert.ok(status.resolver.nodes.every(n=>n.authenticated));
  // Simulate Cloudflare Access/WAF denying only the second tunnel's private API
  // while its public health URL remains up. The first node must serve playback.
  b.state.blocked=true;
  assert.equal((await playback(9)).node,1);
  assert.equal((await playback(10)).node,1,'403 on node 2 should fail over to node 1');
  status=await panel();
  assert.equal(status.resolver.nodes[1].reachable,true);
  assert.equal(status.resolver.nodes[1].authenticated,false);
  assert.match(status.resolver.nodes[1].detail,/403/);
  assert.equal(status.resolver.nodes[1].failures,1);
  assert.ok(status.resolver.nodes[1].cooldownMs>0);
  assert.match(logs,/HTTP 403.*Cloudflare/);
  assert(!JSON.stringify(status.resolver.nodes).includes(secret),'diagnostics must not reveal token');
  // Pterodactyl startup variables can override the .env values. Confirm that the
  // package emits a useful warning instead of silently running only one node.
  const nextSocket=net.createServer();await new Promise(r=>nextSocket.listen(0,'127.0.0.1',r));
  const nextPort=nextSocket.address().port;await new Promise(r=>nextSocket.close(r));
  const overridden=spawn(process.execPath,['index.js'],{cwd:tmp,detached:true,stdio:['ignore','pipe','pipe'],env:{...env,PORT:String(nextPort),SERVER_PORT:String(nextPort),ELFURA_RESOLVER_BACKUP_URL:a.url}});
  children.push(overridden);let overrideLogs='';overridden.stdout.on('data',d=>overrideLogs+=d);overridden.stderr.on('data',d=>overrideLogs+=d);
  let secondReady=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${nextPort}/api/v1/health`)).ok){secondReady=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert(secondReady,`overridden media node failed to start: ${overrideLogs}`);
  assert.match(overrideLogs,/ELFURA_RESOLVER_BACKUP_URL.*overrides \.env/);
  assert.match(overrideLogs,/using 1 remote resolver/);
  assert(!overrideLogs.includes(secret),'override warning must not reveal secrets');
  // A fresh packaged media process, with the second node blackholed and the
  // first taking a realistic four seconds to discover sources. The old serial
  // failover waited ten seconds, leaving only two for the healthy node.
  const thirdSocket=net.createServer();await new Promise(r=>thirdSocket.listen(0,'127.0.0.1',r));
  const thirdPort=thirdSocket.address().port;await new Promise(r=>thirdSocket.close(r));
  b.state.blocked=false; b.state.hang=true; a.state.delay=0;
  const stalled=spawn(process.execPath,['index.js'],{cwd:tmp,detached:true,stdio:['ignore','pipe','pipe'],env:{...env,PORT:String(thirdPort),SERVER_PORT:String(thirdPort)}});
  children.push(stalled); let stalledLogs='';stalled.stdout.on('data',d=>stalledLogs+=d);stalled.stderr.on('data',d=>stalledLogs+=d);
  const stalledBase=`http://127.0.0.1:${thirdPort}`;
  let stalledReady=false;for(let i=0;i<100;i++){try{if((await fetch(stalledBase+'/api/v1/health')).ok){stalledReady=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert(stalledReady,`stalled test media node failed to start: ${stalledLogs}`);
  async function slowPlayback(id) {
    const response=await fetch(`${stalledBase}/api/v1/playback?type=movie&tmdb=${id}`,{headers:{origin:stalledBase,'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(14000)});
    assert.equal(response.status,200,`stalled failover: ${response.status} ${await response.clone().text()}\n${stalledLogs}`);
    return response.json();
  }
  assert.equal((await slowPlayback(100)).node,1); // Make node 2 the next round-robin choice.
  a.state.delay=4000;
  const start=Date.now();
  assert.equal((await slowPlayback(101)).node,1,'blackhole must fail over to a slow healthy resolver');
  assert.ok(Date.now()-start<11000,'healthy resolver needs enough of the overall budget');
  const healthyCalls=requestCounts[0];
  assert.equal((await slowPlayback(102)).node,1);
  assert.equal(requestCounts[0],healthyCalls+1,'subsequent discovery should start at the healthy backend');
  assert.match(stalledLogs,/circuit open/,'the blackholed node must have entered cooldown');
  const deadCalls=requestCounts[1];
  assert.equal((await slowPlayback(103)).node,1);
  assert.equal(requestCounts[1],deadCalls,'a slow healthy search must not hit the open circuit');
  // A new install with the third URL in .env must balance three resolvers
  // and survive two immediate failures.
  a.state.hang=false; a.state.delay=0; b.state.hang=false; b.state.delay=0;
  const c=await node(3,true);
  appendFileSync(path.join(tmp,'.env'),`ELFURA_RESOLVER_THIRD_URL=${c.url}\n`);
  const fourthSocket=net.createServer();await new Promise(r=>fourthSocket.listen(0,'127.0.0.1',r));
  const fourthPort=fourthSocket.address().port;await new Promise(r=>fourthSocket.close(r));
  const threeNode=spawn(process.execPath,['index.js'],{cwd:tmp,detached:true,stdio:['ignore','pipe','pipe'],env:{...env,PORT:String(fourthPort),SERVER_PORT:String(fourthPort)}});
  children.push(threeNode);let threeLogs='';threeNode.stdout.on('data',d=>threeLogs+=d);threeNode.stderr.on('data',d=>threeLogs+=d);
  const threeBase=`http://127.0.0.1:${fourthPort}`;
  let threeReady=false;for(let i=0;i<100;i++){try{if((await fetch(threeBase+'/api/v1/health')).ok){threeReady=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert(threeReady,`three-resolver media node failed to start: ${threeLogs}`);
  assert.match(threeLogs,/3 resolver URLs configured/);
  async function threePlayback(id){
    const response=await fetch(`${threeBase}/api/v1/playback?type=movie&tmdb=${id}`,{headers:{origin:threeBase,'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(14000)});
    assert.equal(response.status,200,`three-node playback failed: ${response.status} ${await response.clone().text()}\n${threeLogs}`);
    return response.json();
  }
  const balanced=[];for(let i=0;i<9;i++) balanced.push((await threePlayback(200+i)).node);
  assert.deepEqual(balanced,[1,2,3,1,2,3,1,2,3]);
  const threeLogin=await fetch(threeBase+'/roxy/api/login',{method:'POST',headers:{origin:threeBase,'content-type':'application/json'},body:JSON.stringify({password:secret})});
  assert.equal(threeLogin.status,200);
  const threeCookie=threeLogin.headers.get('set-cookie').split(';')[0];
  const threeStatus=await (await fetch(threeBase+'/roxy/api/sources',{headers:{origin:threeBase,cookie:threeCookie}})).json();
  assert.equal(threeStatus.resolver.nodes.length,3);
  assert.deepEqual(threeStatus.resolver.nodes.map(n=>n.attempts),[3,3,3]);
  // Regression: more than eight simultaneous viewers per node, followed by a
  // second wave while old provider background promises never settle. The old
  // default permanently filled all admission slots and locked out playback.
  for(const n of [a,b,c]) { n.state.backgroundHang=true; n.state.delay=100; }
  for(let wave=0;wave<2;wave++) {
    const responses=await Promise.all(Array.from({length:48},(_,i)=>threePlayback(400+wave*48+i)));
    assert.equal(responses.length,48);
    assert.ok([1,2,3].every(node=>responses.some(r=>r.node===node)),'all healthy resolvers must carry load');
  }
  for(const n of [a,b,c]) { n.state.backgroundHang=false; n.state.delay=0; }
  a.state.blocked=true; b.state.blocked=true; c.state.delay=4000;
  const threeStart=Date.now();
  assert.equal((await threePlayback(210)).node,3,'two fast failures must fail over to the third');
  assert.ok(Date.now()-threeStart<11000,'third node must get sufficient time to resolve');
  const failedCounts=[requestCounts[0],requestCounts[1]];
  assert.equal((await threePlayback(211)).node,3);
  assert.deepEqual([requestCounts[0],requestCounts[1]],failedCounts,'open circuits must not receive playback work');
  // A duplicate backup cannot hide a distinct third node.
  const fifthSocket=net.createServer();await new Promise(r=>fifthSocket.listen(0,'127.0.0.1',r));
  const fifthPort=fifthSocket.address().port;await new Promise(r=>fifthSocket.close(r));
  a.state.blocked=false; a.state.delay=1000; c.state.delay=1000;
  const duplicate=spawn(process.execPath,['index.js'],{cwd:tmp,detached:true,stdio:['ignore','pipe','pipe'],env:{...env,PORT:String(fifthPort),SERVER_PORT:String(fifthPort),ELFURA_RESOLVER_BACKUP_URL:a.url,ELFURA_RESOLVER_NODE_MAX_INFLIGHT:'1'}});
  children.push(duplicate);let duplicateLogs='';duplicate.stdout.on('data',d=>duplicateLogs+=d);duplicate.stderr.on('data',d=>duplicateLogs+=d);
  let duplicateReady=false;for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${fifthPort}/api/v1/health`)).ok){duplicateReady=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert(duplicateReady,`duplicate test media node failed to start: ${duplicateLogs}`);
  assert.match(duplicateLogs,/backup URL matches another resolver; ignoring duplicate/);
  assert.match(duplicateLogs,/2 resolver URLs configured/,'third must remain usable without a distinct backup');
  const busyBase=`http://127.0.0.1:${fifthPort}`;
  const busyHeaders={origin:busyBase,'user-agent':'Mozilla/5.0'};
  const pending=[fetch(`${busyBase}/api/v1/playback?type=movie&tmdb=300`,{headers:busyHeaders}),fetch(`${busyBase}/api/v1/playback?type=movie&tmdb=301`,{headers:busyHeaders})];
  await new Promise(r=>setTimeout(r,150));
  const busy=await fetch(`${busyBase}/api/v1/playback?type=movie&tmdb=302`,{headers:busyHeaders});
  assert.equal(busy.status,503); assert.equal(busy.headers.get('retry-after'),'5');
  assert.equal((await busy.json()).reason,'resolver-busy');
  assert.ok((await Promise.all(pending)).every(r=>r.status===200));
  console.log('packaged .env: two/three-node balancing, bounded failover, busy response, diagnostics and override warning OK');
} finally {
  for(const child of children){try{process.kill(-child.pid,'SIGTERM');}catch{}await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)r();else child.once('exit',r);});}
  for(const server of servers.reverse()){server.closeAllConnections();await new Promise(r=>server.close(r));}
  rmSync(tmp,{recursive:true,force:true});
}
