// Live TGVIDX analysis: real adapters, all-source registry, balanced resolver
// HTTP, real media relay and Chromium player. TMDB metadata is a fixture.
// A source/manifest response is not counted as successful browser playback.
import {createBackendServer,installProcessGuards} from '../../dist/backend/index.js';
import {createResolverServer} from '../../dist/backend/resolver-server.js';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {installEgressProfile} from '../../dist/backend/egress.js';
import {decodeTgvidxResponse} from '../../dist/backend/sources/source17.js';
import {cachedCandidateEvidence} from '../../dist/backend/sources/liveness.js';
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
import crypto from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
const secret='source17-live-fixture-secret-0123456789';
process.env.ELFURA_SECRET=secret;process.env.ELFURA_RESOLVER_TOKEN=secret;process.env.ELFURA_SELF_TEST='0';process.env.ELFURA_RESOLVER_ALLOW_LOCAL='0';process.env.TMDB_DISABLE_FALLBACK='1';
const tmp=mkdtempSync(path.join(os.tmpdir(),'tgvidx-full-'));process.env.ROXY_DATA_DIR=tmp;
const samples=[{type:'tv',id:'65942',title:'Re:ZERO -Starting Life in Another World-',episode:'The End of the Beginning and the Beginning of the End',runtime:49,lang:'ja',genres:['Animation']},{type:'movie',id:'550',title:'Fight Club',runtime:139,lang:'en',genres:[]},{type:'tv',id:'1396',title:'Breaking Bad',episode:'Pilot',runtime:58,lang:'en',genres:[]},{type:'movie',id:'1303331',title:'Dhamaal 4',runtime:141,lang:'hi',genres:[]}];
const original=globalThis.fetch;await installEgressProfile(()=>{});const egress=globalThis.fetch;const names=new Map(),inventory=[];
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
 if(u.hostname==='tmdb-fixture.example'){const parts=u.pathname.split('/'),sample=samples.find(s=>parts.includes(s.id));if(!sample)return new Response(null,{status:404});if(parts.includes('episode'))return Response.json({name:sample.episode,runtime:sample.runtime});return Response.json({id:Number(sample.id),title:sample.title,name:sample.title,original_name:sample.title,original_language:sample.lang,release_date:'2016-01-01',first_air_date:'2016-01-01',runtime:sample.runtime,episode_run_time:[sample.runtime],genres:sample.genres.map(name=>({name})),images:{logos:[]},external_ids:{}})}
 const response=await egress(input,init);
 if(u.hostname==='tgvidx.lovable.app'&&u.pathname.startsWith('/_serverFn/'))try{const data=decodeTgvidxResponse(await response.clone().text());const rows=[];for(const x of data?.links||[]){if(typeof x.url==='string'){const url=new URL(x.url,'https://tgvidx.lovable.app').href;names.set(url,x.server||x.label||'unknown');rows.push({name:x.server||x.label||'unknown',type:x.type})}}inventory.push({tmdb:String(data?.tmdb_id||''),rows,status:response.status})}catch{}
 return response};
