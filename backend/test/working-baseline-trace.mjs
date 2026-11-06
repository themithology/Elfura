// Compare the deployed hybrid path with forced backend relay for the same
// title and source group. Never log URLs, tickets, headers or upstream names.
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const type=process.env.TRACE_TYPE||'movie',id=process.env.TRACE_ID||'693134',mode=process.env.TRACE_MODE||'hybrid',group=process.env.TRACE_SOURCE||'source-3';
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'});
let started=Date.now(),events=[],pending=new Map();
page.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/v1/stream')pending.set(r,{kind:'relay',at:Date.now()-started});else if(u.hostname!=='embed.theogpiratebot.online'&&['xhr','fetch','media'].includes(r.resourceType()))pending.set(r,{kind:'external',at:Date.now()-started});});
page.on('response',async r=>{let p=pending.get(r.request());if(p){const h=r.headers(),ct=(h['content-type']||'').split(';')[0];let cause=null;if(r.status()>=400 && ct==='application/json'){try{const body=await r.json();const e=String(body.error||'');if(/^upstream responded [0-9]{3}$/.test(e)||['invalid upstream manifest payload','blocked unsafe redirect','upstream returned HTML instead of media segment'].includes(e))cause=e;}catch{}}events.push({...p,ms:Date.now()-started,status:r.status(),ct,cause,cache:h['cf-cache-status']||null,cloudflare:!!h['cf-ray']});}});
page.on('requestfailed',r=>{let p=pending.get(r);if(p)events.push({...p,ms:Date.now()-started,error:r.failure()?.errorText});});
if(mode==='full') await page.route('**/api/v1/stream**',r=>{const u=new URL(r.request().url());u.searchParams.set('p','1');return r.continue({url:u.toString()});});
try {
 const route=type==='tv'?`tv/${id}/1/1`:`movie/${id}`;
 await page.goto(`https://embed.theogpiratebot.online/embed/${route}?autoplay=1&muted=1&source=${group}`,{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.__elfura?.player,null,{timeout:15000});
 let states=[];
 for(let i=0;i<25;i++) {
  const state=await page.evaluate(()=>{const p=window.__elfura.player;if(p.hls&&window.__hls!==p.hls){window.__hls=p.hls;window.__errors ||= [];p.hls.on('hlsError',(_e,d)=>window.__errors.push({detail:d.details,fatal:d.fatal,status:d.response?.code||null}));}return {time:p.video.currentTime,ready:p.video.readyState,paused:p.video.paused,group:p.currentSource?.sourceId||null,fp:p.currentSource?.fingerprint||null,audio:p.hls?.audioTracks?.map(t=>({lang:t.lang||null,name:t.name||null}))||[],available:p.getSources().map(s=>({group:s.sourceId,multi:!!s.multiAudio,lang:s.audioLang||null,fp:s.fingerprint||null})).slice(0,15),unavailable:document.querySelector('.elf-shell')?.dataset.unavailable,errors:(window.__errors||[]).slice(-5)};});
  states.push({ms:Date.now()-started,...state});if(state.time>10||state.unavailable==='true')break;await page.waitForTimeout(2000);
 }
 console.log('::notice title=WorkingBaseline::'+JSON.stringify({id,type,mode,group,firstPlaying:states.find(s=>s.time>0.5)||null,last:states.at(-1),events:events.slice(0,35)}));
} catch(e){console.log('::notice title=WorkingBaseline::'+JSON.stringify({id,type,mode,group,error:e.name,events:events.slice(0,35)}));process.exitCode=1;} finally{await browser.close();}
