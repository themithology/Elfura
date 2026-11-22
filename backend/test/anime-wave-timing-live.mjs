// Real Sources 28/29/30 in the full registry, four local resolver servers,
// real media relay and Chromium. TMDB is a known fixture, not a live latency
// measurement. Never emit upstream URLs, tickets, response bodies or secrets.
import {createBackendServer} from '../../dist/backend/index.js';
import {createResolverServer} from '../../dist/backend/resolver-server.js';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {installEgressProfile} from '../../dist/backend/egress.js';
import {tapRequests} from '../../dist/backend/sources/net-tap.js';
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
const secret='fixture-only-anime-timing-secret-0987654321';
process.env.ELFURA_SECRET=secret;process.env.ELFURA_RESOLVER_TOKEN=secret;process.env.ELFURA_SELF_TEST='0';process.env.ELFURA_RESOLVER_ALLOW_LOCAL='0';process.env.TMDB_DISABLE_FALLBACK='1';
const tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-anime-waves-'));process.env.ROXY_DATA_DIR=tmp;
const samples=[{id:'46260',title:'Naruto',episode:'Enter: Naruto Uzumaki!',year:'2002',runtime:24},{id:'95479',title:'Jujutsu Kaisen',episode:'Ryomen Sukuna',year:'2020',runtime:24},{id:'65942',title:'Re:ZERO -Starting Life in Another World-',episode:'The End of the Beginning and the Beginning of the End',year:'2016',runtime:49}];
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(u.hostname!=='tmdb-fixture.example')return original(input,init);const parts=u.pathname.split('/'),i=parts.indexOf('tv'),sample=samples.find(s=>s.id===parts[i+1]);if(!sample)return new Response(null,{status:404});if(parts.includes('episode'))return Response.json({name:sample.episode,runtime:sample.runtime});return Response.json({id:Number(sample.id),name:sample.title,original_name:sample.title,first_air_date:sample.year+'-01-01',original_language:'ja',genres:[{name:'Animation'}],episode_run_time:[sample.runtime],images:{logos:[]},external_ids:{}})};
const servers=[],observations=[];let browser;const now=()=>Date.now();
const listen=async server=>{servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`};
const notice=(title,x)=>console.log(`::notice title=${title}::${JSON.stringify(x).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,9000)}`);
try{
 await installEgressProfile(()=>{});
 const cfg=loadBackendConfig({ELFURA_SECRET:secret,TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
 const urls=[];
 for(let i=0;i<4;i++){
  const registry=new SourceRegistry(cfg);
  registry.adapters=registry.adapters.map(a=>!['source-28','source-29','source-30'].includes(a.id)?a:{...a,async resolve(q){
   const begin=now(),diag=[],partial=[];let metaMs;
   try{const tapped=await tapRequests(()=>a.resolve({...q,diag,resolveMetaFallback:async()=>{const m=await q.resolveMetaFallback?.();metaMs=now()-begin;return m},onLateResult:r=>{partial.push({ms:now()-begin,count:r.candidates.length});q.onLateResult?.(r)}}));
    observations.push({node:i+1,title:q.tmdbId,id:a.id,start:begin,end:now(),ms:now()-begin,metaMs,raw:tapped.value.candidates.length,variants:tapped.value.candidates.map(c=>c.audioVariant||'multi'),diag,partial,network:tapped.net.map(n=>({host:n.host,status:n.status,error:n.error,ms:n.ms}))});return tapped.value;
   }catch(e){observations.push({node:i+1,title:q.tmdbId,id:a.id,start:begin,end:now(),ms:now()-begin,error:e.name});throw e;}
  }});
  urls.push(await listen(createResolverServer({cfg,registry,token:secret,log:()=>{}}).server));
 }
 [process.env.ELFURA_RESOLVER_URL,process.env.ELFURA_RESOLVER_BACKUP_URL,process.env.ELFURA_RESOLVER_THIRD_URL,process.env.ELFURA_RESOLVER_FOURTH_URL]=urls;
 const app=createBackendServer({...cfg,isProd:false,requireToken:false});const base=await listen(app.server);
 browser=await chromium.launch({executablePath:await binary.executablePath(),args:[...binary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 await page.addInitScript(()=>{const state=window.__timing={start:Date.now(),first:null,seen:{},requests:[]};setInterval(()=>{const p=window.__elfura?.player;if(!p)return;const all=p.getSources?.()||[];const t=Date.now()-state.start;if(all.length&&state.first===null)state.first={ms:t,groups:[...new Set(all.map(x=>x.sourceId))]};for(const opt of all){if(['source-28','source-29','source-30'].includes(opt.sourceId)&&state.seen[opt.sourceId]===undefined)state.seen[opt.sourceId]=t}},50)});
 for(const sample of samples){const started=now(),events=[],row={title:sample.id,playback:[]};
  const onResponse=r=>{try{const u=new URL(r.url());if(u.pathname==='/api/v1/playback')events.push({ms:now()-started,late:u.searchParams.get('late')==='1',source:u.searchParams.get('source'),status:r.status()})}catch{}};page.on('response',onResponse);
  try{
   await page.goto(`${base}/embed/tv/${sample.id}/1/1?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:20000});
   await page.waitForTimeout(26000);
   row.observed=await page.evaluate(()=>{const p=window.__elfura?.player;const v=p?.video;return {timing:window.__timing,options:p?.getSources().map(s=>({source:s.sourceId,type:s.type,variant:s.audioVariant??null,priority:!!s.animePriority})),video:{source:p?.currentSource?.sourceId,time:v?.currentTime,width:v?.videoWidth,ready:v?.readyState}}});
   for(const id of ['source-28','source-29','source-30']){
    const opt=await page.evaluate(id=>window.__elfura?.player?.getSources().find(x=>x.sourceId===id)?.id??null,id);const result={id,available:!!opt};
    if(opt)try{await page.evaluate(id=>window.__elfura.player.setSource(id),opt);const t0=await page.evaluate(()=>window.__elfura.player.video.currentTime);await page.waitForFunction(({id,t0})=>{const p=window.__elfura.player,v=p.video;return p.currentSource?.sourceId===id&&v.videoWidth>0&&v.readyState>=2&&v.currentTime>t0+1},{id,t0},{timeout:20000});result.played=true;result.video=await page.evaluate(()=>{const v=window.__elfura.player.video;return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime,duration:v.duration}})}catch(e){result.played=false;result.error=e.name}
    row.playback.push(result);
   }
  }catch(e){row.error=e.name;}finally{page.off('response',onResponse)}
  row.requests=events;row.adapters=observations.filter(x=>x.title===sample.id).map(x=>({...x,start:x.start-started,end:x.end-started}));notice('Anime timings '+sample.id,row);
 }
}catch(e){notice('Anime timing failure',{name:e.name,message:String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,200)});process.exitCode=1}
finally{await browser?.close().catch(()=>{});for(const s of servers.reverse()){s.closeAllConnections();await new Promise(r=>s.close(r))}globalThis.fetch=original;rmSync(tmp,{recursive:true,force:true})}
