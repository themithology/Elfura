import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decodeVidNestV2, fetchFromVidNest, createSource10Adapter } from '../../dist/backend/sources/source10.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
const secret='K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2';
function encode(n,payload) {
 const key=crypto.createHash('sha256').update(`${n}|${secret}`).digest(),iv=crypto.randomBytes(12);
 const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const body=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final()]);
 return {v:2,n,d:Buffer.concat([iv,body,cipher.getAuthTag()]).toString('base64url')};
}
const nonce='fixture_nonce', envelope=encode(nonce,{ok:true});
assert.deepEqual(decodeVidNestV2(envelope,nonce),{ok:true});
const bytes=Buffer.from(envelope.d,'base64url');bytes[13]^=1;
assert.throws(()=>decodeVidNestV2({...envelope,d:bytes.toString('base64url')},nonce));
assert.throws(()=>decodeVidNestV2(envelope,'other_nonce'));
assert.throws(()=>decodeVidNestV2({...envelope,d:'***'},nonce));
const old=globalThis.fetch, lanes=[];
globalThis.fetch=async(input,opts)=>{
 const u=new URL(String(input));
 if(u.hostname==='new.vidnest.fun') {
  assert.equal(opts.redirect,'error');const [,lane,type,id]=u.pathname.split('/');
  assert.equal(type,'movie');assert.equal(id,'693134');lanes.push(lane);
  let payload={streams:[]};
  if(lane==='moviebox')payload={url:[{link:'https://vn-fixture.example/hindi.m3u8',lang:'Hindi',type:'hls'}, {link:'https://vn-fixture.example/tamil.mp4',lang:'Tamil',type:'mp4'}, {link:'/relay/private.m3u8',lang:'Hindi'}, {link:'http://127.0.0.1/x.m3u8',lang:'English'}, {link:'https://vidara.example/x.m3u8',lang:'English'}],headers:{Referer:'https://safe.example/',Authorization:'secret'}};
  if(lane==='allmovies')payload={streams:[{url:'https://vn-fixture.example/multi.m3u8',language:'Multi',type:'hls'}]};
  if(lane==='onehd')return Response.json({v:2,n:u.searchParams.get('_n'),d:'bad'});
  return Response.json(encode(u.searchParams.get('_n'),payload));
 }
 if(u.hostname==='vn-fixture.example') {
  if(u.pathname==='/seg.ts')return new Response(Buffer.from([0x47,0,0,0,0]),{status:206,headers:{'content-type':'video/mp2t'}});
  if(u.pathname==='/tamil.mp4'){const mp4=Buffer.alloc(20);mp4.write('ftyp',4);return new Response(mp4,{status:206,headers:{'content-type':'video/mp4'}});}
  if(u.pathname==='/child.m3u8')return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');
  if(u.pathname==='/hindi.m3u8')return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');
  return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="hi",URI="/child.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="en",URI="/child.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="x"\n/child.m3u8');
 }
 throw new Error('unexpected host');
};
try {
 const q={type:'movie',tmdbId:'693134'};
 const raw=await fetchFromVidNest(q);assert.equal(raw.length,3);assert.equal(raw[0].audioLang,'hi');
 assert.equal(raw[0].headers.Referer,'https://safe.example/');assert.equal(raw[0].headers.Origin,'https://vidnest.fun');assert(!('Authorization' in raw[0].headers));
 assert.deepEqual(lanes.sort(),['allmovies','moviebox','nextgencloudfabric','onehd','vidlink','vidzee']);
 const diag=[];const result=await createSource10Adapter(()=>true).resolve({...q,diag});
 assert.equal(result.candidates.length,3);assert.equal(result.candidates[0].audioLang,'hi');
 assert.equal(result.candidates[1].audioLang,'ta');assert.equal(result.candidates[1].type,'mp4');
 assert.deepEqual(result.candidates[2].availableAudioLangs,['hi','en']);assert.equal(result.candidates[2].multiAudio,true);
 assert.deepEqual(await fetchFromVidNest({...q,tmdbId:'bad'}),[]);
 assert(!new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test'})).listPublicSources().some(s=>s.id==='source-10'));
 assert(new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_VIDNEST_ENABLED:'1'})).listPublicSources().some(s=>s.id==='source-10'));
 assert(!new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_VIDNEST_ENABLED:'0'})).listPublicSources().some(s=>s.id==='source-10'));
 console.log('✓ VidNest authenticated encryption, bounded lanes, direct HLS and separate dubs');
}finally{globalThis.fetch=old}
