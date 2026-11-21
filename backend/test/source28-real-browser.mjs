// Live integration: actual catalogue lookup, registry, production relay, Chromium.
// Do not emit upstream URLs, tokens, response bodies or credentials.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createSource28Adapter} from '../../dist/backend/sources/source28.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const samples=[{id:'46260',title:'Naruto',year:'2002',episodes:['Enter: Naruto Uzumaki!','My Name is Konohamaru']},{id:'95479',title:'Jujutsu Kaisen',year:'2020',episodes:['Ryomen Sukuna','For Myself']}];
const orig=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url ?? String(input));
 if(u.hostname==='tmdb-fixture.example'){
  const parts=u.pathname.split('/');const tv=parts.indexOf('tv');const s=samples.find(x=>x.id===parts[tv+1]);
  if(!s)return new Response(null,{status:404});
  const ep=parts.indexOf('episode');if(ep>=0)return Response.json({name:s.episodes[Number(parts[ep+1])-1]??''});
  return Response.json({id:Number(s.id),name:s.title,original_name:s.title,first_air_date:s.year+'-01-01',original_language:'ja',episode_run_time:[24],images:{logos:[]}});
 }
 return orig(input,init);
};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});
registry.adapters=[createSource28Adapter(()=>true)];
let browser,page,step='start',sampleInfo='';const responses={};
server.on('request',(req,res)=>{if(req.url?.startsWith('/api/v1/stream?'))res.on('finish',()=>{const key=`${res.statusCode}:${String(res.getHeader('content-type')??'').split(';')[0]}`;responses[key]=(responses[key]??0)+1;});});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});page=await browser.newPage();
 const rows=[];
 for(const sample of samples)for(const episode of [1,2]){
  sampleInfo=`${sample.title} S1E${episode}`;step='resolve';
  const result=await registry.resolvePlayback({type:'tv',tmdbId:sample.id,season:1,episode,sourceId:'source-28'});
  assert(result?.sources?.length,'no source found');
  const opt=result.sources.find(s=>s.multiAudio && s.availableAudioLangs?.includes('hi') && s.availableAudioLangs?.includes('en'));
  assert(opt,'multi-audio Hindi/English unavailable');
  await page.route('**/api/v1/playback**',route=>route.fulfill({json:{...result,primary:opt,sources:[opt],sourceGroups:[],pendingSources:[]}}));
  await page.goto(`${base}/embed/tv/${sample.id}/1/${episode}?autoplay=1`,{waitUntil:'domcontentloaded'});
  step='render';
  await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v?.videoWidth>0 && v.currentTime>1 && v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:30000});
  const before=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video;return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime,duration:v.duration,frames:v.getVideoPlaybackQuality().totalVideoFrames,tracks:p.getAudioTracks().map(t=>t.lang),levels:p.getQualityLevels().map(q=>q.height)}});
  assert(before.duration>1100 && before.duration<1900,`unexpected duration ${before.duration}`);
  const measured=[];
  for(const lang of ['hi','en','hi']){
   step='switch '+lang;
   assert.equal(await page.evaluate(lang=>window.__elfura.player.setAudio(lang),lang),true);
   await page.waitForFunction(lang=>{const p=window.__elfura.player,h=p.hls;return h && h.audioTracks[h.audioTrack]?.lang===lang},lang,{timeout:15000});
   // Allow new audio buffers to arrive before recording the analyser's output.
   const audio=await page.evaluate(async()=>{
    const v=window.__elfura.player.video;
    const stream=v.captureStream();const ctx=new AudioContext();const input=ctx.createMediaStreamSource(stream);const analyser=ctx.createAnalyser();input.connect(analyser);const data=new Float32Array(analyser.fftSize);let max=0;
    const end=Date.now()+3500;
    while(Date.now()<end){analyser.getFloatTimeDomainData(data);let sum=0;for(const x of data)sum+=x*x;max=Math.max(max,Math.sqrt(sum/data.length));await new Promise(r=>setTimeout(r,100));}
    input.disconnect();await ctx.close();return max;
   });
   measured.push({lang,rms:Math.round(audio*10000)/10000});
   assert(audio>0.0001,`no decoded audio observed for ${lang}`);
  }
  step='seek';
  await page.evaluate(()=>{window.__elfura.player.video.currentTime=300});
  await page.waitForFunction(()=>{const v=window.__elfura.player.video;return !v.seeking && v.currentTime>300 && v.readyState>=2},null,{timeout:20000});
  const pixels=await page.evaluate(()=>{const v=window.__elfura.player.video,c=document.createElement('canvas');c.width=64;c.height=36;const ctx=c.getContext('2d');ctx.drawImage(v,0,0,64,36);return [...ctx.getImageData(0,0,64,36).data]});
  const frameHash=createHash('sha256').update(Buffer.from(pixels)).digest('hex').slice(0,12);
  rows.push({title:sample.title,episode,...before,audio:measured,frameHash});
  await page.unroute('**/api/v1/playback**');
 }
 for(const sample of samples){const r=rows.filter(x=>x.title===sample.title);assert.notEqual(r[0].frameHash,r[1].frameHash,'episodes show the same sampled video frame');}
 console.log('::notice title=AnimeSalt real browser audit::'+JSON.stringify({ok:true,rows,responses}));
}catch(e){const state=await page?.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {time:v?.currentTime,width:v?.videoWidth,height:v?.videoHeight,ready:v?.readyState,error:v?.error?.code,tracks:p?.getAudioTracks().map(t=>t.lang)}}).catch(()=>null);console.log('::error title=AnimeSalt browser audit::'+JSON.stringify({sampleInfo,step,error:String(e).replace(/https?:\/\/\S+/g,'[url]').slice(0,240),state,responses}));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
