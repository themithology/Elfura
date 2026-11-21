import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns';
import {isPublicMediaAddress,restrictedFetch,restrictedFetchWithRedirects} from '../../dist/backend/restricted-fetch.js';
import {rewriteHlsManifest,handleStreamRelay} from '../../dist/backend/relay.js';
import {matchesRestrictedOrigin,openStreamTicket,sealStreamTicket} from '../../dist/backend/security.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
const origin='https://safe.example', secret=crypto.randomBytes(32), exp=Math.floor(Date.now()/1000)+120;
for(const unsafe of ['http://safe.example/file','https://evil.example/file','https://safe.example.evil.example/file','https://user@safe.example/file','http://127.0.0.1/','http://169.254.169.254/'])assert.equal(matchesRestrictedOrigin(unsafe,origin),false);
assert(matchesRestrictedOrigin(origin+'/file',origin));
const manifest=`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/child.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://169.254.169.254/latest\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"\n`;
const rewritten=rewriteHlsManifest(manifest,origin+'/master',{},secret,'/api/v1/stream',undefined,{forceProxy:true,restrictedOrigin:origin,restrictedExpiry:exp});
assert(!rewritten.includes('169.254'));assert(!rewritten.includes('evil.example'));
const path=rewritten.split('\n').find(l=>l.startsWith('/api/v1/stream?'));
assert(path);const token=new URL(path,'http://localhost').searchParams.get('t');const child=openStreamTicket(secret,token);assert.equal(child.u,origin+'/child.m3u8');assert.equal(child.ro,origin);assert.equal(child.fp,1);assert.equal(child.exp,exp);
assert.equal(openStreamTicket(secret,sealStreamTicket(secret,{u:origin+'/file',ro:origin,k:'m',exp:Math.floor(Date.now()/1000)-2})),null);
const calls=[];const original=globalThis.fetch;
try {
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),redirect:init.redirect});if(String(input).endsWith('/master'))return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://169.254.169.254/secret');return new Response(null,{status:302,headers:{location:'http://169.254.169.254/'}})};
 const cand={key:'restricted',url:origin+'/master',restrictedOrigin:origin,type:'hls',quality:'auto',rank:1};
 const result=await verifyAndFilterCandidatesDetailed([cand]);
 assert.equal(result.verifiedAliveCount,0);assert(calls.every(c=>c.redirect==='manual'));assert(calls.every(c=>!c.url.includes('169.254')));
 calls.length=0;
 const server=http.createServer((req,res)=>{const t=new URL(req.url,'http://localhost').searchParams.get('t');void handleStreamRelay(req,res,{secret,allowOrigin:'*',ticketParam:t,relayMode:'hybrid'});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const get=t=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:'/?t='+encodeURIComponent(t)},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))}).on('error',reject));
 try {
  const redirect=sealStreamTicket(secret,{u:origin+'/redirect',k:'s',ro:origin});
  assert.notEqual(await get(redirect),200);assert.equal(calls.length,1);assert.equal(calls[0].redirect,'manual');
  calls.length=0;
  assert.equal(await get(sealStreamTicket(secret,{u:'http://169.254.169.254/',k:'s',ro:origin})),400);assert.equal(calls.length,0);
 } finally {await new Promise(r=>server.close(r));}
}finally{globalThis.fetch=original;}
for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1'])assert.equal(isPublicMediaAddress(ip),false,ip);
assert(isPublicMediaAddress('8.8.8.8'));
const redirectCalls=[];
const fakeRedirect=async(url,init)=>{redirectCalls.push({url,headers:new Headers(init.headers),redirect:init.redirect});return redirectCalls.length===1?new Response(null,{status:302,headers:{location:'https://other.example/next'}}):new Response('ok');};
assert.equal((await restrictedFetchWithRedirects('https://safe.example/start',{headers:{Authorization:'secret',Cookie:'secret',Referer:'https://safe.example/'}},'*public*',fakeRedirect)).status,200);
assert.equal(redirectCalls.length,2);assert.equal(redirectCalls[1].headers.get('authorization'),null);assert.equal(redirectCalls[1].headers.get('cookie'),null);assert.equal(redirectCalls[1].headers.get('referer'),'https://safe.example/');
await assert.rejects(restrictedFetchWithRedirects('https://safe.example/start',{},'https://safe.example',async()=>new Response(null,{status:302,headers:{location:'https://other.example/'}})));
// DNS can change after a URL is issued: validate the address in the actual
// socket lookup, not in a separate pre-flight lookup vulnerable to rebinding.
const lookup=dns.lookup;let checked=false;
try {
 dns.lookup=(host,opts,cb)=>{checked=true;cb(null,[{address:'127.0.0.1',family:4}]);};
 await assert.rejects(restrictedFetch('https://rebinding-test.invalid/'));
 assert(checked,'guarded dispatcher must perform the socket DNS lookup');
}finally{dns.lookup=lookup;}
console.log('restricted anime HLS: origin, DNS rebinding, redirects, child tickets and expiry passed');
