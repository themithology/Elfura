// Browser regression: the initial HLS request never responds. The player must
// recover a later provider or show a terminal retry state, not spin forever.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {execFileSync} from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const tmp=mkdtempSync(path.join(tmpdir(),'elfura-recovery-'));
try { execFileSync(ffmpeg.path,['-loglevel','error','-filter_threads','1','-threads','1','-f','lavfi','-i','color=c=blue:s=320x180:r=25','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','8','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-f','mpegts',path.join(tmp,'segment.ts')],{stdio:'pipe'}); } catch(e) { console.log('::error title=FixtureError::'+JSON.stringify({message:e.message,stderr:String(e.stderr||'').slice(0,1000)})); process.exit(1); }
const media=readFileSync(path.join(tmp,'segment.ts'));
const cfg=loadBackendConfig();const {server}=createBackendServer({...cfg,isProd:false,requireToken:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;let browser,page;
const dead={id:'source-3:1',sourceId:'source-3',label:'Source 3',type:'hls',url:'/fixture/dead.m3u8',quality:'auto',fingerprint:'dead-1',audioTracks:[],subtitles:[]};
const good={...dead,id:'source-2:1',sourceId:'source-2',label:'Source 2',url:'/fixture/good.m3u8',fingerprint:'good-2'};
const mode=process.env.RECOVERY_MODE||'recover';let requests=[];
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});page=await browser.newPage();
 await page.route('**/api/v1/playback**',async route=>{const u=new URL(route.request().url()),group=u.searchParams.get('source');requests.push(group||'combined');const sources=group==='source-2'&&mode==='recover'?[good]:[dead];await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,primary:sources[0],sources})});});
 await page.route('**/fixture/**',async route=>{const u=new URL(route.request().url());if(u.pathname.endsWith('dead.m3u8')){setTimeout(()=>route.abort().catch(()=>{}),30000);return;}if(u.pathname.endsWith('good.m3u8'))return route.fulfill({status:200,contentType:'application/vnd.apple.mpegurl',body:'#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n#EXTINF:8,\nsegment.ts\n#EXT-X-ENDLIST\n'});return route.fulfill({status:200,contentType:'video/mp2t',body:media});});
 await page.goto(`${base}/embed/movie/693134?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:20000});
 if(mode==='recover')await page.waitForFunction(()=>window.__elfura?.player?.currentSource?.sourceId==='source-2'&&window.__elfura.player.video.currentTime>1,null,{timeout:30000});
 else await page.waitForFunction(()=>document.querySelector('.elf-shell')?.dataset.unavailable==='true',null,{timeout:30000});
 const state=await page.evaluate(()=>({source:window.__elfura.player.currentSource?.sourceId,time:window.__elfura.player.video.currentTime,ready:window.__elfura.player.video.readyState,loading:document.querySelector('.elf-shell')?.dataset.initialLoading,unavailable:document.querySelector('.elf-shell')?.dataset.unavailable}));
 if(state.loading==='true'||!requests.includes('source-2')||!requests.includes('source-3'))throw new Error('missing bounded recovery');
 console.log('::notice title=StartupRecovery::'+JSON.stringify({mode,ok:true,state,requests}));
}catch(e){const state=await page?.evaluate(()=>({source:window.__elfura?.player?.currentSource?.sourceId,time:window.__elfura?.player?.video?.currentTime,ready:window.__elfura?.player?.video?.readyState,loading:document.querySelector('.elf-shell')?.dataset.initialLoading,unavailable:document.querySelector('.elf-shell')?.dataset.unavailable})).catch(()=>null);console.log('::notice title=StartupRecovery::'+JSON.stringify({mode,ok:false,error:e.name,state,requests}));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));rmSync(tmp,{recursive:true,force:true});}
