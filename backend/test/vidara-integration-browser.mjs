// Real upstream + actual Elfura registry, relay and player. No signed URLs logged.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-secret',NODE_ENV:'production',REQUIRE_PLAYBACK_TOKEN:'0',OPENSUBTITLES_ENABLED:'0',SOURCE1_ENABLED:'0',SOURCE3_ENABLED:'0',RELAY_MODE:'full'});
const {server,registry}=createBackendServer(cfg);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
let browser,page;let statuses=[];const start=Date.now();
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 page=await browser.newPage();page.on('response',r=>{const u=new URL(r.url());if(u.pathname==='/api/v1/stream'||u.pathname==='/api/v1/playback')statuses.push({endpoint:u.pathname,status:r.status()});});
 await page.goto(`${base}/embed/movie/1107009?source=source-5&autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.__elfura?.player?.video?.currentTime>2,null,{timeout:45000});
 const before=await page.evaluate(()=>{const p=window.__elfura.player;return {time:p.video.currentTime,ready:p.video.readyState,source:p.currentSource?.sourceId,multi:p.currentSource?.multiAudio,tracks:p.getAudioTracks().filter(t=>t.kind==='native').map(t=>({lang:t.lang,label:t.label})),current:p.getState().audioLang};});
 const switched=await page.evaluate(()=>window.__elfura.player.setAudio('te'));await page.waitForTimeout(6000);
 const after=await page.evaluate(()=>{const p=window.__elfura.player;return {time:p.video.currentTime,ready:p.video.readyState,current:p.getState().audioLang,source:p.currentSource?.sourceId};});
 if(before.source!=='source-5'||!before.multi||!before.tracks.some(t=>t.lang.split('-')[0]==='hi')||!before.tracks.some(t=>t.lang.split('-')[0]==='te')||!switched||after.current?.split('-')[0]!=='te'||after.source!=='source-5'||after.time-before.time<2)throw new Error('verification failed');
 console.log('::notice title=VidaraIntegration::'+JSON.stringify({ok:true,ms:Date.now()-start,before,after,switched,statuses:[...new Set(statuses.map(x=>JSON.stringify(x)))].map(x=>JSON.parse(x))}));
}catch(e){let state=await page?.evaluate(()=>{const p=window.__elfura?.player;return {source:p?.currentSource?.sourceId,time:p?.video?.currentTime,ready:p?.video?.readyState,tracks:p?.getAudioTracks().map(t=>({lang:t.lang,kind:t.kind})),unavailable:document.querySelector('.elf-shell')?.dataset.unavailable};}).catch(()=>null);const diag=await registry.diagnosePlayback({type:'movie',tmdbId:'1107009'}).catch(()=>null);console.log('::notice title=VidaraIntegration::'+JSON.stringify({ok:false,error:e.name,state,diag,statuses:[...new Set(statuses.map(x=>JSON.stringify(x)))].map(x=>JSON.parse(x))}));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));}
