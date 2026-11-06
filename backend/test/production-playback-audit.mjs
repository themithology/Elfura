// Reproduce the real deployment, using default player settings (not isolated adapters).
// Never print tokens, query strings, raw media URLs, or provider headers.
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const base='https://embed.theogpiratebot.online';
const cases=[{path:'movie/693134'},{path:'movie/872585'},{path:'tv/95479/1/1'}];
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:chromiumBinary.args});
for(const test of cases){
 const page=await browser.newPage();const events=[];let step='open';
 function target(u){try {const x=new URL(u);return {host:x.hostname,path:x.pathname.startsWith('/api/v1/stream')?'/api/v1/stream':x.pathname.startsWith('/api/v1/playback')?'/api/v1/playback':x.pathname.startsWith('/assets/')?'/assets/[asset]':x.pathname};} catch{return {host:'invalid',path:'invalid'}}}
 page.on('response',r=>{const u=target(r.url());if(u.path.startsWith('/api/')||r.status()>=400)events.push({kind:'response',...u,status:r.status()})});
 page.on('requestfailed',r=>{const u=target(r.url());events.push({kind:'failed',...u,error:r.failure()?.errorText})});
 page.on('pageerror',e=>events.push({kind:'pageerror',error:e.name,message:e.message.slice(0,150)}));
 try{
  await page.goto(`${base}/embed/${test.path}`,{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>!!window.__elfura?.player,null,{timeout:15000});
  await page.waitForTimeout(15000);
  const before=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video;return {time:v.currentTime,ready:v.readyState,network:v.networkState,paused:v.paused,source:p.currentSource&&{id:p.currentSource.sourceId,type:p.currentSource.type,multi:p.currentSource.multiAudio},sources:p.getSources().map(s=>({id:s.sourceId,type:s.type,multi:s.multiAudio,lang:s.audioLang})),error:v.error?.code,loading:document.querySelector('.elf-loading-status')?.textContent,body:document.body.innerText.slice(0,350),buttons:[...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')||b.title).filter(Boolean).slice(0,20)}});
  step='play';
  const play=await page.evaluate(async()=>{const p=window.__elfura.player;try{await p.play();return 'resolved'}catch(e){return e.name}});
  await page.waitForTimeout(15000);
  const after=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video;return {time:v.currentTime,ready:v.readyState,network:v.networkState,paused:v.paused,source:p.currentSource&&{id:p.currentSource.sourceId,type:p.currentSource.type,multi:p.currentSource.multiAudio},error:v.error?.code,loading:document.querySelector('.elf-loading-status')?.textContent,body:document.body.innerText.slice(0,350)}});
  console.log('::notice title=ProductionPlayback::'+JSON.stringify({path:test.path,step,play,before,after,events:events.slice(-35)}));
 }catch(e){console.log('::notice title=ProductionPlayback::'+JSON.stringify({path:test.path,step,error:e.name,events:events.slice(-35)}));}
 await page.close();
}
await browser.close();
