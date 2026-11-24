// Synthetic pressure over actual media -> four-resolver HTTP; no external providers.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createResolverServer} from '../../dist/backend/resolver-server.js';
import {createBackendServer} from '../../dist/backend/index.js';
const secret='pressure-integration-secret-0123456789';
const tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-wave-load-'));
const original=globalThis.fetch;
const servers=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const keep=setInterval(()=>{},1000);
async function listen(server){servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
process.env.ROXY_DATA_DIR=tmp;process.env.ELFURA_SECRET=secret;process.env.ELFURA_RESOLVER_TOKEN=secret;
process.env.ELFURA_SELF_TEST='0';process.env.REQUIRE_PLAYBACK_TOKEN='0';process.env.ALLOWED_ORIGINS='*';process.env.ELFURA_RESOLVER_ALLOW_LOCAL='0';
globalThis.fetch=async (input,init)=>String(input).startsWith('https://load-cdn.example/')
 ? new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}}) : original(input,init);
try {
 const cfg=loadBackendConfig({ELFURA_SECRET:secret,TMDB_API_KEY:'',OPENSUBTITLES_ENABLED:'0'});
 const nodes=[];const scans=[[],[],[],[]];const discoveries=[new Map(),new Map(),new Map(),new Map()];
 for(let n=0;n<4;n++) {
  const reg=new SourceRegistry(cfg);
  const make=(id,ms)=>({id,label:id,enabled:()=>true,async resolve(q){
   const k=`${id}:${q.tmdbId}`;discoveries[n].set(k,(discoveries[n].get(k)??0)+1);
   if(ms)await wait(q.tmdbId==='88888'?6500:ms);if(q.tmdbId==='88888' && id!=='source-29')return {candidates:[]};if(id==='source-5')await wait(400);if(id==='source-5' && discoveries[n].get(k)===1)return {candidates:[]};return {candidates:[{key:k,url:`https://load-cdn.example/${k}.mp4`,type:'mp4',quality:'auto',rank:0}]};
  }});
  reg.adapters=[make('source-1',0),make('source-3',0),make('source-4',0),make('source-5',0),make('source-29',3600)];
  const resolve=reg.resolvePlayback.bind(reg);
  reg.resolvePlayback=async req=>{scans[n].push({title:req.tmdbId,late:!!req.late,at:Date.now()});return resolve(req);};
  nodes.push(await listen(createResolverServer({cfg,registry:reg,token:secret,log:()=>{}}).server));
 }
 [process.env.ELFURA_RESOLVER_URL,process.env.ELFURA_RESOLVER_BACKUP_URL,process.env.ELFURA_RESOLVER_THIRD_URL,process.env.ELFURA_RESOLVER_FOURTH_URL]=nodes;
 const base=await listen(createBackendServer({...cfg,requireToken:false}).server);
 const titles=Array.from({length:48},(_,i)=>String(70000+i)).concat(Array(102).fill('90000'));
 async function get(i,late=false,retry=false){
  const url=`${base}/api/v1/playback?type=movie&tmdb=${titles[i]}&nonce=load-${i}${late?'&late=1':''}${retry?'&retryMissing=1':''}`;
  const res=await original(url,{headers:{origin:base,'user-agent':'Mozilla/5.0'}});
  assert.equal(res.status,200,`viewer ${i} ${late?'late':'initial'} status ${res.status}`);return res.json();
 }
 const started=Date.now();const first=await Promise.all(titles.map((_,i)=>get(i)));
 assert(first.every(x=>x.sources.some(s=>s.sourceId==='source-1')&&x.pendingSources.includes('source-29')));
 assert.deepEqual(scans.map(s=>s.filter(r=>!r.late).length),[13,13,13,13],'102 shared-title requests coalesce into one computation per node');
 const workload=await Promise.all(nodes.map(async url=>(await original(url+'/resolver/api/workload',{headers:{'x-elfura-resolver-token':secret}})).json()));
 assert.equal(workload.reduce((s,x)=>s+x.playback.started+x.playback.shared,0),150,'all 150 viewer requests reach the resolver pool');
 assert(workload.every(x=>x.playback.started+x.playback.shared>=30),'all 4 nodes share the load');
 await wait(3800);
 const late=await Promise.all(titles.map((_,i)=>get(i,true)));
 assert(late.every(x=>x.sources.some(s=>s.sourceId==='source-29')),'every viewer receives its second wave');
 const lateWorkload=await Promise.all(nodes.map(async url=>(await original(url+'/resolver/api/workload',{headers:{'x-elfura-resolver-token':secret}})).json()));
 assert.equal(lateWorkload.reduce((s,x)=>s+x.playback.started+x.playback.shared,0),300,'late requests still reach the discovery owner');
 for(let n=0;n<4;n++)assert.equal(discoveries[n].get('source-29:90000'),1,'same-title concurrent discoveries coalesce per node');
 await Promise.all(titles.map((t,i)=>t==='90000'?get(i,true,true):null));
 await wait(500);
 const retried=await Promise.all(titles.map((t,i)=>t==='90000'?get(i,true):null));
 assert(retried.filter(Boolean).every(x=>x.sources.some(s=>s.sourceId==='source-5')),'coalesced retry returns previously empty source');
 for(let n=0;n<4;n++)assert.equal(discoveries[n].get('source-5:90000'),2,'one shared retry per source on each node');
 // An empty first wave still owns in-flight work; its later result must route
 // to that owner rather than disappearing after the initial 404.
 const emptyUrl=`${base}/api/v1/playback?type=movie&tmdb=88888&nonce=empty-viewer`;
 const emptyFirst=await original(emptyUrl,{headers:{origin:base,'user-agent':'Mozilla/5.0'}});
 assert.equal(emptyFirst.status,404);
 const owner=scans.findIndex(rows=>rows.some(row=>row.title==='88888'&&!row.late));
 await wait(2000);
 const emptyLate=await original(`${emptyUrl}&late=1`,{headers:{origin:base,'user-agent':'Mozilla/5.0'}});
 assert.equal(emptyLate.status,200);
 assert((await emptyLate.json()).sources.some(s=>s.sourceId==='source-29'));
 assert(scans[owner].some(row=>row.title==='88888'&&row.late),'empty first wave retains affinity');

 console.log(`wave HTTP pressure: ${titles.length} concurrent viewers, 48 unique titles + 102 shared-title requests, 4 nodes, all second waves; ${(Date.now()-started)}ms`);
} finally {
 for(const server of servers.reverse()){server.closeAllConnections();await new Promise(r=>server.close(r));}
 globalThis.fetch=original;clearInterval(keep);rmSync(tmp,{recursive:true,force:true});
}
