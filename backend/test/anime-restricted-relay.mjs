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
 globalThis.fetch=async(input,init)=>{calls.push({url:String(input),redirect:init.redirect});if(String(input).endsWith('/master'))return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://169.254.169.254/secret');if(String(input).endsWith('/html-ts')){const ts=Buffer.alloc(188*4);for(let i=0;i<ts.length;i+=188)ts[i]=0x47;return new Response(ts,{headers:{'content-type':'text/html'}});}if(String(input).endsWith('/actual-html'))return new Response('<!doctype html><html><body>denied</body></html>',{headers:{'content-type':'text/html'}});if(String(input).endsWith('/image-segment'))return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('encrypted-media-start'));setTimeout(()=>{try{c.enqueue(new TextEncoder().encode('-rest'));c.close()}catch{}},1000)}}),{headers:{'content-type':'image/jpeg'}});if(String(input).endsWith('/png-segment'))return new Response(Buffer.concat([Buffer.from('89504e470d0a1a0a0000000474734461','hex'),Buffer.from('test'),Buffer.alloc(4),Buffer.from('0000000049454e4400000000','hex')]),{headers:{'content-type':'image/png'}});if(String(input).endsWith('/slow')){await new Promise(r=>setTimeout(r,100));if(init.signal.aborted)throw new DOMException('aborted','AbortError');return new Response('media',{headers:{'content-type':'video/mp2t'}});}return new Response(null,{status:302,headers:{location:'http://169.254.169.254/'}})};
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
  assert.equal(await get(sealStreamTicket(secret,{u:origin+'/slow',k:'a',ro:origin})),200,'normal request completion must not abort a slow upstream fetch');
  const imageToken=sealStreamTicket(secret,{u:origin+'/image-segment',k:'a',ro:origin});
  const started=Date.now();
  const response=await original(`http://127.0.0.1:${server.address().port}/?t=${encodeURIComponent(imageToken)}`);
  const streamReader=response.body.getReader();const first=await streamReader.read();
  assert(Date.now()-started<800,'non-PNG image-labelled segment must stream before its body completes');
  let bytes=Buffer.from(first.value);for(;;){const next=await streamReader.read();if(next.done)break;bytes=Buffer.concat([bytes,Buffer.from(next.value)]);}
  assert.equal(bytes.toString(),'encrypted-media-start-rest');
  const pngToken=sealStreamTicket(secret,{u:origin+'/png-segment',k:'a',ro:origin});
  const png=await original(`http://127.0.0.1:${server.address().port}/?t=${encodeURIComponent(pngToken)}`);
  assert.equal(png.headers.get('content-type'),'video/mp2t');assert.equal(await png.text(),'test');
  const media=await original(`http://127.0.0.1:${server.address().port}/?t=${encodeURIComponent(sealStreamTicket(secret,{u:origin+'/html-ts',k:'a',ro:origin}))}`);
  assert.equal(media.status,200);assert.equal(media.headers.get('content-type'),'video/mp2t');const ts=new Uint8Array(await media.arrayBuffer());assert.equal(ts.length,188*4);assert.equal(ts[0],0x47);assert.equal(ts[188],0x47);
  assert.equal(await get(sealStreamTicket(secret,{u:origin+'/actual-html',k:'a',ro:origin})),502,'actual HTML must never be treated as media');
  assert.equal(await get(sealStreamTicket(secret,{u:origin+'/html-ts',k:'k',ro:origin})),502,'HTML-labelled keys must not bypass the media-only exception');
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
