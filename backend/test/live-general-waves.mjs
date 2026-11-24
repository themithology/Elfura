// Live, general-source research: real registry/provider discovery, four local
// resolver HTTP servers, media server and Chromium player. Never log upstream
// URLs, credentials, tickets or response bodies. Results are not production proof.
import {createBackendServer} from '../../dist/backend/index.js';
import {createResolverServer} from '../../dist/backend/resolver-server.js';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {installEgressProfile} from '../../dist/backend/egress.js';
import {tapRequests} from '../../dist/backend/sources/net-tap.js';
import {cachedCandidateEvidence} from '../../dist/backend/sources/liveness.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const secret='fixture-only-live-general-secret-0123456789';
const tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-live-general-'));
process.env.ELFURA_SECRET=secret;process.env.ELFURA_RESOLVER_TOKEN=secret;
process.env.ELFURA_SELF_TEST='0';process.env.ELFURA_RESOLVER_ALLOW_LOCAL='0';
process.env.ROXY_DATA_DIR=tmp;
const servers=[];let browser;
const listen=async server=>{servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;};
const rows=[];
const fatalNotice = (event, error) => {
 const name=typeof error?.name==='string'?error.name:'Error';
 const message=String(error?.message??error??'unknown').replace(/https?:\/\/\S+/gi,'[url]').slice(0,300);
 const frame=String(error?.stack??'').split('\n').find(line=>line.includes('live-general-waves.mjs'))?.trim()??'';
 console.log('::error title=Live general '+event+'::'+JSON.stringify({name,message,frame}));
};
process.on('uncaughtExceptionMonitor', error=>fatalNotice('uncaught',error));
process.on('unhandledRejection', error=>{fatalNotice('rejection',error);process.exitCode=1;});
try {
 const cfg=loadBackendConfig({ELFURA_SECRET:secret,OPENSUBTITLES_ENABLED:'0'});
 // Match normal process startup rather than testing bare Node fetch only.
 await installEgressProfile(()=>{});
 const urls=[];const observations=[];
 for(let i=0;i<1;i++) {
  const registry=new SourceRegistry(cfg);
  registry.adapters=registry.adapters.map(adapter=>({...adapter,async resolve(q){
   const start=Date.now();
   try {
    const tapped=await tapRequests(()=>adapter.resolve(q));
    const network={};
    for(const item of tapped.net){
     const key=item.status ? `http-${item.status}` : ['dns-fail','tls-reset','timeout','refused','tls-cert'].includes(item.error) ? item.error : 'other-error';
     network[key]=(network[key]??0)+1;
    }
    observations.push({node:i+1,title:`${q.type}/${q.tmdbId}`,id:adapter.id,ms:Date.now()-start,raw:tapped.value.candidates.length,network,candidates:tapped.value.candidates});
    return tapped.value;
   } catch(error) {observations.push({node:i+1,title:`${q.type}/${q.tmdbId}`,id:adapter.id,ms:Date.now()-start,error:['AbortError','TimeoutError','TypeError'].includes(error?.name)?error.name:'Error'});throw error;}
  }}));
  urls.push(await listen(createResolverServer({cfg,registry,token:secret,log:()=>{}}).server));
 }
 process.env.ELFURA_RESOLVER_URL=urls[0];
 const media=createBackendServer({...cfg,isProd:false,requireToken:false});const base=await listen(media.server);
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();
 for(const sample of [
  {type:'movie',id:'550',path:'movie/550'},
  {type:'tv',id:'1396',path:'tv/1396/1/1'},
  {type:'movie',id:'936622',path:'movie/936622'},
  {type:'tv',id:'44006',path:'tv/44006/1/1'},
 ]){
  const row={title:sample.path};let step='first';let lateRequests=0,recoveryRequests=0;
  const onRequest=req=>{if(!req.url().includes('/api/v1/playback?'))return;const u=new URL(req.url());if(u.searchParams.get('late')==='1')lateRequests++;if(u.searchParams.has('source'))recoveryRequests++;};
  page.on('request',onRequest);
  try{
   await page.goto(`${base}/embed/${sample.path}?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:20000});
   await page.waitForFunction(()=>window.__elfura?.player?.getSources().length>0,null,{timeout:20000});
   row.first=await page.evaluate(()=>({options:window.__elfura.player.getSources().length,groups:[...new Set(window.__elfura.player.getSources().map(s=>s.sourceId))]}));
   step='later';await page.waitForTimeout(23000);
   row.later=await page.evaluate(()=>({options:window.__elfura.player.getSources().length,groups:[...new Set(window.__elfura.player.getSources().map(s=>s.sourceId))],videoWidth:window.__elfura.player.video.videoWidth,ready:window.__elfura.player.video.readyState,time:window.__elfura.player.video.currentTime}));
   row.lateRequests=lateRequests;row.recoveryRequests=recoveryRequests;
   row.playbackObserved=row.later.videoWidth>0&&row.later.time>0;
   row.ok=row.first.options>0 && row.later.options>=row.first.options && row.playbackObserved;
  }catch(error){row.ok=false;row.step=step;row.error=error.name;row.lateRequests=lateRequests;row.recoveryRequests=recoveryRequests;}
  finally{page.off('request',onRequest);}
  const matching=observations.filter(r=>r.title===`${sample.type}/${sample.id}`);
  row.discovery=matching.map(({candidates,...record})=>{
   const evidence=(candidates??[]).map(c=>cachedCandidateEvidence(c));
   const duplicate=(candidates??[]).filter(c=>matching.some(other=>other.id!==record.id&&(other.candidates??[]).some(x=>x.url===c.url))).length;
   return {...record,manifestAlive:evidence.filter(e=>e?.alive).length,manifestDead:evidence.filter(e=>e?.confirmedDead).length,manifestUnknown:evidence.filter(e=>!e).length,sharedWithOtherSources:duplicate};
  });
  rows.push(row);
 }
 // GitHub limits both annotation size and the number of notices per step.
 // Reserve notices for both title summaries first, then compact aggregates.
 // The optional artifact keeps the full sanitized per-attempt breakdown.
 if(process.env.ELFURA_LIVE_REPORT) writeFileSync(process.env.ELFURA_LIVE_REPORT,JSON.stringify(rows,null,2));
 for (const {discovery,...summary} of rows) console.log('::notice title=Live general discovery summary::'+JSON.stringify(summary));
 for (const {title,discovery} of rows) {
  const aggregated=new Map();
  for(const r of discovery??[]) {
   const a=aggregated.get(r.id)??{id:r.id,attempts:0,raw:0,alive:0,dead:0,unknown:0,shared:0,network:{},errors:0};
   a.attempts++;a.raw+=r.raw??0;a.alive+=r.manifestAlive??0;a.dead+=r.manifestDead??0;a.unknown+=r.manifestUnknown??0;a.shared+=r.sharedWithOtherSources??0;
   for(const [k,v] of Object.entries(r.network??{}))a.network[k]=(a.network[k]??0)+v;
   if(r.error)a.errors++;
   aggregated.set(r.id,a);
  }
  // One compact notice per title, leaving room for all title summaries under
  // GitHub's 10-notice limit. The artifact has the verbose breakdown.
  const entries=[...aggregated.values()].sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
  const compact=entries.map(a=>[a.id,a.attempts,a.raw,a.alive,a.dead,a.unknown,a.shared,a.errors,a.network]);
  console.log('::notice title=Live source attempts::'+JSON.stringify({title,fields:['id','attempts','raw','alive','dead','unknown','shared','errors','network'],entries:compact}));
 }
 if(rows.some(row=>!row.ok))process.exitCode=1;
} catch (error) {
 const name=typeof error?.name==='string'?error.name:'Error';
 const message=String(error?.message??'unknown').replace(/https?:\/\/\S+/gi,'[url]').slice(0,300);
 const frame=String(error?.stack??'').split('\n').find(line=>line.includes('live-general-waves.mjs'))?.trim()??'';
 console.log('::error title=Live general fatal::'+JSON.stringify({name,message,frame}));
 if(process.env.ELFURA_LIVE_REPORT) writeFileSync(process.env.ELFURA_LIVE_REPORT,JSON.stringify({rows,fatal:{name,message,frame}},null,2));
 process.exitCode=1;
} finally {
 try {
  await browser?.close();
  for(const server of servers.reverse()){server.closeAllConnections();await new Promise(r=>server.close(r));}
  rmSync(tmp,{recursive:true,force:true});
 } catch (error) { fatalNotice('cleanup',error);process.exitCode=1; }
}
