// Live, general-source research: real registry/provider discovery, three real
// resolver HTTP servers, media server and Chromium player. Never log upstream
// URLs, credentials, tickets or response bodies. Results are not production proof.
import {createBackendServer} from '../../dist/backend/index.js';
import {createResolverServer} from '../../dist/backend/resolver-server.js';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {installEgressProfile} from '../../dist/backend/egress.js';
import {tapRequests} from '../../dist/backend/sources/net-tap.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {mkdtempSync,rmSync} from 'node:fs';
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
try {
 const cfg=loadBackendConfig({ELFURA_SECRET:secret,OPENSUBTITLES_ENABLED:'0'});
 // Match normal process startup rather than testing bare Node fetch only.
 await installEgressProfile(()=>{});
 const urls=[];const observations=[];
 for(let i=0;i<4;i++) {
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
    observations.push({node:i+1,title:`${q.type}/${q.tmdbId}`,id:adapter.id,ms:Date.now()-start,raw:tapped.value.candidates.length,network});
    return tapped.value;
   } catch(error) {observations.push({node:i+1,title:`${q.type}/${q.tmdbId}`,id:adapter.id,ms:Date.now()-start,error:error.name});throw error;}
  }}));
  urls.push(await listen(createResolverServer({cfg,registry,token:secret,log:()=>{}}).server));
 }
 [process.env.ELFURA_RESOLVER_URL,process.env.ELFURA_RESOLVER_BACKUP_URL,process.env.ELFURA_RESOLVER_THIRD_URL,process.env.ELFURA_RESOLVER_FOURTH_URL]=urls;
 const media=createBackendServer({...cfg,isProd:false,requireToken:false});const base=await listen(media.server);
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();
 for(const sample of [{type:'movie',id:'550',path:'movie/550'},{type:'tv',id:'1396',path:'tv/1396/1/1'}]){
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
  row.discovery=observations.filter(r=>r.title===`${sample.type}/${sample.id}`);
  rows.push(row);
 }
 console.log('::notice title=Live general discovery waves::'+JSON.stringify(rows));
 if(rows.some(row=>!row.ok))process.exitCode=1;
} finally {
 await browser?.close();
 for(const server of servers.reverse()){server.closeAllConnections();await new Promise(r=>server.close(r));}
 rmSync(tmp,{recursive:true,force:true});
}
