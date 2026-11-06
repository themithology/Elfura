// Candidate frontend against the actual production backend; no production change.
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {readFileSync,readdirSync} from 'node:fs';
const bundle=readdirSync('dist/assets').find(f=>/^embed-.*\.js$/.test(f));if(!bundle)throw Error('missing candidate bundle');
const body=readFileSync(`dist/assets/${bundle}`);
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'});
const started=Date.now(),events=[],pending=new Map();
page.on('request',r=>{try{const u=new URL(r.url());if(u.pathname.includes('/api/v1/stream')||['media','xhr','fetch'].includes(r.resourceType())&&u.hostname!=='embed.theogpiratebot.online')pending.set(r,{stage:u.pathname.includes('/api/v1/stream')?'relay':'external',start:Date.now()-started});}catch{}});
page.on('response',r=>{const p=pending.get(r.request());if(p)events.push({...p,done:Date.now()-started,status:r.status(),ct:(r.headers()['content-type']||'').split(';')[0]});});
page.on('requestfailed',r=>{const p=pending.get(r);if(p)events.push({...p,done:Date.now()-started,error:r.failure()?.errorText});});
let injected=false;await page.route('**/assets/embed-*.js',route=>{injected=true;return route.fulfill({status:200,contentType:'application/javascript',body});});
try {
 const nav=Date.now(),type=process.env.TRACE_TYPE||'movie',id=process.env.TRACE_ID||'693134',route=type==='tv'?`tv/${id}/1/1`:`movie/${id}`;
 await page.goto(`https://embed.theogpiratebot.online/embed/${route}?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.__elfura?.player,null,{timeout:15000});const ready=Date.now();
 await page.evaluate(()=>{const p=window.__elfura.player;p.video.muted=true;void p.play();});
 let states=[];
 for(let i=0;i<15;i++){
   const state=await page.evaluate(()=>{const p=window.__elfura.player;if(p.hls && window.__traceHls!==p.hls){window.__traceHls=p.hls;window.__traceErrors ||= [];p.hls.on('hlsError',(_e,d)=>window.__traceErrors.push({details:d.details,fatal:d.fatal,status:d.response?.code||null}));}return {errors:window.__traceErrors||[],time:p.video.currentTime,ready:p.video.readyState,source:p.currentSource?.sourceId||null,loading:document.querySelector('.elf-loading-screen')?.dataset.visible,overlay:document.querySelector('.elf-unavailable-screen')?.dataset.visible,unavailable:document.querySelector('.elf-shell')?.dataset.unavailable,title:document.querySelector('.elf-unavailable-title')?.textContent,levels:p.hls?.levels?.length||0,audio:p.hls?.audioTracks?.length||0}});
   states.push({ms:Date.now()-ready,...state});if(state.time>3||state.unavailable==='true')break;await page.waitForTimeout(2000);
 }
 const result={id,type,injected,navigationMs:ready-nav,states,events:events.slice(0,40)};
 console.log('::notice title=CandidateProduction::'+JSON.stringify(result));
 if(!injected || !states.some(x=>x.ms<=11000&&x.loading==='false'))throw Error('candidate failed loading transition');
}catch(e){console.log('::notice title=CandidateProduction::'+JSON.stringify({error:e.name,message:e.message.slice(0,180),injected}));process.exitCode=1;}
finally{await browser.close();}
