import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import {isPublicMediaAddress,restrictedFetch,restrictedFetchWithRedirects} from '../../dist/backend/restricted-fetch.js';
import {rewriteHlsManifest,handleStreamProxy,buildStreamProxyUrl,decodeProxyHeaders,decodeProxyTarget} from '../../dist/backend/stream-proxy.js';
import {matchesRestrictedOrigin} from '../../dist/backend/security.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';

const origin='https://safe.example';

// 1. Restricted-origin policy: exact HTTPS origin, no credentials, no look-alikes.
for(const unsafe of ['http://safe.example/file','https://evil.example/file','https://safe.example.evil.example/file','https://user@safe.example/file','http://127.0.0.1/','http://169.254.169.254/']) {
  assert.equal(matchesRestrictedOrigin(unsafe,origin),false, unsafe);
}
assert(matchesRestrictedOrigin(origin+'/file',origin));

// 2. Playlist rewriting must drop unsafe references and pin every child to the
//    declared origin. The child proxy URL carries the origin in `ro`.
const manifest = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1',
  '/child.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1',
  'http://169.254.169.254/latest',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"',
  '',
].join('\n');
const rewritten = rewriteHlsManifest(manifest, origin+'/master', {}, '/api/proxy', undefined, origin);
assert(!rewritten.includes('169.254'));
assert(!rewritten.includes('evil.example'));
const childLine = rewritten.split('\n').find(line => line.startsWith('/api/proxy'));
assert(childLine, 'safe child must be proxied');
const childUrl = new URL(childLine, 'http://localhost');
assert.equal(decodeProxyTarget(childUrl.searchParams.get('u')), origin+'/child.m3u8');
assert.equal(childUrl.searchParams.get('ro'), origin, 'restricted origin must propagate to child playlists');
assert.equal(childUrl.searchParams.get('h'), null, 'no header hint was supplied');

// 3. A restricted liveness probe must never follow an unsafe redirect.
const calls=[];
const originalFetch=globalThis.fetch;
try {
  globalThis.fetch=async(input,init)=>{
    calls.push({url:String(input),redirect:init?.redirect});
    if(String(input).endsWith('/master')) {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://169.254.169.254/secret');
    }
    return new Response(null,{status:302,headers:{location:'http://169.254.169.254/'}});
  };
  const cand={key:'restricted',url:origin+'/master',restrictedOrigin:origin,type:'hls',quality:'auto',rank:1};
  const result=await verifyAndFilterCandidatesDetailed([cand]);
  assert.equal(result.verifiedAliveCount,0);
  assert(calls.length>0);
  assert(calls.every(c=>c.redirect==='manual'));
  assert(calls.every(c=>!c.url.includes('169.254')));
} finally {
  globalThis.fetch=originalFetch;
}

