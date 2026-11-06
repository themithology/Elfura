// End-to-end budget: hung playback API, stalled HLS, retry and stale responses.
import {createBackendServer} from '../../dist/backend/index.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const {server}=createBackendServer({isProd:false,requireToken:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
const dead={id:'source-3:1',sourceId:'source-3',label:'Source 3',type:'hls',url:'/fixture/dead.m3u8',quality:'auto',fingerprint:'dead-1',audioTracks:[],subtitles:[]};
const out=[];
try {
 for (const mode of ['hung-api','hung-media']) {
  browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();let combined=0;const start=Date.now();
  await page.route('**/api/v1/playback**',async route=>{
   const url=new URL(route.request().url()),group=url.searchParams.get('source');
   if(!group)combined++;
   if(mode==='hung-api' && combined===1 && !group){setTimeout(()=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,primary:dead,sources:[dead]})}).catch(()=>{}),13000);return;}
   if(mode==='hung-api')return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:'No sources'})});
   if(!group)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,primary:dead,sources:[dead]})});
   setTimeout(()=>route.abort().catch(()=>{}),20000);
  });
  await page.route('**/fixture/**',route=>{setTimeout(()=>route.abort().catch(()=>{}),20000)});
  await page.goto(`${base}/embed/movie/693134?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:20000});
  await page.waitForFunction(()=>document.querySelector('.elf-unavailable-screen')?.dataset.visible==='true',null,{timeout:12000});
  const elapsed=Date.now()-start;
  const first=await page.evaluate(()=>({loading:document.querySelector('.elf-loading-screen')?.dataset.visible,unavailable:document.querySelector('.elf-unavailable-screen')?.dataset.visible,source:window.__elfura.player.currentSource?.sourceId||null}));
  if(elapsed>10500 || first.loading!=='false') throw Error(`deadline failed: ${mode} ${elapsed}`);
  let retry=null;
  if(mode==='hung-api') {
   await page.click('.elf-state-retry');
   await page.waitForFunction(()=>document.querySelector('.elf-unavailable-screen')?.dataset.visible==='true',null,{timeout:5000});
   await page.waitForTimeout(Math.max(0,14500-(Date.now()-start)));
   retry=await page.evaluate(()=>({loading:document.querySelector('.elf-loading-screen')?.dataset.visible,unavailable:document.querySelector('.elf-unavailable-screen')?.dataset.visible,source:window.__elfura.player.currentSource?.sourceId||null}));
   if(retry.loading!=='false'||retry.unavailable!=='true'||retry.source)throw Error('late result resurrected failed attempt');
  }
  out.push({mode,elapsed,first,retry});await browser.close();browser=null;
 }
 console.log('::notice title=StartupDeadline::'+JSON.stringify({ok:true,out}));
}catch(e){console.log('::notice title=StartupDeadline::'+JSON.stringify({ok:false,error:e.message,out}));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));}
