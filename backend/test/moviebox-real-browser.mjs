// Diagnostic: real MovieBox -> production registry -> sealed relay -> browser.
// Logs only types, language, dimensions and state, never URLs or credentials.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createSource26Adapter} from '../../dist/backend/sources/source26.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const orig=globalThis.fetch;
globalThis.fetch=async (input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url ?? String(input));
 if(u.hostname==='tmdb-fixture.example') return Response.json({id:550,title:'Fight Club',original_title:'Fight Club',release_date:'1999-10-15',original_language:'en'});
 return orig(input,init);
};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'test',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});
registry.adapters=[createSource26Adapter(()=>true)];
let browser;
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const result=await registry.resolvePlayback({type:'movie',tmdbId:'550',sourceId:'source-26'});
 if(!result?.sources?.length) throw Error('No source options');
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();
 const rows=[];
 const supported=await page.evaluate(()=>({hevc:MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"'),avc:MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')}));
 for(const opt of result.sources.slice(0,8)) {
  await page.route('**/api/v1/playback**',route=>route.fulfill({json:{...result,primary:opt,sources:[opt],sourceGroups:[],pendingSources:[]}}));
  await page.goto(base+'/embed/movie/550?autoplay=1&muted=1',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{let v=window.__elfura?.player?.video;return v && v.currentTime>0.5 && v.readyState>=2 && v.videoWidth>0},null,{timeout:16000}).catch(()=>{});
  const state=await page.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {time:v?.currentTime??0,width:v?.videoWidth??0,height:v?.videoHeight??0,ready:v?.readyState??0,error:v?.error?.code??null,quality:p?.getQualityLevels().map(x=>x.height),audio:p?.getAudioTracks().map(x=>x.lang)}});
  rows.push({type:opt.type,label:opt.label,lang:opt.audioLang??null,claimedQuality:opt.quality,...state});
  await page.unroute('**/api/v1/playback**');
 }
 console.log('::notice title=Real MovieBox browser audit::'+JSON.stringify({supported,options:rows}));
 if(!rows.some(r=>r.width>0 && r.time>0.5)) console.log('::warning title=MovieBox video unavailable::No option rendered video in this browser');
} catch(error) {console.log('::error title=MovieBox browser audit::'+String(error).replace(/https?:\/\/\S+/g,'[url]').slice(0,300));process.exitCode=1;}
finally {await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