// 4. Proxy handler: restricted requests enforce the origin before any fetch,
//    reject unsafe redirects, and still stream real media (including the
//    mislabelled/PNG-wrapped shapes seen in the wild).
const proxyCalls=[];
globalThis.fetch=async(input,init)=>{
  const url=String(input);
  proxyCalls.push({url,redirect:init?.redirect});
  if(url.endsWith('/master')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttp://169.254.169.254/secret');
  if(url.endsWith('/redirect')) return new Response(null,{status:302,headers:{location:'http://169.254.169.254/'}});
  if(url.endsWith('/html-ts')) {
    const ts=Buffer.alloc(188*4);
    for(let i=0;i<ts.length;i+=188) ts[i]=0x47;
    return new Response(ts,{headers:{'content-type':'text/html'}});
  }
  if(url.endsWith('/actual-html') || url.endsWith('/actual.key')) {
    return new Response('<!doctype html><html><body>denied</body></html>',{headers:{'content-type':'text/html'}});
  }
  if(url.endsWith('/image-segment')) {
    return new Response(new ReadableStream({start(c){
      c.enqueue(new TextEncoder().encode('encrypted-media-start'));
      setTimeout(()=>{try{c.enqueue(new TextEncoder().encode('-rest'));c.close();}catch{}},1000);
    }}),{headers:{'content-type':'image/jpeg'}});
  }
  if(url.endsWith('/png-segment')) {
    return new Response(Buffer.concat([
      Buffer.from('89504e470d0a1a0a0000000474734461','hex'),
      Buffer.from('test'),
      Buffer.alloc(4),
      Buffer.from('0000000049454e4400000000','hex'),
    ]),{headers:{'content-type':'image/png'}});
  }
  if(url.endsWith('/slow')) {
    await new Promise(r=>setTimeout(r,100));
    if(init.signal.aborted) throw new DOMException('aborted','AbortError');
    return new Response('media',{headers:{'content-type':'video/mp2t'}});
  }
  return new Response(null,{status:404});
};

const server=http.createServer((req,res)=>handleStreamProxy(req,res,{allowOrigin:'*'}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const get=(path, headers={})=>new Promise((resolve,reject)=>{
  http.get({host:'127.0.0.1',port,path,headers},res=>{
    const chunks=[];
    res.on('data',c=>chunks.push(c));
    res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
  }).on('error',reject);
});
const proxyPath=(path)=>buildStreamProxyUrl(origin+path, undefined, '/api/proxy', {restrictedOrigin:origin});
try {
  // Unsafe target is refused before a request is made.
  proxyCalls.length=0;
  const blocked=await get(buildStreamProxyUrl('http://169.254.169.254/', undefined, '/api/proxy', {restrictedOrigin:origin}));
  assert.equal(blocked.status,403);
  assert.equal(proxyCalls.length,0,'unsafe target must not be fetched');

  // Redirect to a metadata address is refused.
  proxyCalls.length=0;
  const redirected=await get(proxyPath('/redirect'));
  assert.notEqual(redirected.status,200);
  assert.equal(proxyCalls.length,1);
  assert.equal(proxyCalls[0].redirect,'manual');

  // Normal completion must not abort a slow upstream.
  proxyCalls.length=0;
  const slow=await get(proxyPath('/slow'));
  assert.equal(slow.status,200);
  assert.equal(slow.body.toString(),'media');

  // A TS segment mislabelled as text/html is accepted after byte sniffing.
  const mislabelled=await get(proxyPath('/html-ts'));
  assert.equal(mislabelled.status,200);
  assert.equal(mislabelled.headers['content-type'],'video/mp2t');
  const ts=new Uint8Array(mislabelled.body);
  assert.equal(ts.length,188*4);
  assert.equal(ts[0],0x47);
  assert.equal(ts[188],0x47);

  // A genuine HTML page is never media.
  assert.equal((await get(proxyPath('/actual-html'))).status,502);
  assert.equal((await get(proxyPath('/actual.key'))).status,502);

  // A non-PNG image-labelled segment streams before its body completes.
  const imageResponse=await new Promise((resolve,reject)=>{
    http.get({host:'127.0.0.1',port,path:proxyPath('/image-segment')},res=>{
      const reader=res;
      let first=null;
      const chunks=[];
      reader.on('data',c=>{if(!first)first=c;chunks.push(c);});
      reader.on('end',()=>resolve({first,chunks,status:res.statusCode}));
    }).on('error',reject);
  });
  assert.equal(imageResponse.status,200);
  assert(Buffer.concat(imageResponse.chunks).toString(),'encrypted-media-start-rest');
  assert(imageResponse.first,'first chunk must arrive before the body completes');

  // A PNG-wrapped transport stream is unwrapped into MPEG-TS.
  const png=await get(proxyPath('/png-segment'));
  assert.equal(png.status,200);
  assert.equal(png.headers['content-type'],'video/mp2t');
  assert.equal(png.body.toString(),'test');
} finally {
  await new Promise(r=>server.close(r));
  globalThis.fetch=originalFetch;
}

// 5. Restricted egress rejects every private/loopback shape and accepts public v4.
for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','::1','::ffff:127.0.0.1']) {
  assert.equal(isPublicMediaAddress(ip),false,ip);
}
assert(isPublicMediaAddress('8.8.8.8'));

// 6. Redirect handling strips credentials cross-origin but keeps the Referer.
const redirectCalls=[];
const fakeRedirect=async(url,init)=>{
  redirectCalls.push({url,headers:new Headers(init.headers),redirect:init.redirect});
  return redirectCalls.length===1
    ? new Response(null,{status:302,headers:{location:'https://other.example/next'}})
    : new Response('ok');
};
assert.equal((await restrictedFetchWithRedirects('https://safe.example/start',{headers:{Authorization:'secret',Cookie:'secret',Referer:'https://safe.example/'}},'*public*',fakeRedirect)).status,200);
assert.equal(redirectCalls.length,2);
assert.equal(redirectCalls[1].headers.get('authorization'),null);
assert.equal(redirectCalls[1].headers.get('cookie'),null);
assert.equal(redirectCalls[1].headers.get('referer'),'https://safe.example/');
await assert.rejects(restrictedFetchWithRedirects('https://safe.example/start',{},'https://safe.example',async()=>new Response(null,{status:302,headers:{location:'https://other.example/'}})));

// 7. DNS can change after a URL is issued: validate the address in the actual
//    socket lookup, not in a separate pre-flight lookup vulnerable to rebinding.
const lookup=dns.lookup;
let checked=false;
try {
  dns.lookup=(host,opts,cb)=>{checked=true;cb(null,[{address:'127.0.0.1',family:4}]);};
  await assert.rejects(restrictedFetch('https://rebinding-test.invalid/'));
  assert(checked,'guarded dispatcher must perform the socket DNS lookup');
} finally {
  dns.lookup=lookup;
}

console.log('restricted anime HLS: origin pinning, redirects, byte sniffing and DNS rebinding passed');
