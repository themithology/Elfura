// Full local Elfura backend/player against the original provider. Never log upstream URLs or keys.
import { createBackendServer } from '../../dist/backend/index.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const base=loadBackendConfig();
const dead='http://127.0.0.1:1';
const {server}=createBackendServer({
  ...base, isProd:false, resolveTimeoutMs:10000,
  source1:{...base.source1,appOrigin:dead,apiOrigin:dead,riftOrigin:dead,vidrockOrigin:dead,vidlinkOrigin:dead,vidboltOrigin:'https://vidbolt.xyz'},
  source3:{...base.source3,enabled:false},
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
function notice(data){console.log(`::notice title=VidboltElfura::${JSON.stringify(data).replace(/%/g,'%25').replace(/\n/g,'%0A')}`);}
let browser;
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();
 for(const c of [{type:'tv',id:'93405',path:'tv/93405/1/1'}, {type:'movie',id:'693134',path:'movie/693134'}]) {
  let step='open';
  try {
   await page.goto(`http://127.0.0.1:${port}/embed/${c.path}?source=source-2`,{waitUntil:'domcontentloaded',timeout:30000});
   step='source';
   await page.waitForFunction(()=>window.__elfura?.player?.getSources().some(s=>s.sourceId==='source-2' && s.multiAudio),null,{timeout:45000});
   const info=await page.evaluate(()=>{const p=window.__elfura.player;const s=p.getSources().find(x=>x.sourceId==='source-2'&&x.multiAudio);return {id:s.id,langs:s.availableAudioLangs,qualities:s.qualityLadder};});
   step='select';
   await page.evaluate(async id=>{const p=window.__elfura.player;p.video.muted=true;await p.setSource(id);await p.play();},info.id);
   step='tracks';
   await page.waitForFunction(()=>window.__elfura.player.hls?.audioTracks?.some(t=>/^(hi|hin)(-|$)/i.test(t.lang||'')),null,{timeout:20000});
   step='hindi';
   const selected=await page.evaluate(async()=>{const p=window.__elfura.player;const h=p.hls;window.__audioSegments=0;window.__hlsErrors=[];h.on('hlsFragBuffered',(_e,d)=>{if(d.frag?.type==='audio')window.__audioSegments++;});h.on('hlsError',(_e,d)=>{if(window.__hlsErrors.length<12)window.__hlsErrors.push({details:d.details,fatal:d.fatal,status:d.response?.code||null});});const ok=await p.setAudio('hi');return {ok,lang:h.audioTracks[h.audioTrack]?.lang||null};});
   await page.waitForFunction(()=>window.__audioSegments>0 && window.__elfura.player.video.currentTime>0.1,null,{timeout:35000});
   const state=await page.evaluate(()=>({audioSegments:window.__audioSegments,time:window.__elfura.player.video.currentTime,source:window.__elfura.player.currentSource?.sourceId,errors:window.__hlsErrors}));
   if(!selected.ok||!state.audioSegments||state.source!=='source-2')throw new Error('playback assertion failed');
   notice({id:c.id,success:true,languages:info.langs,qualities:info.qualities,selected,...state});
  } catch(e){
   const snapshot=await page.evaluate(()=>({source:window.__elfura?.player?.currentSource?.sourceId||null,time:window.__elfura?.player?.video?.currentTime||0,audioSegments:window.__audioSegments||0,errors:window.__hlsErrors||[]})).catch(()=>null);
   notice({id:c.id,success:false,step,error:e.name,snapshot});process.exitCode=1;
  }
 }
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
