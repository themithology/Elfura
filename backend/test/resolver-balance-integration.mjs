import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,rmSync} from 'node:fs';

const secret='test-balance-secret-0123456789';
async function mock(id) {
  const state={calls:0,fail:false};
  const srv=http.createServer((req,res)=>{
    if(req.url==='/resolver/api/health') return res.end(JSON.stringify({ok:true}));
    if(req.headers['x-elfura-resolver-token']!==secret) {res.writeHead(401);return res.end(JSON.stringify({error:'auth'}));}
    if(req.url==='/resolver/api/playback') {
      let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{try{state.lastRequest=JSON.parse(body);}catch{}});
      state.calls++;
      if(state.fail) {res.writeHead(503);return res.end(JSON.stringify({error:'offline'}));}
      return res.end(JSON.stringify({ok:true,node:id}));
    }
    if(req.url==='/resolver/api/sources') return res.end(JSON.stringify({sources:[]}));
    res.writeHead(404);res.end();
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  return {srv,state,url:`http://127.0.0.1:${srv.address().port}`};
}
const a=await mock('a'),b=await mock('b'),c=await mock('c');
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
const port=socket.address().port;await new Promise(r=>socket.close(r));
const tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-pool-'));
const child=spawn(process.execPath,['index.js'],{cwd:process.cwd(),detached:true,stdio:['ignore','pipe','pipe'],env:{
  ...process.env,HOST:'127.0.0.1',PORT:String(port),SERVER_PORT:String(port),ELFURA_SUPERVISE:'0',
  ELFURA_RESOLVER_URL:a.url,ELFURA_RESOLVER_BACKUP_URL:b.url,ELFURA_RESOLVER_THIRD_URL:c.url,ELFURA_RESOLVER_ALLOW_LOCAL:'0',
  ELFURA_SECRET:secret,ELFURA_RESOLVER_TOKEN:secret,ELFURA_SELF_TEST:'0',ALLOWED_ORIGINS:'*',
  REQUIRE_PLAYBACK_TOKEN:'0',NODE_ENV:'test',ROXY_DATA_DIR:tmp,
}});
let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
try {
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<100;i++) {try{if((await fetch(base+'/api/v1/health')).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
  assert(ready,`media node failed to start: ${logs}`);
  async function playback(i,extra='') {
    const response=await fetch(`${base}/api/v1/playback?type=movie&tmdb=${i}${extra}`,{headers:{origin:base,'user-agent':'Mozilla/5.0'}});
    assert.equal(response.status,200,`playback ${response.status}: ${await response.clone().text()}\n${logs}`);
    return response.json();
  }
  const got=[];for(let i=1;i<=9;i++) got.push((await playback(i)).node);
  assert.deepEqual(got,['a','b','c','a','b','c','a','b','c']);
  assert.equal((await playback(11,'&nonce=session-one')).node,'a');
  assert.equal((await playback(12,'&nonce=session-two')).node,'b');
  assert.equal((await playback(11,'&nonce=session-one&late=1')).node,'a','late request must reach the original resolver');
  assert.equal(a.state.lastRequest.late,true);
  assert.equal('lateAffinityKey' in a.state.lastRequest,false,'routing key must not leave media node');
  c.state.fail=true; // C is the next choice
  assert.equal((await playback(20)).node,'a','real media server must fail over');
  const count=c.state.calls;
  const survivors=[];for(let i=21;i<=26;i++)survivors.push((await playback(i)).node);
  assert.equal(c.state.calls,count,'failed resolver must not receive playback');
  assert.equal(survivors.filter(x=>x==='a').length,3);
  assert.equal(survivors.filter(x=>x==='b').length,3);
  console.log('media-server integration: three-node env config, round-robin, affinity and failover OK');
} finally {
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)r();else child.once('exit',r);});
  for(const n of [a,b,c]) {n.srv.closeAllConnections();await new Promise(r=>n.srv.close(r));}
  rmSync(tmp,{recursive:true,force:true});
}
