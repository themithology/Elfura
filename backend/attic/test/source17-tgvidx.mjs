import assert from 'node:assert/strict';
import {createSource17Adapter,decodeTgvidxResponse} from '../../../dist/backend/sources/source17.js';
import {SourceRegistry} from '../../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../../dist/backend/config.js';
const cfg=loadBackendConfig({ELFURA_SECRET:'test',ELFURA_TGVIDX_ENABLED:'0'});
assert(!new SourceRegistry(cfg).listPublicSources().some(x=>x.id==='source-17'));
assert(new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test'})).listPublicSources().some(x=>x.id==='source-17'));
const original=globalThis.fetch;
const xor='tGfL1x#9vQ';
function envelope(payload){const bytes=Buffer.from(JSON.stringify(payload));for(let i=0;i<bytes.length;i++)bytes[i]^=xor.charCodeAt(i%xor.length)^(i&255);const p=bytes.toString('base64').split('').reverse().join('');return {t:10,i:0,p:{k:['result','error','context'],v:[{t:10,i:1,p:{k:['p'],v:[{t:1,s:p}]},o:0},{t:2,s:1},{t:11,i:2,p:{k:[],v:[]},o:0}]},o:0}}
const base='https://tgvidx.lovable.app';
const row=(server,url,type='hls',extra={})=>({server,label:server,url,type,quality:'1080p',...extra});
const mock={ok:true,type:'movie',tmdb_id:'1303331',links:[
 row('TG GREY ORION · HINDI','https://greyboxtv.duckdns.org/api/media?u=abc','hls',{subtitles:[{lang:'en',label:'English',url:'https://sub.example/a.vtt'}]}),
 row('TG GREY CARBON','https://worker.example/?url=manifest'),row('TG GREY MOON','https://greyboxtv.duckdns.org/api/media?u=moon'),
 row('TG GREY PULSE','https://greyboxtv.duckdns.org/api/player/river/media?u=abc'),row('TG GREY VALIANT','https://greyboxtv.duckdns.org/api/player/river/media?u=def'),
 row('TG STREAMHG',base+'/api/public/stream-proxy?u=abc'),row('TG MAGPIE',base+'/api/public/stream-proxy?u=dash','dash'),row('TG NEST 2',base+'/api/public/stream-proxy?u=nest'),
 row('TG VIDSHARED',base+'/api/public/stream-proxy?u=vidshared'),row('TG VIDARA',base+'/api/public/stream-proxy?u=vidara'),
 row('TG PIRATE','https://external.example/anything'),row('other','https://embed.theogpiratebot.to/api/v1/stream?t=abc'),row('other','https://stream.example/?url='+encodeURIComponent('https://embed.theogpiratebot.online/api/v1/stream?t=x')),
 row('other','http://127.0.0.1/bad.m3u8'),row('other','javascript:alert(1)'),row('other','https://external.example/embed','html'),row('TG STREAMHG',base+'/api/public/stream-proxy?u=abc')
]};
try{
 let calls=[];globalThis.fetch=async (url,opts)=>{calls.push({url,opts,body:JSON.parse(opts.body)});return Response.json(envelope(mock))};
 const adapter=createSource17Adapter(()=>true);const movie=await adapter.resolve({type:'movie',tmdbId:'1303331'});
 assert.equal(movie.candidates.length,10);assert(movie.candidates.some(c=>c.url.includes('u=vidshared')));assert(movie.candidates.some(c=>c.url.includes('u=vidara')));assert.equal(calls[0].body.t.p.v[0].p.v[0].s,'/api/m/1303331');assert.equal(calls[0].opts.headers['x-tsr-serverfn'],'true');
 assert.equal(movie.candidates[0].claimedAudioLang,'hi');assert.equal(movie.candidates[0].audioLang,undefined);assert.equal(movie.candidates[0].subtitles[0].lang,'en');assert.equal(movie.candidates[0].headers.Origin,'https://greyboxtv.duckdns.org');assert.equal(movie.candidates[6].type,'dash');
 assert(!movie.candidates.some(x=>/theogpiratebot/.test(x.url)));
 assert.deepEqual(decodeTgvidxResponse(JSON.stringify(envelope(mock))),mock);
 assert.equal(decodeTgvidxResponse('{}'),null);assert.equal(decodeTgvidxResponse('{'),null);
 assert.equal((await adapter.resolve({type:'movie',tmdbId:'1303332'})).candidates.length,0,'wrong title must be rejected');
 assert.equal((await adapter.resolve({type:'tv',tmdbId:'1396',season:1,episode:0})).candidates.length,0);
 const before=calls.length;await adapter.resolve({type:'movie',tmdbId:'x/1'});assert.equal(calls.length,before);
 const tv={...mock,type:'tv',tmdb_id:'1396',season:2,episode:4};globalThis.fetch=async(url,opts)=>{calls.push({url,opts,body:JSON.parse(opts.body)});return Response.json(envelope(tv))};
 assert.equal((await adapter.resolve({type:'tv',tmdbId:'1396',season:2,episode:4})).candidates.length,10);assert.equal(calls.at(-1).body.t.p.v[0].p.v[0].s,'/api/tv/1396/2/4');
 assert.equal((await adapter.resolve({type:'tv',tmdbId:'1396',season:2,episode:5})).candidates.length,0,'wrong episode rejected');
 globalThis.fetch=async()=>new Response('x',{status:429});assert.equal((await adapter.resolve({type:'movie',tmdbId:'550'})).candidates.length,0);
 // Egress can return the first 403 when its retry is aborted. Diagnose the
 // timeout instead of misleadingly attributing that final failure to HTTP 403.
 const controller=new AbortController(),diag=[];
 globalThis.fetch=async()=>{controller.abort();return new Response('Forbidden',{status:403})};
 await adapter.resolve({type:'movie',tmdbId:'550',signal:controller.signal,diag});
 assert.equal(diag[0].detail,'request timeout');
 globalThis.fetch=async()=>new Response('x'.repeat(1_000_001));assert.equal((await adapter.resolve({type:'movie',tmdbId:'550'})).candidates.length,0,'oversized response rejected');
 globalThis.fetch=async()=>{throw new TypeError('network')};assert.equal((await adapter.resolve({type:'movie',tmdbId:'550'})).candidates.length,0);
 const disabled=createSource17Adapter(()=>false);assert.equal((await disabled.resolve({type:'movie',tmdbId:'550'})).candidates.length,0);
 console.log('source17 TGVIDX adapter tests passed');
}finally{globalThis.fetch=original}
