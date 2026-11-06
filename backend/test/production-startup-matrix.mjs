// Production-only browser observation. Never log media URLs, tickets or headers.
// First frame means decoded video data is available and playback has advanced;
// it is measured from navigation, not the end of the observation interval.
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const type=process.env.TEST_TYPE||'movie',id=process.env.TEST_TMDB||'807';
const route=type==='tv'?`tv/${id}/${process.env.TEST_SEASON||'1'}/${process.env.TEST_EPISODE||'1'}`:`movie/${id}`;
let start=Date.now(),browser,page;
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'});
 start=Date.now();
 await page.goto(`https://embed.theogpiratebot.online/embed/${route}?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.__elfura?.player,null,{timeout:15000});
 // Ask for muted playback immediately; do not wait 10 seconds before starting.
 await page.evaluate(()=>{const p=window.__elfura.player;p.video.muted=true;void p.play();});
 const limit=Date.now()+45000;let first=null,last=null;
 while(Date.now()<limit){
  last=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video;return {time:v.currentTime,ready:v.readyState,width:v.videoWidth,height:v.videoHeight,paused:v.paused,source:p.currentSource?.sourceId||null,multi:!!p.currentSource?.multiAudio,native:p.getAudioTracks().filter(t=>t.kind==='native').map(t=>({lang:t.lang,label:t.label})),loading:document.querySelector('.elf-loading-screen')?.dataset.visible,unavailable:document.querySelector('.elf-unavailable-screen')?.dataset.visible};});
  if(!first&&last.ready>=2&&last.width>0&&last.time>0.05)first={ms:Date.now()-start,time:last.time};
  if(first && last.time>=first.time+5)break;
  if(last.unavailable==='true'&&!first)break;
  await page.waitForTimeout(250);
 }
 let hindi=null;
 if(first&&last?.multi&&new Set(last.native.map(t=>t.lang)).size>=2&&last.native.some(t=>t.lang==='hi')){
  hindi=await page.evaluate(async()=>{const p=window.__elfura.player,before=p.video.currentTime,id=p.currentSource?.id;const result=await Promise.race([p.setAudio('hi'),new Promise(r=>setTimeout(()=>r('timeout'),10000))]);await new Promise(r=>setTimeout(r,3000));return {result,sameSource:p.currentSource?.id===id,language:p.getState().audioLang,advance:p.video.currentTime-before,ready:p.video.readyState};});
 }
 const sustained=!!first&&last.time>=first.time+5;
 console.log('::notice title=ProductionMatrix::'+JSON.stringify({type,id,firstFrameMs:first?.ms??null,sustained,state:last,hindi}));
 if(!sustained)process.exitCode=1;
}catch(e){console.log('::notice title=ProductionMatrix::'+JSON.stringify({type,id,error:e.name,elapsedMs:Date.now()-start}));process.exitCode=1;}
finally{await browser?.close();}
