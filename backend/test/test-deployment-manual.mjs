import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const mode=process.env.MODE||'direct';const start=Date.now();
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:chromiumBinary.args});
const page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'});
let errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text().replace(/https?:\/\/[^\s"']+/g,'[url]').slice(0,180));});page.on('pageerror',e=>errors.push(e.message.slice(0,180)));page.on('requestfailed',r=>{try{const u=new URL(r.url());if(u.hostname==='opal.coffaie.online')errors.push(`${u.pathname}: ${r.failure()?.errorText}`);}catch{}});
try{
 if(mode==='iframe'){
  await page.goto('https://embed.theogpiratebot.online/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.evaluate(()=>{let f=document.createElement('iframe');f.src='http://opal.coffaie.online:4019/embed/movie/940721';document.body.appendChild(f);});
  await page.waitForTimeout(10000);
  const frames=page.frames().map(f=>({origin:(()=>{try{return new URL(f.url()).origin}catch{return ''}})(),player:f.url().includes('/embed/movie/940721')}));
  console.log('::notice title=TestManual::'+JSON.stringify({mode,ms:Date.now()-start,frames,errors:errors.slice(0,15)}));
 }else{
  await page.goto('http://opal.coffaie.online:4019/embed/movie/940721',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForFunction(()=>window.__elfura?.player,null,{timeout:20000});
  await page.waitForTimeout(12000);
  let before=await page.evaluate(()=>{let p=window.__elfura.player;return {time:p.video.currentTime,paused:p.video.paused,ready:p.video.readyState,source:p.currentSource?.sourceId,loading:document.querySelector('.elf-loading-screen')?.dataset.visible,overlay:document.querySelector('.elf-unavailable-screen')?.dataset.visible,unavailable:document.querySelector('.elf-shell')?.dataset.unavailable,bigplay:getComputedStyle(document.querySelector('.elf-bigplay')).pointerEvents,playbtn:getComputedStyle(document.querySelector('.elf-play-btn')).pointerEvents};});
  let click='';try{await page.locator('.elf-bigplay').click({timeout:3500});click='bigplay';}catch(e){click=e.name;}
  await page.waitForTimeout(8000);
  let after=await page.evaluate(()=>{let p=window.__elfura.player;return {time:p.video.currentTime,paused:p.video.paused,ready:p.video.readyState,source:p.currentSource?.sourceId,loading:document.querySelector('.elf-loading-screen')?.dataset.visible,overlay:document.querySelector('.elf-unavailable-screen')?.dataset.visible,unavailable:document.querySelector('.elf-shell')?.dataset.unavailable};});
  console.log('::notice title=TestManual::'+JSON.stringify({mode,ms:Date.now()-start,before,click,after,errors:errors.slice(0,15)}));
 }
}catch(e){console.log('::notice title=TestManual::'+JSON.stringify({mode,error:e.name,ms:Date.now()-start,errors:errors.slice(0,15)}));}finally{await browser.close();}
