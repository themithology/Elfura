// Candidate frontend + backend with real upstreams, isolated from production.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const type=process.env.TEST_TYPE||'movie',id=process.env.TEST_ID||'693134',group=process.env.TEST_GROUP||'source-14';
const cfg=loadBackendConfig();const {server}=createBackendServer({...cfg,isProd:false,requireToken:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser,page,stage='open';const start=Date.now();
try{
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true});const route=type==='tv'?`tv/${id}/1/1`:`movie/${id}`;
 await page.goto(`http://127.0.0.1:${server.address().port}/embed/${route}?source=${group}&autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:30000});
 stage='play';await page.waitForFunction(()=>window.__elfura?.player?.video.currentTime>3,null,{timeout:50000});
 const before=await page.evaluate(()=>{const p=window.__elfura.player;return {time:p.video.currentTime,src:p.currentSource?.sourceId,lang:p.currentSource?.audioLang||null,audio:p.hls?.audioTracks?.map(t=>t.lang)||[],options:p.getSources().map(s=>({lang:s.audioLang||null,multi:!!s.multiAudio,langs:s.availableAudioLangs||[]}))};});
 stage='hindi';const switched=await page.evaluate(async()=>{const p=window.__elfura.player;const ok=await p.setAudio('hi');return {ok,lang:p.hls?.audioTracks?.[p.hls.audioTrack]?.lang||p.currentSource?.audioLang||null,time:p.video.currentTime};});
 if(!switched.ok||!/^hi(?:-|$)/i.test(switched.lang||''))throw Error('Hindi not actually selected');
 stage='after-switch';await page.waitForFunction(t=>window.__elfura?.player?.video?.readyState>=2&&window.__elfura.player.video.currentTime>t+2,switched.time,{timeout:45000});
 const after=await page.evaluate(()=>{const p=window.__elfura.player;return {time:p.video.currentTime,src:p.currentSource?.sourceId,lang:p.hls?.audioTracks?.[p.hls.audioTrack]?.lang||p.currentSource?.audioLang||null,ready:p.video.readyState};});
 console.log('::notice title=CurrentPlayback::'+JSON.stringify({id,type,group,ok:true,ms:Date.now()-start,before,switched,after}));
}catch(e){const state=await page?.evaluate(()=>{const p=window.__elfura?.player;return p?{time:p.video.currentTime,src:p.currentSource?.sourceId,ready:p.video.readyState,unavailable:document.querySelector('.elf-shell')?.dataset.unavailable,sources:p.getSources().map(s=>({lang:s.audioLang||null,multi:!!s.multiAudio,langs:s.availableAudioLangs||[]})),failed:[...p.failedSourceIds]}:null}).catch(()=>null);console.log('::notice title=CurrentPlayback::'+JSON.stringify({id,type,group,ok:false,stage,error:e.name,ms:Date.now()-start,state}));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));}
