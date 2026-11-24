// Live integration: real source discovery -> sealed production relay -> browser.
// Never print upstream URLs, cookies, tokens, or titles from the provider.
import assert from 'node:assert/strict';
import {createBackendServer} from '../../../dist/backend/index.js';
import {loadBackendConfig} from '../../../dist/backend/config.js';
import {createSource27Adapter} from '../../../dist/backend/sources/source27.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url ?? String(input));
 if(u.hostname==='tmdb-fixture.example') return Response.json({id:299534,title:'Avengers: Endgame',original_title:'Avengers: Endgame',release_date:'2019-04-26',original_language:'en',runtime:181});
 return originalFetch(input,init);
};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});
registry.adapters=[createSource27Adapter(()=>true)];
let browser,page,step='resolve';
const responses={},failures=[];
server.on('request',(req,res)=>{if(req.url?.startsWith('/api/proxy?'))res.on('finish',()=>{const key=`${res.statusCode}:${String(res.getHeader('content-type')??'').split(';')[0]}`;responses[key]=(responses[key]??0)+1;});});
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const result=await registry.resolvePlayback({type:'movie',tmdbId:'299534',sourceId:'source-27'});
 assert(result?.sources?.length,'no source found');
 assert(result.sources.some(s=>s.multiAudio && s.availableAudioLangs?.includes('hi') && s.availableAudioLangs?.includes('en')),'registry did not verify both languages');
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 page=await browser.newPage();
 page.on('requestfailed',req=>{if(req.url().includes('/api/proxy?'))failures.push(req.failure()?.errorText??'failed');});
 await page.route('**/api/v1/playback**',route=>route.fulfill({json:{...result,sourceGroups:[],pendingSources:[]}}));
 await page.goto(base+'/embed/movie/299534?autoplay=1&muted=1',{waitUntil:'domcontentloaded'});
 step='render video';
 await page.waitForFunction(()=>{const p=window.__elfura?.player,v=p?.video;return v?.videoWidth>0 && v.currentTime>1 && v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:30000});
 const before=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video;return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime,duration:v.duration,frames:v.getVideoPlaybackQuality().totalVideoFrames,tracks:p.getAudioTracks().map(t=>t.lang),levels:p.getQualityLevels().map(q=>q.height)}});
 assert(before.tracks.includes('hi') && before.tracks.includes('en'));
 assert(before.duration>7000 && before.duration<13000,`wrong movie duration: ${before.duration}`);
 step='switch English';
 assert.equal(await page.evaluate(()=>window.__elfura.player.setAudio('en')),true);
 await page.waitForFunction(()=>{let p=window.__elfura.player;let h=p.hls;return h && h.audioTracks[h.audioTrack]?.lang==='en'},null,{timeout:15000});
 step='switch Hindi';
 assert.equal(await page.evaluate(()=>window.__elfura.player.setAudio('hi')),true);
 await page.waitForFunction(()=>{let p=window.__elfura.player;let h=p.hls;return h && h.audioTracks[h.audioTrack]?.lang==='hi'},null,{timeout:15000});
 await page.waitForFunction(frames=>window.__elfura.player.video.getVideoPlaybackQuality().totalVideoFrames>frames,before.frames,{timeout:15000});
 console.log('::notice title=Real multilingual browser::'+JSON.stringify({ok:true,...before,switched:['en','hi']}));
} catch(error) {
 const state=await page?.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {time:v?.currentTime,width:v?.videoWidth,height:v?.videoHeight,duration:v?.duration,ready:v?.readyState,tracks:p?.getAudioTracks().map(t=>t.lang)}}).catch(()=>null);
 console.log('::error title=Real multilingual browser::'+JSON.stringify({step,error:String(error).replace(/https?:\/\/\S+/g,'[url]').slice(0,250),state,responses,failures:failures.slice(0,10)}));process.exitCode=1;
} finally {await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=originalFetch;}
