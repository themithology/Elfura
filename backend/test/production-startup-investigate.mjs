// Production observation: only timing/state and error classes; never print URLs or tokens.
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'});
const start=Date.now();const events=[];page.on('response',r=>{try{let u=new URL(r.url());if(u.hostname==='embed.theogpiratebot.online' && /\/api\/v1\/(session|playback|stream)/.test(u.pathname))events.push({ms:Date.now()-start,route:u.pathname,source:u.searchParams.get('source'),status:r.status()});}catch{}});
try {
 await page.goto('https://embed.theogpiratebot.online/embed/movie/693134?autoplay=1&muted=1',{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.__elfura?.player,null,{timeout:15000});
 await page.evaluate(()=>{const p=window.__elfura.player;p.video.muted=true;void p.play();});
 const snapshots=[];
 for(let i=0;i<19;i++){
   const state=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video;return {time:v.currentTime,ready:v.readyState,paused:v.paused,width:v.videoWidth,source:p.currentSource?.sourceId||null,sources:p.getSources().map(s=>({source:s.sourceId,multi:!!s.multiAudio,lang:s.audioLang||null})),loading:document.querySelector('.elf-loading-screen')?.dataset.visible,unavailable:document.querySelector('.elf-unavailable-screen')?.dataset.visible}});
   snapshots.push({ms:Date.now()-start,...state}); if(state.unavailable==='true'||state.time>5)break;await page.waitForTimeout(2500);
 }
 console.log('::notice title=ProductionStartup::'+JSON.stringify({snapshots,events:events.slice(0,100)}));
}catch(e){console.log('::notice title=ProductionStartup::'+JSON.stringify({error:e.name,ms:Date.now()-start,events:events.slice(0,100)}));process.exitCode=1;}
finally {await browser.close();}
