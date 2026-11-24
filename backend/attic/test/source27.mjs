import assert from 'node:assert/strict';
import {createSource27Adapter} from '../../../dist/backend/sources/source27.js';
import {verifyAndFilterCandidates} from '../../../dist/backend/sources/liveness.js';
const original=globalThis.fetch;
let calls=[], mode='ok';
globalThis.fetch=async (input,init={})=>{
 const u=new URL(String(input));calls.push({url:u,referer:init.headers?.Referer});
 if(u.pathname==='/embed/tmdb/tv'||u.pathname==='/embed/tmdb/movie') {
  if(mode==='bad-iframe') return new Response('<iframe src="https://127.0.0.1/proxy.php"></iframe>');
  return new Response('<iframe src="/proxy.php?p=x&amp;v=1"></iframe>');
 }
 if(u.pathname==='/proxy.php') {
  if(mode==='bad-stream')return new Response('var src="http://127.0.0.1/stream_proxy.php";');
  return new Response('var src="\\/stream_proxy.php?url=abc&tok=def";');
 }
 if(u.pathname==='/stream_proxy.php')return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Hindi",LANGUAGE="hi",URI="h.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="e.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=1280x720,AUDIO="a"\nv.m3u8\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}});
 if(u.pathname==='/v.m3u8'||u.pathname==='/h.m3u8'||u.pathname==='/e.m3u8')return new Response('#EXTM3U\n#EXTINF:10,\nfragment.ts\n#EXT-X-ENDLIST\n');
 throw Error('unexpected fetch');
};
try {
 const adapter=createSource27Adapter(()=>true);
 const response=await adapter.resolve({type:'movie',tmdbId:'550'});
 assert.equal(response.candidates.length,1);
 const opt=response.candidates[0];assert.equal(opt.type,'hls');assert.equal(opt.quality,'auto');
 assert.equal(calls[0].url.searchParams.get('id'),'550');
 assert.equal(opt.audioLang,undefined);assert.equal(opt.multiAudio,undefined);
 assert.equal(new URL(opt.url).pathname,'/stream_proxy.php');
 const verified=await verifyAndFilterCandidates([opt],AbortSignal.timeout(4000));
 assert.deepEqual(verified[0].availableAudioLangs,['hi','en']);assert.equal(verified[0].multiAudio,true);assert.deepEqual(verified[0].qualityLadder,[720]);
 calls=[];mode='bad-iframe';assert.equal((await adapter.resolve({type:'movie',tmdbId:'550'})).candidates.length,0);assert.equal(calls.length,1);
 calls=[];mode='bad-stream';assert.equal((await adapter.resolve({type:'movie',tmdbId:'550'})).candidates.length,0);assert.equal(calls.length,2);
 calls=[];assert.equal((await adapter.resolve({type:'tv',tmdbId:'1396',season:1,episode:1})).candidates.length,0);assert.equal(calls.length,0,'do not return an unverified episode');
 calls=[];assert.equal((await createSource27Adapter(()=>false).resolve({type:'movie',tmdbId:'550'})).candidates.length,0);assert.equal(calls.length,0);
 console.log('Source 27: episode parameters, safe URLs, real manifest languages/quality, and opt-out OK');
} finally {globalThis.fetch=original;}
