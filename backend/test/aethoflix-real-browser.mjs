// Hosted Chromium research against the actual Aethoflix UI, no tokens/URLs logged.
import {chromium} from 'playwright-core';import chromiumBinary from '@sparticuz/chromium';
const type=process.env.TEST_TYPE||'movie',id=process.env.TEST_TMDB||'693134';
const path=type==='tv'?`tv/${id}/1/1`:`movie/${id}`;const started=Date.now();
let browser,page;const events=[];
try{
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true});
 page.on('response',r=>{try{const u=new URL(r.url());if(u.pathname.startsWith('/backend/servers/')||u.pathname==='/api/extract'||u.pathname==='/api/scan')events.push({path:u.pathname.replace(/\/edge$/, '/[edge]'),status:r.status()})}catch{}});
 await page.goto(`https://embed.aethoflix.live/embed/${path}`,{waitUntil:'domcontentloaded',timeout:30000});
 const start=page.getByText('Start Playback',{exact:false}).first();if(await start.isVisible({timeout:10000}).catch(()=>false))await start.click({timeout:5000});
 let final=null,firstMs=null;const end=Date.now()+45000;while(Date.now()<end){final=await page.evaluate(()=>{const v=document.querySelector('video');return {time:v?.currentTime??0,ready:v?.readyState??0,width:v?.videoWidth??0,paused:v?.paused??true,error:v?.error?.code??null,body:document.body.innerText.slice(0,400)}});if(final.time>0.1&&final.ready>=2&&firstMs===null)firstMs=Date.now()-started;if(firstMs&&final.time>5)break;await page.waitForTimeout(500)}
 console.log('::notice title=AethoBrowser::'+JSON.stringify({type,id,firstMs,final,events:events.slice(-12)}));
}catch(e){console.log('::notice title=AethoBrowser::'+JSON.stringify({type,id,error:e.name,events:events.slice(-12)}));process.exitCode=1;}
finally{await browser?.close()}
