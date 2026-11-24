// Real HLS playback with deterministic local media and a parent iframe. No live
// providers are involved. Tests next, episode selector, auto advance, host
// messages, start-offset removal and same-episode source position preservation.
import assert from 'node:assert/strict';
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const tmp=mkdtempSync(path.join(tmpdir(),'elfura-episode-'));
execFileSync(ffmpeg.path,['-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=2','-t','80','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-g','16','-hls_time','8','-hls_list_size','0','-f','hls',path.join(tmp,'movie.m3u8')]);
const playlist=readFileSync(path.join(tmp,'movie.m3u8'));
const {server}=createBackendServer({...loadBackendConfig(),isProd:false,requireToken:false});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
let browser,page,frame,step='launch';
const playbackRequests=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try {
  browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
  page=await browser.newPage({viewport:{width:1100,height:800}});
  await page.route('**/host-episode-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><iframe id="player" allow="autoplay; fullscreen" style="width:1000px;height:700px"></iframe><script>
    window.playerMessages=[];
    const frame=document.getElementById('player');
    window.addEventListener('message',e=>{if(e.origin===location.origin && e.source===frame.contentWindow && e.data?.__elfura===1)window.playerMessages.push(e.data)});
    frame.src='/embed/tv/1399/1/1?autoplay=1&muted=1&autoplayNextEp=0&lang=hi&t=25&origin='+encodeURIComponent(location.origin);
  </script></body></html>`}));
  await page.route('**/api/v1/playback**',async route=>{
    const url=new URL(route.request().url());
    const season=Number(url.searchParams.get('s')||1), episode=Number(url.searchParams.get('e')||1);
    playbackRequests.push({season,episode,source:url.searchParams.get('source')});
    if(season===1 && episode===3) await sleep(900); // late prewarm, for race regression
    const source=(i)=>({id:`source-${i}:${season}:${episode}`,sourceId:`source-${i}`,label:`Source ${i}`,type:'hls',url:`/fixture/s${season}e${episode}/source${i}/movie.m3u8`,quality:'auto',fingerprint:`s${season}e${episode}-${i}`,audioLang:i===3?'en':'hi',availableAudioLangs:[i===3?'en':'hi'],audioTracks:[],subtitles:[]});
    const sources=[source(1),source(2),source(3)];
    return route.fulfill({json:{ok:true,primary:sources[0],sources,sourceGroups:['source-1','source-2'],pendingSources:[],media:{type:'tv',tmdbId:'1399',season,episode,title:'Test Show'}}});
  });
  await page.route('**/api/v1/episodes**',route=>{
    const url=new URL(route.request().url());const season=Number(url.searchParams.get('s')||1);
    return route.fulfill({json:{ok:true,tmdbId:'1399',season,seasons:[{seasonNumber:1,name:'Season 1',episodeCount:5},{seasonNumber:2,name:'Season 2',episodeCount:2}],episodes:Array.from({length:season===1?5:2},(_,i)=>({seasonNumber:season,episodeNumber:i+1,name:`Episode ${i+1}`,runtime:80,still:null}))}});
  });
  await page.route('**/api/v1/segments**',route=>route.fulfill({json:{ok:true,segments:{}}}));
  await page.route('**/fixture/**',route=>{
    const file=path.basename(new URL(route.request().url()).pathname);
    return route.fulfill({status:200,contentType:file.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t',body:file.endsWith('.m3u8')?playlist:readFileSync(path.join(tmp,file))});
  });
  await page.goto(base+'/host-episode-test',{waitUntil:'domcontentloaded'});
  frame=page.frames().find(f=>f!==page.mainFrame());assert(frame,'iframe did not attach');
  step='initial playback';
  await frame.waitForFunction(()=>window.__elfura?.player?.video?.readyState>=2 && window.__elfura.player.getNextEpisodeTarget()?.episode===2,null,{timeout:30000});
  await frame.evaluate(()=>{const v=window.__elfura.player.video;v.currentTime=70;v.dispatchEvent(new Event('timeupdate'));});
  await frame.waitForFunction(()=>window.__elfura.player.prewarmedNext?.episode===2,null,{timeout:15000});
  step='click prewarmed next with preferred audio';
  await frame.waitForFunction(()=>document.querySelector('.elf-next-ep-wrap')?.dataset.visible==='true',null,{timeout:7000});
  await frame.locator('.elf-next-ep-btn').click({force:true});
  await frame.waitForFunction(()=>{const p=window.__elfura.player;return p.config.episode===2&&p.currentSource?.url.includes('/s1e2/')&&p.video.readyState>=2},null,{timeout:20000});
  await frame.waitForTimeout(700);
  const second=await frame.evaluate(()=>({time:window.__elfura.player.video.currentTime,source:window.__elfura.player.currentSource?.url,lang:window.__elfura.player.desiredAudioLang,path:location.pathname,search:location.search}));
  assert(second.time<5,`prewarmed episode started at old time: ${JSON.stringify(second)}`);
  assert.equal(second.lang,'hi');assert.equal(second.path,'/embed/tv/1399/1/2');
  assert(!new URLSearchParams(second.search).has('t'),'old start offset survived navigation');
  await page.waitForFunction(()=>window.playerMessages.filter(m=>m.name==='episodeChange').length===1);
  let changes=await page.evaluate(()=>window.playerMessages.filter(m=>m.name==='episodeChange'));
  assert.deepEqual(changes[0].data,{mediaType:'tv',tmdbId:'1399',season:1,episode:2,previous:{season:1,episode:1}});
  assert.equal(changes[0].v,1);assert.equal(changes[0].kind,'event');
  assert.deepEqual(Object.keys(changes[0].data).sort(),['episode','mediaType','previous','season','tmdbId']);
  step='same-episode source switch preserves position';
  await frame.evaluate(()=>{window.__elfura.player.video.currentTime=14;});
  await frame.evaluate(()=>window.__elfura.player.setSource('source-2'));
  await frame.waitForFunction(()=>{const p=window.__elfura.player;return p.currentSource?.sourceId==='source-2'&&p.video.readyState>=2&&p.video.currentTime>=13},null,{timeout:20000});
  await frame.evaluate(()=>window.__elfura.player.loadEpisode(1,2));
  assert((await frame.evaluate(()=>window.__elfura.player.video.currentTime))>=13,'same episode must keep resume position');
  assert.equal(await page.evaluate(()=>window.playerMessages.filter(m=>m.name==='episodeChange').length),1,'same episode must not report a change');
  await frame.evaluate(()=>window.__elfura.player.setAudio('en'));
  await frame.waitForFunction(()=>{const p=window.__elfura.player;return p.currentSource?.audioLang==='en'&&p.video.readyState>=2&&p.video.currentTime>=13},null,{timeout:20000});
  // Start a slow prewarm for episode 3, then immediately choose episode 4.
  // A late response from episode 2 must not re-populate old prewarmed state.
  step='episode selector and stale prewarm';
  await frame.evaluate(()=>{let v=window.__elfura.player.video;v.currentTime=70;v.dispatchEvent(new Event('timeupdate'));});
  await page.waitForFunction(()=>true);
  for(let i=0;i<30&&!playbackRequests.some(r=>r.episode===3);i++)await sleep(50);
  assert(playbackRequests.some(r=>r.episode===3),'episode 3 prewarm did not begin');
  await frame.locator('.elf-episodes-btn').evaluate(el=>el.click());
  await frame.waitForSelector('.elf-ep-wheel-item[data-ep="4"]',{timeout:10000});
  await frame.locator('.elf-ep-wheel-item[data-ep="4"]').click({force:true});
  await frame.waitForFunction(()=>{const p=window.__elfura.player;return p.config.episode===4&&p.currentSource?.url.includes('/s1e4/')&&p.video.readyState>=2},null,{timeout:20000});
  await frame.waitForTimeout(1100);
  const fourth=await frame.evaluate(()=>({time:window.__elfura.player.video.currentTime,pre:window.__elfura.player.prewarmedNext?.episode,search:location.search,lang:window.__elfura.player.currentSource?.audioLang}));
  assert(fourth.time<5,`selected episode inherited time: ${JSON.stringify(fourth)}`);
  assert.equal(fourth.lang,'en','last selected language must beat the original embed language');
  assert.notEqual(fourth.pre,3,'stale prewarm must not win after navigation');
  await page.waitForFunction(()=>window.playerMessages.filter(m=>m.name==='episodeChange').length===2);
  changes=await page.evaluate(()=>window.playerMessages.filter(m=>m.name==='episodeChange'));
  assert.deepEqual(changes[1].data,{mediaType:'tv',tmdbId:'1399',season:1,episode:4,previous:{season:1,episode:2}});
  step='auto advance';
  await frame.evaluate(()=>{const p=window.__elfura.player;p.config.autoplayNextEp=true;p.video.currentTime=65;p.video.dispatchEvent(new Event('ended'));});
  await frame.waitForFunction(()=>{const p=window.__elfura.player;return p.config.episode===5&&p.currentSource?.url.includes('/s1e5/')&&p.video.readyState>=2},null,{timeout:20000});
  await frame.waitForTimeout(400);
  assert((await frame.evaluate(()=>window.__elfura.player.video.currentTime))<5,'auto-next must start from zero');
  await page.waitForFunction(()=>window.playerMessages.filter(m=>m.name==='episodeChange').length===3);
  changes=await page.evaluate(()=>window.playerMessages.filter(m=>m.name==='episodeChange'));
  assert.deepEqual(changes[2].data,{mediaType:'tv',tmdbId:'1399',season:1,episode:5,previous:{season:1,episode:4}});
  step='host loadEpisode command';
  await page.evaluate(()=>document.querySelector('#player').contentWindow.postMessage({__elfura:1,v:1,kind:'cmd',name:'loadEpisode',data:{season:2,episode:1},reqId:'episode-test'},location.origin));
  await frame.waitForFunction(()=>{const p=window.__elfura.player;return p.config.season===2&&p.config.episode===1&&p.currentSource?.url.includes('/s2e1/')&&p.video.readyState>=2},null,{timeout:20000});
  await page.waitForFunction(()=>window.playerMessages.some(m=>m.kind==='ack'&&m.reqId==='episode-test'&&m.ok));
  changes=await page.evaluate(()=>window.playerMessages.filter(m=>m.name==='episodeChange'));
  assert.equal(changes.length,4);
  assert.deepEqual(changes[3].data,{mediaType:'tv',tmdbId:'1399',season:2,episode:1,previous:{season:1,episode:5}});
  assert((await frame.evaluate(()=>window.__elfura.player.video.currentTime))<5);
  console.log('::notice title=EpisodeTransition::'+JSON.stringify({ok:true,prewarmedTime:second.time,selectedTime:fourth.time,events:changes.map(x=>x.data)}));
} catch(error) {
  const state=await frame?.evaluate(()=>{const p=window.__elfura?.player;return {season:p?.config.season,episode:p?.config.episode,time:p?.video.currentTime,ready:p?.video.readyState,paused:p?.video.paused,source:p?.currentSource?.url,next:p?.getNextEpisodeTarget(),pre:p?.prewarmedNext?.episode,path:location.pathname,search:location.search};}).catch(()=>null);
  console.log('::error title=EpisodeTransition::'+JSON.stringify({ok:false,step,error:String(error).slice(0,500),state,playbackRequests}));process.exitCode=1;
} finally {
  await browser?.close();await new Promise(r=>server.close(r));rmSync(tmp,{recursive:true,force:true});
}
