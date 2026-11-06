import assert from 'node:assert/strict';
import {nxEncode,nxDecode,fetchFromNxsha} from '../../dist/backend/sources/source5.js';
import {fetchFromVidmody} from '../../dist/backend/sources/source6.js';
const obj={type:'tv',tmdbId:'93405'}; const decoded=nxDecode(nxEncode(obj));assert.equal(decoded.type,obj.type);assert.equal(decoded.tmdbId,obj.tmdbId);assert.throws(()=>nxDecode('invalid'));
const original=globalThis.fetch;const requests=[];
globalThis.fetch=async (url,opts)=>{url=String(url);requests.push(url);
 if(url.startsWith('https://nxsha.space/')) {
  const req=nxDecode(new URL(url).searchParams.get('q'));assert.equal(req.tmdbId,'93405');
  if(url.includes('/api/servers'))return Response.json({_hash:nxEncode({servers:[{scraper:'nitro'},{scraper:'vidara'},{scraper:'mhbox'}]})});
  if(req.provider==='nitro')return Response.json({_hash:nxEncode({sources:[{url:'https://cdn.example.org/master.m3u8',label:'Multi Hindi English',type:'hls'},{url:'https://vidara.example/master.m3u8',type:'hls'},{url:'http://127.0.0.1/private.m3u8',type:'hls'},{url:'https://cdn.example.org/embed',isEmbed:true,type:'hls'}]})});
  return Response.json({_hash:nxEncode({sources:[{url:'https://cdn.example.org/hi.m3u8',label:'Hindi',type:'hls'}]})});
 }
 if(url.startsWith('https://vidmody.com/')) return new Response('#EXTM3U\n#EXT-X-VERSION:3\n');
 throw new Error('unexpected url');};
try {
 const streams=await fetchFromNxsha({type:'tv',tmdbId:'93405',season:1,episode:1,diag:[]});assert.equal(streams.length,2);assert.equal(streams[0].multiAudio,undefined);assert.equal(streams[1].audioLang,'hi');assert(!requests.some(x=>x.includes('vidara')));
 assert.equal((await fetchFromVidmody({type:'tv',tmdbId:'93405',season:1,episode:2,imdbId:'tt0903747'})).length,1);assert(requests.some(u=>u.endsWith('/tt0903747/s1/e02')));
 globalThis.fetch=async()=>new Response('<html>not media</html>');assert.deepEqual(await fetchFromVidmody({type:'movie',tmdbId:'1',imdbId:'tt12345'}),[]);
 assert.deepEqual(await fetchFromNxsha({type:'movie',tmdbId:'bad'}),[]);
} finally {globalThis.fetch=original;}
console.log('✓ Nxsha crypto, input, URL and HLS mapping; Vidmody HLS verification');
