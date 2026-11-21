// Diagnostic only: real source -> production registry -> sealed relay -> browser.
// Never log upstream URLs, provider IDs, response bodies or credentials.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createSource16Adapter} from '../../dist/backend/sources/source16.js';
import {createSource18Adapter} from '../../dist/backend/sources/source18.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const orig=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url ?? String(input));
 if(u.hostname==='tmdb-fixture.example') return Response.json({id:46260,name:'Naruto',original_name:'Naruto',first_air_date:'2002-10-03',original_language:'ja',episode_run_time:[24]});
 return orig(input,init);
};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});
let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();const results=[];
 for(const [id,adapter,episodes] of [['source-16',createSource16Adapter(()=>true),[1,2]],['source-18',createSource18Adapter(()=>true),[1]]]){
  registry.adapters=[adapter];
  for(const episode of episodes){
   let result;try{result=await registry.resolvePlayback({type:'tv',tmdbId:'46260',anilistId:'20',season:1,episode,sourceId:id});}catch{}
   if(!result?.sources?.length){results.push({id,episode,options:0});continue;}
   const opt=result.sources[0];
   await page.route('**/api/v1/playback**',route=>route.fulfill({json:{...result,primary:opt,sources:[opt],sourceGroups:[],pendingSources:[]}}));
   await page.goto(base+`/embed/tv/46260/1/${episode}?autoplay=1`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>{let v=window.__elfura?.player?.video;return v && v.currentTime>1 && v.videoWidth>0 && v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:20000}).catch(()=>{});
   const state=await page.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {time:v?.currentTime??0,width:v?.videoWidth??0,height:v?.videoHeight??0,duration:Number.isFinite(v?.duration)?v.duration:null,frames:v?.getVideoPlaybackQuality().totalVideoFrames??0,ready:v?.readyState??0,error:v?.error?.code??null,audio:p?.getAudioTracks().map(t=>t.lang)}});
   results.push({id,episode,options:result.sources.length,type:opt.type,lang:opt.audioLang??null,quality:opt.quality,...state});
   await page.unroute('**/api/v1/playback**');
  }
 }
 console.log('::notice title=Real anime browser audit::'+JSON.stringify(results));
 if(results.some(r=>!(r.width>0 && r.frames>0 && r.time>1)))console.log('::warning title=Anime playback failures::One or more selected samples did not render');
}catch(e){console.log('::error title=Anime browser audit::'+String(e).replace(/https?:\/\/\S+/g,'[url]').slice(0,250));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
