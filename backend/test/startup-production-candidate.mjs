// Candidate frontend running in a browser against the real production backend.
// Only the JS bundle is replaced in this test; nothing is deployed.
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {readFileSync,readdirSync} from 'node:fs';
const bundle=readdirSync('dist/assets').find(f=>/^embed-.*\.js$/.test(f));if(!bundle)throw Error('missing candidate bundle');
const body=readFileSync(`dist/assets/${bundle}`);
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:393,height:873},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'});
let injected=false;await page.route('**/assets/embed-*.js',route=>{injected=true;return route.fulfill({status:200,contentType:'application/javascript',body});});
try {
 const nav=Date.now();await page.goto('https://embed.theogpiratebot.online/embed/movie/693134?autoplay=1&muted=1',{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>window.__elfura?.player,null,{timeout:15000});const ready=Date.now();
 await page.evaluate(()=>{const p=window.__elfura.player;p.video.muted=true;void p.play();});
 await page.waitForFunction(()=>{const p=window.__elfura?.player;return document.querySelector('.elf-unavailable-screen')?.dataset.visible==='true'||(p?.video?.readyState>=2&&p.video.currentTime>0.05)},null,{timeout:12000});
 const state=await page.evaluate(()=>{const p=window.__elfura.player;return {time:p.video.currentTime,ready:p.video.readyState,source:p.currentSource?.sourceId||null,loading:document.querySelector('.elf-loading-screen')?.dataset.visible,unavailable:document.querySelector('.elf-unavailable-screen')?.dataset.visible}});
 const result={injected,navigationMs:ready-nav,afterPlayerMs:Date.now()-ready,state};
 console.log('::notice title=CandidateProduction::'+JSON.stringify(result));
 if(!injected || result.afterPlayerMs>10500 || state.loading==='true')throw Error('candidate failed deadline');
}catch(e){console.log('::notice title=CandidateProduction::'+JSON.stringify({error:e.name,message:e.message.slice(0,180),injected}));process.exitCode=1;}
finally{await browser.close();}