const servers=[],observations=[];let browser;
const listen=async s=>{servers.push(s);await new Promise(r=>s.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${s.address().port}`};
const notice=(title,row)=>console.log(`::notice title=${title}::${JSON.stringify(row).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,10000)}`);
let fingerprintKey;
const fingerprint=c=>crypto.createHmac('sha256',fingerprintKey).update(c.fingerprint||c.url).digest('hex').slice(0,12);
process.on('uncaughtExceptionMonitor',e=>notice('Full-flow uncaught',{name:e?.name,stack:String(e?.stack||'').replace(/https?:\/\/\S+/g,'[url]').slice(0,1000)}));
// Production entrypoints install these guards; preserve that behavior here and
// emit the exception separately so a guarded failure is never hidden.
installProcessGuards();
try{
 const cfg=loadBackendConfig({ELFURA_SECRET:secret,TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'}),nodes=[],registries=[];fingerprintKey=cfg.secret;
 for(let i=0;i<4;i++){const registry=new SourceRegistry(cfg);registries.push(registry);registry.adapters=registry.adapters.map(a=>a.id!=='source-17'?a:{...a,async resolve(q){const started=Date.now(),diag=[];const r=await a.resolve({...q,diag});observations.push({node:i+1,title:q.tmdbId,started,ms:Date.now()-started,diag,candidates:r.candidates});return r}});nodes.push(await listen(createResolverServer({cfg,registry,token:secret,log:()=>{}}).server))}
 [process.env.ELFURA_RESOLVER_URL,process.env.ELFURA_RESOLVER_BACKUP_URL,process.env.ELFURA_RESOLVER_THIRD_URL,process.env.ELFURA_RESOLVER_FOURTH_URL]=nodes;
 const app=createBackendServer({...cfg,isProd:false,requireToken:false});const base=await listen(app.server);
 browser=await chromium.launch({executablePath:await binary.executablePath(),args:[...binary.args,'--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();
 await page.addInitScript(()=>{const state=window.__research={start:Date.now(),first:null,first17:null};setInterval(()=>{const p=window.__elfura?.player;if(!p)return;const opts=p.getSources();const t=Date.now()-state.start;if(opts.length&&!state.first)state.first={ms:t,source17:opts.filter(s=>s.sourceId==='source-17').map(s=>s.fingerprint)};if(opts.some(s=>s.sourceId==='source-17')&&state.first17===null)state.first17=t},50)});
 for(const sample of samples){const begin=Date.now(),row={title:`${sample.type}/${sample.id}`,lanes:[]},requests=[];
  const onPlaybackResponse=r=>{try{const u=new URL(r.url());if(u.pathname==='/api/v1/playback')requests.push({ms:Date.now()-begin,late:u.searchParams.get('late')==='1',status:r.status()})}catch{}};page.on('response',onPlaybackResponse);
  try{
   await page.goto(`${base}/embed/${sample.type}/${sample.id}${sample.type==='tv'?'/1/1':''}?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:20000});
   await page.waitForTimeout(32000);
   const state=await page.evaluate(()=>({timing:window.__research,options:window.__elfura?.player?.getSources().filter(s=>s.sourceId==='source-17').map(s=>({id:s.id,fingerprint:s.fingerprint,type:s.type})),initialVideo:{source:window.__elfura?.player?.currentSource?.sourceId,width:window.__elfura?.player?.video?.videoWidth,time:window.__elfura?.player?.video?.currentTime}}));
   row.timing=state.timing;row.requests=requests;row.options=state.options;row.initialVideo=state.initialVideo;
   const discovered=observations.filter(o=>o.title===sample.id);const byFingerprint=new Map();
   row.discovery=discovered.map(o=>({node:o.node,start:o.started-begin,ms:o.ms,diag:o.diag,candidates:o.candidates.map(c=>{const entry={name:names.get(c.url)||'unknown',type:c.type,fp:fingerprint(c),evidence:cachedCandidateEvidence(c)?{alive:cachedCandidateEvidence(c).alive,dead:cachedCandidateEvidence(c).confirmedDead,duration:cachedCandidateEvidence(c).durationSec}:null};byFingerprint.set(entry.fp,entry);return entry})}));
   row.inventory=inventory.filter(i=>i.tmdb===sample.id).map(i=>i.rows);
   for(const option of (state.options||[]).slice(0,6)){const info=byFingerprint.get(option.fingerprint)||{name:'unknown'};const lane={name:info.name,type:option.type,fp:option.fingerprint};
    const responses={},hlsErrors=[];const onResponse=r=>{try{const u=new URL(r.url());if(u.hostname==='127.0.0.1'&&u.pathname==='/api/v1/stream'){const key=`${r.status()}:${(r.headers()['content-type']||'').split(';')[0]}`;responses[key]=(responses[key]||0)+1}}catch{}};page.on('response',onResponse);
    try{
     await page.evaluate(()=>{window.__hlsErrors=[];window.__seenHls=new WeakSet();window.__hlsInterval=setInterval(()=>{const h=window.__elfura?.player?.hls;if(h&&!window.__seenHls.has(h)){window.__seenHls.add(h);h.on('hlsError',(_,x)=>window.__hlsErrors.push({type:x?.type,details:x?.details,fatal:x?.fatal}))}},40)});
     const accepted=await page.evaluate(id=>window.__elfura.player.setSource(id),option.id);lane.accepted=accepted;
     await page.waitForFunction(fp=>{const p=window.__elfura.player,v=p.video;return p.currentSource?.fingerprint===fp&&v.videoWidth>0&&v.readyState>=2},option.fingerprint,{timeout:20000});
     const start=await page.evaluate(()=>window.__elfura.player.video.currentTime);
     await page.waitForFunction(({fp,start})=>{const p=window.__elfura.player,v=p.video;return p.currentSource?.fingerprint===fp&&v.videoWidth>0&&v.readyState>=2&&v.currentTime>start+3},{fp:option.fingerprint,start},{timeout:18000});
     lane.played=true;lane.video=await page.evaluate(()=>{const v=window.__elfura.player.video;return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime,duration:v.duration}});
    }catch(e){lane.played=false;lane.error=e.name;lane.state=await page.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {current:p?.currentSource?.sourceId,fp:p?.currentSource?.fingerprint,width:v?.videoWidth,time:v?.currentTime,ready:v?.readyState}}).catch(()=>null)}
    lane.errors=await page.evaluate(()=>{clearInterval(window.__hlsInterval);return window.__hlsErrors?.slice(0,10)||[]}).catch(()=>hlsErrors);page.off('response',onResponse);lane.responses=responses;row.lanes.push(lane);
   }
  }catch(e){row.error=e.name;row.errorMessage=String(e.message||'').replace(/https?:\/\/\S+/g,'[url]').slice(0,160)}
  notice('TGVIDX full flow '+sample.id,row);page.off('response',onPlaybackResponse);
 }
 // Explicit source-only embed is a different, bounded path; test it cold rather
 // than mistaking an all-source late wave or a warmed cache for success.
 for(const registry of registries){registry.ramCache.clear();registry.finishedLate.clear()}
 const focused={responses:[]},focusStart=Date.now();
 const onFocused=r=>{try{const u=new URL(r.url());if(u.pathname==='/api/v1/playback')focused.responses.push({ms:Date.now()-focusStart,status:r.status(),late:u.searchParams.get('late')==='1'})}catch{}};
 page.on('response',onFocused);
 try{await page.goto(`${base}/embed/tv/65942/1/1?autoplay=1&muted=1&source=source-17`,{waitUntil:'domcontentloaded',timeout:20000});await page.waitForTimeout(20000);
  focused.state=await page.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {sources:p?.getSources().map(x=>({source:x.sourceId,type:x.type})),current:p?.currentSource?.sourceId,width:v?.videoWidth,time:v?.currentTime}});
 }catch(e){focused.error=e.name}
 page.off('response',onFocused);notice('TGVIDX focused cold embed',focused);
}catch(e){notice('TGVIDX test fatal',{name:e.name,message:String(e.message||'').replace(/https?:\/\/\S+/g,'[url]').slice(0,180)});process.exitCode=1}
finally{await browser?.close().catch(()=>{});for(const s of servers.reverse()){s.closeAllConnections();await new Promise(r=>s.close(r))}globalThis.fetch=original;rmSync(tmp,{recursive:true,force:true})}
