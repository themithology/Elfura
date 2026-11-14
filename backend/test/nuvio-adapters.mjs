import assert from 'node:assert/strict';
import {nxEncode,nxDecode,fetchFromNxsha,NXSHA_SERVER_PRIORITY} from '../../dist/backend/sources/source5.js';
const obj={type:'tv',tmdbId:'93405'}; const decoded=nxDecode(nxEncode(obj));assert.equal(decoded.type,obj.type);assert.equal(decoded.tmdbId,obj.tmdbId);assert.throws(()=>nxDecode('invalid'));
const original=globalThis.fetch;const requests=[];const requestedProviders=[];
globalThis.fetch=async (url,opts)=>{url=String(url);requests.push(url);
 if(url.startsWith('https://nxsha.space/')) {
  const req=nxDecode(new URL(url).searchParams.get('q'));assert.equal(req.tmdbId,'93405');
  if(url.includes('/api/servers'))return Response.json({_hash:nxEncode({servers:[...NXSHA_SERVER_PRIORITY.slice(0,18).map(scraper=>({scraper})),{scraper:'hdhub4u'},{scraper:'vidara'},{scraper:'ophim'}]})});
  requestedProviders.push(req.provider);
  if(req.provider==='nitro')return Response.json({_hash:nxEncode({sources:[{url:'https://cdn.example.org/master.m3u8',label:'Multi Hindi English',type:'hls'},{url:'https://cdn.example.org/video.mpd',type:'mpd'},{url:'https://cdn.example.org/file.mp4',type:'video/mp4'}]})});
  if(req.provider==='mhbox')return Response.json({_hash:nxEncode({sources:[{url:'https://cdn.example.org/hi.m3u8',label:'Hindi',language:'Hindi',type:'hls'},{url:'https://vidara.example/master.m3u8',type:'hls'},{url:'http://127.0.0.1/private.m3u8',type:'hls'},{url:'https://cdn.example.org/embed',isEmbed:true,type:'hls'}]})});
  return Response.json({_hash:nxEncode({sources:[{url:'https://cdn.example.org/hi.m3u8',label:'Hindi',language:'Hindi',type:'hls'}]})});
 }
 throw new Error('unexpected url');};
try {
 const streams=await fetchFromNxsha({type:'tv',tmdbId:'93405',season:1,episode:1,diag:[]},undefined,{preferCurl:false});assert.equal(streams.length,4);assert.equal(streams[0].multiAudio,undefined);assert(streams.some(stream=>stream.type==='dash'));assert(streams.some(stream=>stream.type==='mp4'));assert(streams.every(stream=>!/vidara|127\.0\.0\.1|embed/i.test(stream.url)));assert(streams.some(stream=>stream.claimedAudioLang==='hi'));assert(streams.every(stream=>stream.audioLang===undefined&&stream.audioLabel===undefined),'provider language hints must stay unverified until a manifest proves them');assert(!requests.some(x=>x.includes('vidara')));assert(!requestedProviders.includes('ophim'),'exclude ScreenScape upstreams marked as unusable hard-subbed/page-only lanes');assert.deepEqual(requestedProviders.sort(),NXSHA_SERVER_PRIORITY.slice(0,12).slice().sort(),'Source 5 queries the first bounded group of priority lanes only');
 const hdhubTv=await fetchFromNxsha({type:'tv',tmdbId:'93405',season:1,episode:1},['hdhub4u'],{preferCurl:false});assert.deepEqual(hdhubTv,[],'exclude HDHub-family season-pack results from TV episode candidates');
 assert.deepEqual(await fetchFromNxsha({type:'movie',tmdbId:'bad'},undefined,{preferCurl:false}),[]);
 const curlStreams=await fetchFromNxsha({type:'movie',tmdbId:'693134'},undefined,{
  preferCurl:true,
  fetch:async()=>{throw new Error('curl should be used first')},
  curl:async url=>{
   const endpoint=new URL(url).pathname;
   const payload=endpoint.endsWith('/servers')?{servers:[{scraper:'nitro'}]}:{sources:[{url:'https://cdn.example.org/from-curl.m3u8',type:'hls'}]};
   return {status:200,body:JSON.stringify({_hash:nxEncode(payload)})};
  }
 });
 assert.equal(curlStreams.length,1);assert.equal(curlStreams[0].url,'https://cdn.example.org/from-curl.m3u8');
} finally {globalThis.fetch=original;}
console.log('✓ Nxsha crypto, input, URL and HLS mapping');
