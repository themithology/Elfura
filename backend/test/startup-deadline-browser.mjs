// Real-browser regression: a slow valid media stream must survive the 9s UI transition.
import {createBackendServer} from '../../dist/backend/index.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {execFileSync} from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const tmp=mkdtempSync(path.join(tmpdir(),'elfura-slow-'));
execFileSync(ffmpeg.path,['-loglevel','error','-filter_threads','1','-threads','1','-f','lavfi','-i','color=c=blue:s=320x180:r=25','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','8','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-f','mpegts',path.join(tmp,'segment.ts')]);
const media=readFileSync(path.join(tmp,'segment.ts'));
const {server}=createBackendServer({isProd:false,requireToken:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
const stream={id:'source-14:1',sourceId:'source-14',label:'Source 14',type:'hls',url:'/fixture/slow.m3u8',quality:'auto',fingerprint:'slow-1',audioTracks:[],subtitles:[]};
const out=[];
try {
 for(const mode of ['slow-media','retry-late-api']) {
  browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();const start=Date.now();let combined=0;
  await page.route('**/api/v1/playback**',async route=>{
   const group=new URL(route.request().url()).searchParams.get('source');if(!group)combined++;
   if(mode==='retry-late-api'&&combined===1&&!group){setTimeout(()=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,primary:stream,sources:[stream]})}).catch(()=>{}),13000);return;}
   if(mode==='retry-late-api')return route.fulfill({status:404,contentType:'application/json',body:'{"error":"No sources"}'});
   if(!group){setTimeout(()=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,primary:stream,sources:[stream]})}).catch(()=>{}),4000);return;}
   return route.fulfill({status:404,contentType:'application/json',body:'{}'});
  });
  await page.route('**/fixture/**',route=>{
   if(new URL(route.request().url()).pathname.endsWith('.m3u8'))return route.fulfill({status:200,contentType:'application/vnd.apple.mpegurl',body:'#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n#EXTINF:8,\nsegment.ts\n#EXT-X-ENDLIST\n'});
   setTimeout(()=>route.fulfill({status:200,contentType:'video/mp2t',body:media}).catch(()=>{}),6500);
  });
  await page.goto(`${base}/embed/movie/693134?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:20000});
  await page.waitForFunction(()=>document.querySelector('.elf-unavailable-screen')?.dataset.visible==='true',null,{timeout:11000});
  const elapsed=Date.now()-start;
  const slow=await page.evaluate(()=>({loading:document.querySelector('.elf-loading-screen')?.dataset.visible,unavailable:document.querySelector('.elf-shell')?.dataset.unavailable,title:document.querySelector('.elf-unavailable-title')?.textContent,source:window.__elfura.player.currentSource?.sourceId||null}));
  if(elapsed>10500||slow.loading!=='false'||slow.unavailable==='true'||!slow.title?.includes('Taking longer'))throw Error('slow state incorrect');
  let after;
  if(mode==='slow-media') {
   await page.waitForFunction(()=>window.__elfura.player.video.currentTime>0.1,null,{timeout:10000});
   after=await page.evaluate(()=>({time:window.__elfura.player.video.currentTime,source:window.__elfura.player.currentSource?.sourceId,visible:document.querySelector('.elf-unavailable-screen')?.dataset.visible}));
   if(after.source!=='source-14'||after.visible!=='false')throw Error('slow valid stream did not resume');
  } else {
   await page.click('.elf-state-retry');
   await page.waitForFunction(()=>document.querySelector('.elf-shell')?.dataset.unavailable==='true',null,{timeout:5000});
   await page.waitForTimeout(Math.max(0,14500-(Date.now()-start)));
   after=await page.evaluate(()=>({unavailable:document.querySelector('.elf-shell')?.dataset.unavailable,source:window.__elfura.player.currentSource?.sourceId||null}));
   if(after.unavailable!=='true'||after.source)throw Error('stale result resurrected retry');
  }
  out.push({mode,elapsed,slow,after});await browser.close();browser=null;
 }
 console.log('::notice title=StartupDeadline::'+JSON.stringify({ok:true,out}));
}catch(e){console.log('::notice title=StartupDeadline::'+JSON.stringify({ok:false,error:e.message,out}));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));rmSync(tmp,{recursive:true,force:true});}
