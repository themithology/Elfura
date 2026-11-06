// Live production investigation. No secrets, signed URLs, or headers in output.
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const id=process.env.TRACE_ID||'693134',type=process.env.TRACE_TYPE||'movie';
const route=type==='tv'?`tv/${id}/1/1`:`movie/${id}`;
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'});
const start=Date.now();const requests=new Map();const events=[];
page.on('request',r=>{try{const u=new URL(r.url());if(u.hostname==='embed.theogpiratebot.online'&&/^\/api\/v1\/(playback|stream)/.test(u.pathname)){requests.set(r,{route:u.pathname,source:u.searchParams.get('source'),start:Date.now()-start});}else if(u.hostname!=='embed.theogpiratebot.online'&&['xhr','fetch','media'].includes(r.resourceType()))requests.set(r,{route:'external',source:null,start:Date.now()-start});}catch{}});
page.on('response',r=>{const entry=requests.get(r.request());if(entry)events.push({...entry,elapsed:Date.now()-start,status:r.status(),contentType:(r.headers()['content-type']||'').split(';')[0]});});
page.on('requestfailed',r=>{const entry=requests.get(r);if(entry)events.push({...entry,elapsed:Date.now()-start,error:r.failure()?.errorText});});
page.on('pageerror',e=>events.push({stage:'pageerror',message:e.message.slice(0,140)}));
try {
 await page.goto(`https://embed.theogpiratebot.online/embed/${route}?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.__elfura?.player,null,{timeout:20000});
 await page.evaluate(()=>{const p=window.__elfura.player;p.video.muted=true;void p.play();});
 const states=[];for(let i=0;i<30;i++){
  const s=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video,h=p.hls;if(h && window.__traceHls!==h){window.__traceHls=h;window.__hlsErrors ||= [];h.on('hlsError',(_e,d)=>window.__hlsErrors.push({details:d.details,fatal:d.fatal,status:d.response?.code||null}));}return {errors:window.__hlsErrors||[],time:v.currentTime,ready:v.readyState,paused:v.paused,network:v.networkState,source:p.currentSource?.sourceId||null,sourceMulti:!!p.currentSource?.multiAudio,srcAssigned:!!p.config.src,engine:p.engine,hlsAttached:!!h,levels:h?.levels?.length??0,audio:h?.audioTracks?.length??0,buffered:v.buffered.length,loading:document.querySelector('.elf-loading-screen')?.dataset.visible,unavailable:document.querySelector('.elf-unavailable-screen')?.dataset.visible,sources:p.getSources().map(s=>({id:s.sourceId,multi:!!s.multiAudio,lang:s.audioLang||null})),failed:[...p.failedSourceIds],probe:!!p.activeProbe}});
  states.push({ms:Date.now()-start,...s});if(s.unavailable==='true'||s.time>8)break;await page.waitForTimeout(2000);
 }
 console.log('::notice title=ProductionPipeline::'+JSON.stringify({id,type,states,events:events.slice(0,90)}));
}catch(e){console.log('::notice title=ProductionPipeline::'+JSON.stringify({id,type,error:e.name,ms:Date.now()-start,events:events.slice(0,90)}));process.exitCode=1;}
finally{await browser.close();}
