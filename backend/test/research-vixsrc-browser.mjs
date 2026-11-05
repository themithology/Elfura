// Exercise the production player and relay against the original catalog.
import { createBackendServer } from '../../dist/backend/index.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { openStreamTicket } from '../../dist/backend/security.js';
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const base=loadBackendConfig(),dead='http://127.0.0.1:1';
const {server,cfg}=createBackendServer({...base,isProd:false,resolveTimeoutMs:10000,source1:{...base.source1,appOrigin:dead,apiOrigin:dead,vidlinkOrigin:dead,vidboltOrigin:dead,riftOrigin:dead,rockOrigin:dead},source3:{...base.source3,enabled:true,origin:dead,vixOrigin:'https://vixsrc.to'}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const notice=data=>console.log(`::notice title=VixBrowser::${JSON.stringify(data).replace(/%/g,'%25').replace(/\n/g,'%0A')}`);
let browser;
try{browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
for(const c of [{id:'93405',path:'tv/93405/1/1',original:'ko'},{id:'289517',path:'tv/289517/1/1',original:'ko'},{id:'693134',path:'movie/693134',original:'en'}]){let step='open';try{
await page.goto(`http://127.0.0.1:${port}/embed/${c.path}?source=source-3`,{waitUntil:'domcontentloaded',timeout:30000});step='source';
await page.waitForFunction(()=>window.__elfura?.player?.getSources().some(s=>s.sourceId==='source-3'&&s.multiAudio),null,{timeout:45000});
const options=await page.evaluate(()=>window.__elfura.player.getSources().filter(s=>s.sourceId==='source-3'&&s.multiAudio).map(s=>({id:s.id,url:s.url,langs:s.availableAudioLangs,qualities:s.qualityLadder})));
const info=options.find(s=>{try{return /(?:^|\.)vixsrc\.to$/.test(new URL(openStreamTicket(cfg.secret,new URL(s.url,`http://127.0.0.1:${port}`).searchParams.get('t')).u).hostname)}catch{return false;}});if(!info)throw new Error('candidate missing');
step='play';await page.evaluate(async id=>{const p=window.__elfura.player;p.video.muted=true;await p.setSource(id);await p.play();},info.id);
step='tracks';await page.waitForFunction(()=>window.__elfura.player.hls?.audioTracks?.length>=2,null,{timeout:20000});
await page.evaluate(()=>{const h=window.__elfura.player.hls;window.__audioLevels=[];window.__hlsErrors=[];h.on('hlsFragBuffered',(_e,d)=>{if(d.frag?.type==='audio')window.__audioLevels.push(d.frag.level)});h.on('hlsError',(_e,d)=>{if(window.__hlsErrors.length<12)window.__hlsErrors.push({details:d.details,fatal:d.fatal,status:d.response?.code||null});});});
const switches=[];for(const lang of ['it',c.original,'it']){step='switch-'+lang;const selection=await page.evaluate(async lang=>{const p=window.__elfura.player;window.__audioLevels=[];const ok=await p.setAudio(lang);return {ok,lang:p.hls?.audioTracks[p.hls.audioTrack]?.lang||null};},lang);if(!selection.ok||selection.lang!==lang)throw new Error('selection failed');await page.waitForFunction(()=>window.__audioLevels?.includes(window.__elfura.player.hls?.audioTrack)&&window.__elfura.player.video.currentTime>0.1,null,{timeout:35000});const state=await page.evaluate(()=>({levels:window.__audioLevels,index:window.__elfura.player.hls.audioTrack,time:window.__elfura.player.video.currentTime,source:window.__elfura.player.currentSource?.sourceId}));if(state.source!=='source-3')throw new Error('source fallback');switches.push({lang,...state});}
const quality=[];for(const target of [720,480]){step='quality-'+target;const found=await page.evaluate(target=>{const p=window.__elfura.player;const yes=p.getQualityLevels().some(q=>q.height===target);p.setQuality(target);return yes;},target);if(!found)throw new Error('quality missing');await page.waitForFunction(target=>window.__elfura.player.video.videoHeight===target&&window.__elfura.player.currentSource?.sourceId==='source-3',target,{timeout:35000});quality.push({target,rendered:await page.evaluate(()=>window.__elfura.player.video.videoHeight)});}
notice({id:c.id,success:true,langs:info.langs,qualities:info.qualities,switches,quality});
}catch(e){const snapshot=await page.evaluate(()=>({source:window.__elfura?.player?.currentSource?.sourceId,time:window.__elfura?.player?.video?.currentTime,errors:window.__hlsErrors||[],tracks:window.__elfura?.player?.hls?.audioTracks?.map(x=>x.lang)||[]})).catch(()=>null);notice({id:c.id,success:false,step,error:e.message,snapshot});process.exitCode=1;}}
}finally{await browser?.close();await new Promise(r=>server.close(r));}
