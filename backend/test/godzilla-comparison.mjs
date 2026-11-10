// Compare real old deployment to the newer candidate. Never print URLs/tokens.
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
const mode=process.env.MODE||'candidate',id='940721';let server;
let base='https://embed.theogpiratebot.online';
if(mode==='test')base='http://opal.coffaie.online:4019';
if(mode==='candidate'){const cfg=loadBackendConfig();({server}=createBackendServer({...cfg,isProd:false,requireToken:false}));await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;}
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'});
const started=Date.now(),events=[];page.on('pageerror',e=>events.push({kind:'pageerror',message:e.message.slice(0,160)}));page.on('requestfailed',r=>{try{const u=new URL(r.url());if(u.origin===base)events.push({kind:'requestfailed',path:u.pathname,error:r.failure()?.errorText});}catch{}});page.on('response',async r=>{try{const u=new URL(r.url());if(u.pathname==='/api/v1/playback'||u.pathname==='/api/v1/stream')events.push({kind:u.pathname.endsWith('playback')?'playback':'stream',at:Date.now()-started,status:r.status(),ct:(r.headers()['content-type']||'').split(';')[0]});}catch{}});
try{await page.goto(`${base}/embed/movie/${id}?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForFunction(()=>window.__elfura?.player,null,{timeout:20000});let states=[];
 for(let i=0;i<23;i++) {const s=await page.evaluate(()=>{const p=window.__elfura.player;if(p.hls&&window.__traceHls!==p.hls){window.__traceHls=p.hls;window.__errs ||= [];p.hls.on('hlsError',(_e,d)=>window.__errs.push({detail:d.details,status:d.response?.code||null,fatal:d.fatal}));}return {time:p.video.currentTime,ready:p.video.readyState,paused:p.video.paused,source:p.currentSource?.sourceId||null,audioLang:p.currentSource?.audioLang||null,fp:p.currentSource?.fingerprint||null,sources:p.getSources().map(s=>({group:s.sourceId,multi:!!s.multiAudio,lang:s.audioLang||null,languages:s.availableAudioLangs||[]})).slice(0,30),unavailable:document.querySelector('.elf-shell')?.dataset.unavailable,errors:(window.__errs||[]).slice(-5)};});states.push({ms:Date.now()-started,...s});if(s.time>8||s.unavailable==='true')break;await page.waitForTimeout(2000);}
 const result={mode,firstPlaying:states.find(s=>s.time>0.5)||null,last:states.at(-1),events:events.filter(e=>e.kind==='playback'||e.kind==='pageerror'||e.kind==='requestfailed'||e.status>=400).slice(0,15)};
 console.log('::notice title=GodzillaCompare::'+JSON.stringify(result));
}catch(e){console.log('::notice title=GodzillaCompare::'+JSON.stringify({mode,error:e.name,events:events.slice(0,15)}));process.exitCode=1;}finally{await browser.close();if(server)await new Promise(r=>server.close(r));}
