// Production registry with four real adapters. An ordinary reachable stream is
// still a source; neither the provider nor a manifest with no audio metadata can
// turn it into a claimed multi-audio or language-specific stream.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';

const saved=globalThis.fetch;
const keepAlive=setInterval(()=>{},1000);
const secret='K3p8vQ2mX9rL5wZ0fN7bG1sH4tJ6dC9_y8S3wM1nQ5pL2';
function encode(n, payload) {
 const key=crypto.createHash('sha256').update(`${n}|${secret}`).digest(),iv=crypto.randomBytes(12);
 const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const body=Buffer.concat([cipher.update(JSON.stringify(payload)),cipher.final()]);
 return {v:2,n,d:Buffer.concat([iv,body,cipher.getAuthTag()]).toString('base64url')};
}
const hls='#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';
globalThis.fetch=async input=>{
 const u=new URL(String(input));
 if(u.hostname==='core.vidzee.wtf') return Response.json(u.searchParams.get('s')==='tik'?{url:'https://eight.example/plain.m3u8'}:{});
 if(u.hostname==='vixsrc.to') {
  if(u.pathname.startsWith('/api/movie/')) return Response.json({src:'/embed/123'});
  if(u.pathname==='/embed/123') return new Response(`window.masterPlaylist={url:'https://nine.example/plain.m3u8',token:'fixture',expires:'${Math.floor(Date.now()/1000)+3600}'};`);
 }
 if(u.hostname==='new.vidnest.fun') {
  const lane=u.pathname.split('/')[1];
  const payload=lane==='allmovies'?{streams:[{url:'https://ten.example/plain.m3u8',type:'hls'},{url:'https://ten.example/dead.m3u8',type:'hls'},{url:'https://ten.example/refused.m3u8',type:'hls'}]}:{streams:[]};
  return Response.json(encode(u.searchParams.get('_n'),payload));
 }
 if(u.hostname==='streamdata.vaplayer.ru') return Response.json({status_code:'200',data:{stream_urls:['https://eleven.example/plain.m3u8','https://eleven.example/dead.m3u8']}});
 if(['eight.example','nine.example','ten.example','eleven.example'].includes(u.hostname)) {
  if(u.pathname.includes('dead'))return new Response('gone',{status:404});
  if(u.pathname.includes('refused'))return new Response('busy',{status:429});
  return new Response(hls,{headers:{'content-type':'application/vnd.apple.mpegurl'}});
 }
 return new Response('not found',{status:404});
};
try {
 const registry=new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'single-audio-coverage-test',OPENSUBTITLES_ENABLED:'0',TMDB_API_KEY:''}));
 registry.adapters=registry.adapters.filter(a=>['source-8','source-9','source-10','source-11'].includes(a.id)).map(a=>({...a,enabled:()=>true}));
 const result=await registry.resolvePlayback({type:'movie',tmdbId:'987654'});
 assert(result, 'all four adapters contribute to a production registry response');
 assert.deepEqual(new Set(result.sources.map(s=>s.sourceId)),new Set(['source-8','source-9','source-10','source-11']));
 assert.equal(result.sources.length,4,'404 and transiently refused manifests are not counted as verified sources');
 assert(result.sources.every(s=>!s.multiAudio&&!s.audioLang&&!(s.availableAudioLangs?.length)), 'no unproven audio or multi-audio claims');
 console.log('✓ all four generic adapters retain reachable ordinary streams in registry output without invented audio claims');
} finally {globalThis.fetch=saved;clearInterval(keepAlive);}
