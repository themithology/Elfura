// Research: production Source 28, real playback endpoint/relay, fixture TMDB.
// Temporary audio clips are kept only on the runner, never logged or uploaded.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const samples=[{id:'46260',title:'Naruto',year:'2002',episodes:['Enter: Naruto Uzumaki!','My Name is Konohamaru']},{id:'95479',title:'Jujutsu Kaisen',year:'2020',episodes:['Ryomen Sukuna','For Myself']}];
const orig=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(u.hostname!=='tmdb-fixture.example')return orig(input,init);
 const p=u.pathname.split('/'),i=p.indexOf('tv'),s=samples.find(x=>x.id===p[i+1]);if(!s)return new Response(null,{status:404});const ep=p.indexOf('episode');
 if(ep>=0)return Response.json({name:s.episodes[Number(p[ep+1])-1]??'',runtime:24});
 return Response.json({id:Number(s.id),name:s.title,original_name:s.title,first_air_date:s.year+'-01-01',original_language:'ja',genres:[{name:'Animation'}],episode_run_time:[24],images:{logos:[]}});
};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-anime-only-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:true});registry.adapters=registry.adapters.filter(a=>a.id==='source-28');
const clipDir=process.env.AUDIT_AUDIO_DIR;if(clipDir)await mkdir(clipDir,{recursive:true});
let browser;const rows=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 for(const s of samples)for(const ep of [1,2]){
  const row={title:s.title,episode:ep,tracks:[]};let step='start';let statuses=[];
  const response=res=>{try{const u=new URL(res.url());if(u.origin===base&&u.pathname==='/api/v1/playback')statuses.push(res.status())}catch{}};page.on('response',response);
  try{
   await page.goto(`${base}/embed/tv/${s.id}/1/${ep}?autoplay=1&source=source-28`,{waitUntil:'domcontentloaded',timeout:15000});step='video';
   await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v?.videoWidth>0&&v.currentTime>1&&v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:35000});
   row.video=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video;return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,languages:p.getAudioTracks().map(t=>t.lang),subtitleCount:p.getSubtitleTracks?.().length??0}});
   if(!(row.video.duration>1100&&row.video.duration<1900))throw Error('unexpected-duration');
   for(const lang of ['ja','en','ja']){
    step='switch-'+lang;const changed=await page.evaluate(lang=>window.__elfura.player.setAudio(lang),lang);if(!changed)throw Error('switch-refused');
    await page.waitForFunction(lang=>{const h=window.__elfura.player.hls;return h&&h.audioTracks[h.audioTrack]?.lang===lang},lang,{timeout:15000});
    await page.evaluate(()=>{const v=window.__elfura.player.video;v.currentTime=420;v.play().catch(()=>{})});
    await page.waitForFunction(()=>{const v=window.__elfura.player.video;return !v.seeking&&v.currentTime>=420&&v.readyState>=2},null,{timeout:20000});
    const capture=!!clipDir&&ep===1&&row.tracks.length<2;
    const audio=await page.evaluate(async capture=>{
     const v=window.__elfura.player.video,stream=v.captureStream(),audio=new MediaStream(stream.getAudioTracks());
     const ctx=new AudioContext(),source=ctx.createMediaStreamSource(audio),analyser=ctx.createAnalyser();source.connect(analyser);const samples=new Float32Array(analyser.fftSize);
     let recorder,chunks=[];if(capture){recorder=new MediaRecorder(audio);recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.start();}
     const until=Date.now()+(capture?18000:3500);let max=0;
     while(Date.now()<until){analyser.getFloatTimeDomainData(samples);let sum=0;for(const x of samples)sum+=x*x;max=Math.max(max,Math.sqrt(sum/samples.length));await new Promise(r=>setTimeout(r,100));}
     let base64=null;if(recorder){await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop()});const bytes=new Uint8Array(await new Blob(chunks,{type:'audio/webm'}).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));base64=btoa(binary);}
     source.disconnect();await ctx.close();return {rms:Math.round(max*100000)/100000,base64};
    },capture);
    if(capture&&audio.base64)await writeFile(join(clipDir,`${s.id}-${ep}-${lang}.webm`),Buffer.from(audio.base64,'base64'));
    row.tracks.push({lang,rms:audio.rms,captured:!!audio.base64});if(!(audio.rms>0.0001))throw Error('silent-audio');
   }
   row.ok=true;
  }catch(e){row.ok=false;row.step=step;row.error=e.name==='TimeoutError'?'timeout':/unexpected-duration|switch-refused|silent-audio/.test(e.message)?e.message:e.name;}
  page.off('response',response);row.api=statuses;rows.push(row);console.log('anime sample '+JSON.stringify(row));
 }
 console.log('::notice title=Japanese and English audio browser audit::'+JSON.stringify({rows,total:rows.length,passed:rows.filter(r=>r.ok).length}));
}finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
