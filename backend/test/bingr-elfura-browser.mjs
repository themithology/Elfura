import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const base=loadBackendConfig();
const {server}=createBackendServer({...base,isProd:false,resolveTimeoutMs:10000});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port; let browser; let step='open';
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();
 await page.goto(`http://127.0.0.1:${port}/embed/tv/93405/1/1?source=source-4&lang=hi`,{waitUntil:'domcontentloaded',timeout:30000});
 step='source'; await page.waitForFunction(()=>window.__elfura?.player?.getSources().length>0,null,{timeout:45000});
 step='play'; await page.evaluate(async()=>{const p=window.__elfura.player;p.video.muted=true;await p.play();});
 await page.waitForFunction(()=>window.__elfura?.player?.video?.currentTime>2,null,{timeout:45000});
 step='hindi-track';
 await page.waitForFunction(()=>window.__elfura?.player?.hls?.audioTracks?.some(t=>/^(hi|hin)(-|$)/i.test(t.lang||'')),null,{timeout:20000});
 const switched=await page.evaluate(async()=>{const p=window.__elfura.player;window.__hiAudio=0;p.hls.on('hlsFragBuffered',(_e,d)=>{if(d.frag?.type==='audio' && d.frag.level===p.hls.audioTrack)window.__hiAudio++});const ok=await p.setAudio('hi');return {ok,lang:p.hls.audioTracks[p.hls.audioTrack]?.lang};});
 if(!switched.ok || switched.lang !== 'hi') throw new Error('Hindi switch failed');
 await page.waitForFunction(()=>window.__hiAudio>0,null,{timeout:35000});
 const state=await page.evaluate(()=>({time:window.__elfura.player.video.currentTime,source:window.__elfura.player.currentSource?.sourceId,options:window.__elfura.player.getSources().map(s=>({lang:s.audioLang,multi:!!s.multiAudio,languages:s.availableAudioLangs}))}));
 if(state.source!=='source-4') throw new Error('unexpected source');
 console.log('::notice title=BingrBrowser::'+JSON.stringify({success:true,switched,...state}));
} catch(e){console.log('::notice title=BingrBrowser::'+JSON.stringify({success:false,step,error:e.name}));process.exitCode=1;}
finally {await browser?.close();await new Promise(r=>server.close(r));}
