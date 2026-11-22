import assert from 'node:assert/strict';
import {fetchFromDirectOrion,createSource1Adapter} from '../../dist/backend/sources/source1.js';
const base={enabled:true,riftOrigin:'https://rift.example',riftRelay:'',syncOrigin:'https://sync.example',vidrockOrigin:'https://rock.example',vidboltOrigin:'https://vidbolt.xyz'};
const original=globalThis.fetch;let calls=[];
globalThis.fetch=async (url,opts)=>{
 const u=new URL(url);calls.push({u,opts});
 if(u.hostname==='api.movy.lol')return Response.json({m3u8_path:'catalog/title/master.m3u8'});
 if(u.hostname==='img.animecurx.tech')return Response.json({sources:[{url:'https://gzip.rousav.tech/tv/master.m3u8'}]});
 if(u.hostname==='vidbolt.xyz')return Response.json({stream:{sources:[{url:'https://gzip.rousav.tech/old/master.m3u8'}]}});
 return new Response('',{status:503});
};
try{
 assert.deepEqual(await fetchFromDirectOrion(base,{type:'movie',tmdbId:'550'}),[]);assert.equal(calls.length,0);
 const cfg={...base,orionMovieKey:'fixture-movie-key',orionTvKey:'fixture-tv-key'};
 const movie=await fetchFromDirectOrion(cfg,{type:'movie',tmdbId:'550'});
 assert.equal(movie.length,1);assert.equal(movie[0].qualityLabelsUnreliable,true);assert.equal(new URL(movie[0].url).hostname,'img.rousav.tech');
 assert.equal(calls[0].u.pathname,'/api/source/550');assert.equal(calls[0].u.searchParams.get('api_key'),'fixture-movie-key');
 const tv=await fetchFromDirectOrion(cfg,{type:'tv',tmdbId:'1396',season:2,episode:3});
 assert.equal(tv.length,1);assert.equal(calls.at(-1).u.pathname,'/api/tv/1396/2/3');assert.equal(tv[0].headers.Referer,'https://vidbolt.xyz/');
 const count=calls.length;assert.deepEqual(await fetchFromDirectOrion(cfg,{type:'tv',tmdbId:'1396',season:2,episode:-1}),[]);assert.equal(calls.length,count);
 const both=await createSource1Adapter(cfg,2,{id:'source-1'}).resolve({type:'tv',tmdbId:'1396',season:2,episode:3,diag:[]});
 assert(both.candidates.some(c=>c.url.includes('/old/')),'existing VidBolt lane is retained');
 assert(both.candidates.some(c=>c.url.includes('/tv/master')),'direct Orion included');
}finally{globalThis.fetch=original;}
console.log('orion-direct: ok');
