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
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import { createResolverServer } from '../../dist/backend/resolver-server.js';

const secret='test-package-secret-0123456789-abcdef';
const requestCounts=[0,0];
const servers=[];
const children=[];
const tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-pool-package-'));
const keyPath=path.join(tmp,'test-key.pem'), certPath=path.join(tmp,'test-ca.pem');
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
const tls={key:readFileSync(keyPath),cert:readFileSync(certPath)};
async function listen(server) { servers.push(server); await new Promise(r=>server.listen(0,'127.0.0.1',r)); return server.address().port; }
async function node(id, useHttps) {
  const registry={
    listPublicSources:()=>[{id:'source-1',label:'Source 1'}],
    health:{snapshot:()=>[{id:'source-1',label:'Source 1'}],setEnabled:()=>{}},
    resolvePlayback:async()=>({ok:true,node:id}),
  };
  const real=createResolverServer({cfg:{},registry,token:secret,log:()=>{}}).server;
  const resolverPort=await listen(real);
  const state={blocked:false,hang:false,delay:0};
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
  for(const key of ['ELFURA_SECRET','ELFURA_RESOLVER_TOKEN','ELFURA_RESOLVER_URL','ELFURA_RESOLVER_BACKUP_URL','ELFURA_RESOLVER_ALLOW_PUBLIC','ELFURA_RESOLVER_ALLOW_LOCAL','REQUIRE_PLAYBACK_TOKEN','ALLOWED_ORIGINS','ELFURA_SELF_TEST']) delete env[key];
  const child=spawn(process.execPath,['index.js'],{cwd:tmp,env,detached:true,stdio:['ignore','pipe','pipe']});children.push(child);
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  const base=`http://127.0.0.1:${port}`;
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/v1/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert(ready,`packaged media failed to start: ${logs}`);
  assert.match(logs,/2 resolver URLs configured/,'startup must confirm balancing');
  assert.match(logs,/Stalled failover v2: hedge after 2500ms/,'package must contain the updated failover');
  assert.match(logs,/public HTTP backup is unencrypted/,'insecure transport must be clearly reported');
  async function playback(id){
    const response=await fetch(`${base}/api/v1/playback?type=movie&tmdb=${id}`,{headers:{origin:base,'user-agent':'Mozilla/5.0'}});
    assert.equal(response.status,200,`playback failed: ${await response.clone().text()}\n${logs}`);return response.json();
  }
  const got=[];for(let i=1;i<=8;i++)got.push((await playback(i)).node);
  assert.deepEqual(got,[1,2,1,2,1,2,1,2]);assert.deepEqual(requestCounts,[4,4]);
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
  b.state.blocked=false; b.state.hang=true; a.state.delay=4000;
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
  const start=Date.now();
  assert.equal((await slowPlayback(101)).node,1,'blackhole must fail over to a slow healthy resolver');
  assert.ok(Date.now()-start<11000,'healthy resolver needs enough of the overall budget');
  const healthyCalls=requestCounts[0];
  assert.equal((await slowPlayback(102)).node,1);
  assert.equal(requestCounts[0],healthyCalls+1,'subsequent discovery should start at the healthy backend');
  assert.match(stalledLogs,/skipping for 30000ms/,'the blackholed node must have entered cooldown');
  // Now reverse the outage before that cooldown expires. The recovered node
  // must not be left with only two seconds after the newly dead node times out.
  a.state.hang=true; b.state.hang=false; b.state.delay=4000;
  assert.equal((await slowPlayback(103)).node,2,'recovered cooling resolver must get enough time to respond');
  console.log('packaged .env + HTTPS primary and public HTTP backup: 50/50, 403 and stalled failover, diagnostics and override warning OK');
} finally {
  for(const child of children){try{process.kill(-child.pid,'SIGTERM');}catch{}await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)r();else child.once('exit',r);});}
  for(const server of servers.reverse()){server.closeAllConnections();await new Promise(r=>server.close(r));}
  rmSync(tmp,{recursive:true,force:true});
}
