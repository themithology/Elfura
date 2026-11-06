// Live browser audit: only VidSync is enabled. Log no tickets, URLs or headers.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const cfg=loadBackendConfig();
const type=process.env.SYNC_TYPE==='tv'?'tv':'movie',id=process.env.SYNC_TMDB||'872585';
const {server}=createBackendServer({...cfg,isProd:false,source1:{...cfg.source1,enabled:false},source3:{...cfg.source3,enabled:true}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;let browser,page,step='open';
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 page=await browser.newPage();const path=type==='tv'?`tv/${id}/1/1`:`movie/${id}`;
 await page.goto(`http://127.0.0.1:${port}/embed/${path}?source=source-3&lang=hi`,{waitUntil:'domcontentloaded',timeout:25000});
 step='source';await page.waitForFunction(()=>window.__elfura?.player?.getSources().some(s=>s.sourceId==='source-3'&&s.audioLang==='hi'),null,{timeout:30000});
 const selected=await page.evaluate(async()=>{const p=window.__elfura.player;const opt=p.getSources().find(s=>s.sourceId==='source-3'&&s.audioLang==='hi');p.video.muted=true;await p.setSource(opt.id);await p.play();return {id:opt.sourceId,lang:opt.audioLang,multi:!!opt.multiAudio};});
 step='playing';await page.waitForFunction(()=>window.__elfura.player.video.currentTime>1 && window.__elfura.player.video.readyState>=2,null,{timeout:40000});
 const state=await page.evaluate(()=>({time:window.__elfura.player.video.currentTime,source:window.__elfura.player.currentSource?.sourceId,lang:window.__elfura.player.currentSource?.audioLang,tracks:window.__elfura.player.getAudioTracks().map(t=>({lang:t.lang,kind:t.kind}))}));
 if(state.source!=='source-3'||state.lang!=='hi'||selected.multi)throw new Error('unexpected source or language classification');
 console.log('::notice title=VidSyncBrowser::'+JSON.stringify({id,type,ok:true,selected,state}));
} catch(e) {const snapshot=await page?.evaluate(()=>({time:window.__elfura?.player?.video?.currentTime,source:window.__elfura?.player?.currentSource?.sourceId,options:window.__elfura?.player?.getSources().map(s=>({source:s.sourceId,lang:s.audioLang,multi:s.multiAudio}))})).catch(()=>null);console.log('::notice title=VidSyncBrowser::'+JSON.stringify({id,type,ok:false,step,error:e?.name,snapshot}));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));}
