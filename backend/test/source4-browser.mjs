import {createBackendServer} from '../../dist/backend/index.js';
import {chromium} from 'playwright-core';import chromiumBinary from '@sparticuz/chromium';
const log=v=>console.log('::notice title=AnimeBrowser::'+JSON.stringify(v).replace(/%/g,'%25'));
const {server}=createBackendServer({isProd:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;let browser;
try{browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 for(const id of ['95479','1429']){
 const page=await browser.newPage();let step='open';let start=Date.now();
 try{await page.goto(`http://127.0.0.1:${port}/embed/tv/${id}/1/1?source=source-4&lang=hi`,{waitUntil:'domcontentloaded',timeout:25000});
 step='source';await page.waitForFunction(()=>window.__elfura?.player?.getSources().some(s=>s.sourceId==='source-4'&&s.multiAudio&&s.availableAudioLangs?.includes('hi')),null,{timeout:25000});
 step='tracks';await page.evaluate(async()=>{const p=window.__elfura.player;p.video.muted=true;await p.play()});await page.waitForFunction(()=>window.__elfura?.player?.hls?.audioTracks?.some(t=>t.lang==='hi'),null,{timeout:20000});
 step='playing';await page.waitForFunction(()=>window.__elfura.player.video.currentTime>0.4,null,{timeout:35000});const initial=await page.evaluate(()=>({time:window.__elfura.player.video.currentTime,lang:window.__elfura.player.hls.audioTracks[window.__elfura.player.hls.audioTrack]?.lang,langs:window.__elfura.player.hls.audioTracks.map(t=>t.lang),title:window.__elfura.player.mediaInfo?.rawTitle}));
 const switches=[];for(const lang of ['en','hi']){step='switch-'+lang;const sel=await page.evaluate(async lang=>{const p=window.__elfura.player;window.__frags=[];p.hls.on('hlsFragBuffered',(_e,d)=>{if(d.frag?.type==='audio')window.__frags.push(d.frag.level)});const ok=await p.setAudio(lang);return {ok,lang:p.hls.audioTracks[p.hls.audioTrack]?.lang}},lang);if(!sel.ok||sel.lang!==lang)throw Error('selection failed');await page.waitForFunction(()=>window.__frags?.includes(window.__elfura.player.hls?.audioTrack),null,{timeout:35000});switches.push(sel);}
 log({id,success:true,firstFrameMs:Date.now()-start,initial,switches});
 }catch(e){log({id,success:false,step,error:e.name,snapshot:await page.evaluate(()=>({source:window.__elfura?.player?.currentSource?.sourceId,time:window.__elfura?.player?.video?.currentTime,sources:window.__elfura?.player?.getSources().map(s=>({id:s.sourceId,multi:s.multiAudio,langs:s.availableAudioLangs}))})).catch(()=>null)});process.exitCode=1}finally{await page.close()}
 }
}finally{await browser?.close();await new Promise(r=>server.close(r))}
