// Research-only injected adapter. Raw streams, frames, and audio remain ephemeral.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const samples=[{id:'46260',title:'Naruto',year:'2002',episode:'Enter: Naruto Uzumaki!'},{id:'95479',title:'Jujutsu Kaisen',year:'2020',episode:'Ryomen Sukuna'},{id:'1429',title:'Attack on Titan',year:'2013',episode:'To You, in 2000 Years: The Fall of Shiganshina, Part 1'}];
const data=JSON.parse(await readFile(process.env.RESEARCH_STREAM_FILE,'utf8'));
const clipDir=process.env.AUDIT_AUDIO_DIR;await mkdir(clipDir,{recursive:true});
const orig=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(u.hostname!=='tmdb-fixture.example')return orig(input,init);
 const p=u.pathname.split('/'),i=p.indexOf('tv'),s=samples.find(x=>x.id===p[i+1]);if(!s)return new Response(null,{status:404});
 if(p.includes('episode'))return Response.json({name:s.episode,runtime:24});
 return Response.json({id:Number(s.id),name:s.title,original_name:s.title,first_air_date:s.year+'-01-01',original_language:'ja',genres:[{name:'Animation'}],episode_run_time:[24],images:{logos:[]}});
};
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
// Reuse one page: closing the last page can terminate single-process Chromium.
const page=await browser.newPage();
const rows=[];
try{
 for(const s of samples)for(const [lane,ep] of [['sub',1],['dub',1],...(s.id==='46260'?[['hsub',2]]:[])]){
  const row={title:s.title,lane,episode:ep,frames:[]};const item=data[`${s.id}-${ep}-${lane}`];
  if(!item){row.error='no-candidate';rows.push(row);continue;}
  const cfg=loadBackendConfig({ELFURA_SECRET:'test-anime-only-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
  const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:true});
  registry.adapters=[{id:'source-29',label:'Source 29',enabled:()=>true,async resolve(){
   try{const u=new URL(item.url),r=new URL(item.referer);if(u.protocol!=='https:'||!isSafeUpstreamUrl(u.href)||r.protocol!=='https:'||!isSafeUpstreamUrl(r.href))return {candidates:[]};
    return {candidates:[{key:u.href,url:u.href,type:'hls',quality:'auto',rank:20,headers:{Referer:r.href},audioLang:lane==='dub'?'en':'ja',audioVariant:lane==='dub'?'dub':'sub'}]};
   }catch{return {candidates:[]}}
  }}];
  let step='start';
  try{
   await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
   await page.goto(`${base}/embed/tv/${s.id}/1/${ep}?autoplay=1&source=source-29`,{waitUntil:'domcontentloaded',timeout:15000});step='video';
   await page.waitForFunction(()=>{const p=window.__elfura?.player,v=p?.video;return v?.videoWidth>0&&v.currentTime>2&&v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:40000});
   row.video=await page.evaluate(async()=>{const p=window.__elfura.player,v=p.video;await p.setSubtitle(null);return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,subtitleCount:p.getSubtitleTracks?.().length??0}});
   if(!(row.video.duration>1000&&row.video.duration<1900))throw Error('unexpected-duration');
   step='seek';await page.evaluate(()=>{const v=window.__elfura.player.video;v.currentTime=420;v.play().catch(()=>{})});
   await page.waitForFunction(()=>{const v=window.__elfura.player.video;return !v.seeking&&v.currentTime>=420&&v.readyState>=2},null,{timeout:25000});
   step='audio';const audio=await page.evaluate(async()=>{
    const v=window.__elfura.player.video,stream=v.captureStream(),audio=new MediaStream(stream.getAudioTracks());
    const ctx=new AudioContext(),source=ctx.createMediaStreamSource(audio),analyser=ctx.createAnalyser();source.connect(analyser);const values=new Float32Array(analyser.fftSize),chunks=[];
    const recorder=new MediaRecorder(audio);recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.start();let max=0;const until=Date.now()+16000;
    while(Date.now()<until){analyser.getFloatTimeDomainData(values);let sum=0;for(const x of values)sum+=x*x;max=Math.max(max,Math.sqrt(sum/values.length));await new Promise(r=>setTimeout(r,100));}
    await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop()});const bytes=new Uint8Array(await new Blob(chunks,{type:'audio/webm'}).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));source.disconnect();await ctx.close();return {rms:max,base64:btoa(binary)};
   });
   row.rms=Math.round(audio.rms*100000)/100000;await writeFile(join(clipDir,`${s.id}-${ep}-${lane==='dub'?'en':'ja'}.webm`),Buffer.from(audio.base64,'base64'));
   if(!(row.rms>0.0001))throw Error('silent');
   if(lane==='hsub')for(const timestamp of [440,445,450,455,460]){
    step='frame';await page.evaluate(t=>{const v=window.__elfura.player.video;v.currentTime=t;v.play().catch(()=>{})},timestamp);
    await page.waitForFunction(t=>{const v=window.__elfura.player.video;return !v.seeking&&v.currentTime>=t&&v.readyState>=2},timestamp,{timeout:15000});
    await page.evaluate(()=>window.__elfura.player.video.pause());
    await page.locator('video').screenshot({path:join(clipDir,`${s.id}-${ep}-${timestamp}.png`),timeout:5000});row.frames.push(timestamp);
   }
   row.ok=true;
  }catch(e){row.ok=false;row.step=step;row.error=e.name==='TimeoutError'?'timeout':['silent','unexpected-duration'].includes(e.message)?e.message:e.name;}
  finally{await page.goto('about:blank').catch(()=>{});await new Promise(r=>server.close(r));}
  rows.push(row);
 }
 for(const row of rows)console.log('::notice title=Novus raw player sample::'+JSON.stringify(row));
}finally{await browser.close();globalThis.fetch=orig;}
