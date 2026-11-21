// Research-only Source 29 injection, real playback endpoint/relay, fixture TMDB.
// Temporary audio clips are kept only on the runner, never logged or uploaded.
import {createBackendServer} from '../../dist/backend/index.js';
import {anilistIdForTmdb} from '../../dist/backend/sources/anime-db.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const samples=[{id:'46260',title:'Naruto',year:'2002',episodes:['Enter: Naruto Uzumaki!','My Name is Konohamaru']},{id:'95479',title:'Jujutsu Kaisen',year:'2020',episodes:['Ryomen Sukuna','For Myself']},{id:'1429',title:'Attack on Titan',year:'2013',episodes:['Sample episode one','Sample episode two']}];
const orig=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(u.hostname!=='tmdb-fixture.example')return orig(input,init);
 const p=u.pathname.split('/'),i=p.indexOf('tv'),s=samples.find(x=>x.id===p[i+1]);if(!s)return new Response(null,{status:404});const ep=p.indexOf('episode');
 if(ep>=0)return Response.json({name:s.episodes[Number(p[ep+1])-1]??'',runtime:24});
 return Response.json({id:Number(s.id),name:s.title,original_name:s.title,first_air_date:s.year+'-01-01',original_language:'ja',genres:[{name:'Animation'}],episode_run_time:[24],images:{logos:[]}});
};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-anime-only-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:true});// Prototype only. This does not register a production provider.
const origin='https://mikaza.buzz',ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
registry.adapters=[{id:'source-29',label:'Source 29',enabled:()=>true,async resolve(q){try{
 if(q.type!=='tv'||q.season!==1||!Number.isInteger(q.episode)||q.episode<1)return {candidates:[]};
 const mapping=await anilistIdForTmdb(q.tmdbId);if(!mapping?.anilistId)return {candidates:[]};
 const lanes=await Promise.all([['ja','jpn','sub'],['en','eng','dub']].map(async ([lang,requested,expected])=>{try{
  const embed=`${origin}/embed/haiku/ani/${mapping.anilistId}/${q.episode}/${requested}`;
  const r=await fetch(embed,{headers:{'User-Agent':ua,Referer:origin+'/'},redirect:'error',signal:AbortSignal.timeout(9000)});
  const html=await readBoundedText(r,1000000),ref=html?.match(/resolve\s*:\s*"([^"\\]{1,8192})"/)?.[1];if(!r.ok||!ref)return null;
  const u=new URL(ref,origin);if(u.protocol!=='https:'||!isSafeUpstreamUrl(u.href))return null;
  const response=await fetch(u,{headers:{'User-Agent':ua,Accept:'application/json',Referer:embed},redirect:'error',signal:AbortSignal.timeout(9000)});
  const data=JSON.parse((await readBoundedText(response,200000))??'null');if(!response.ok||data?.source?.resolvedLanguage!==expected||typeof data.src!=='string')return null;
  const media=new URL(data.src,origin);if(media.protocol!=='https:'||media.username||media.password||!isSafeUpstreamUrl(media.href))return null;
  return {key:media.href,url:media.href,type:'mp4',quality:'auto',audioLang:lang,audioLabel:lang==='en'?'English':'Japanese',audioVariant:expected,rank:lang==='ja'?20:21};
 }catch{return null}}));
 if(!lanes[0]||!lanes[1]||lanes[0].url===lanes[1].url)return {candidates:[]};return {candidates:lanes};
 }catch{return {candidates:[]}}}}];
const clipDir=process.env.AUDIT_AUDIO_DIR;if(clipDir)await mkdir(clipDir,{recursive:true});
let browser;const rows=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 for(const s of samples.filter(x=>x.id==='46260'))for(const ep of [1]){
  const row={title:s.title,episode:ep,tracks:[]};let step='start';let statuses=[];
  const response=res=>{try{const u=new URL(res.url());if(u.origin===base&&u.pathname==='/api/v1/playback')statuses.push(res.status())}catch{}};page.on('response',response);
  try{
   await page.goto(`${base}/embed/tv/${s.id}/1/${ep}?autoplay=1&source=source-29`,{waitUntil:'domcontentloaded',timeout:15000});step='video';
   await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v?.videoWidth>0&&v.currentTime>1&&v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:35000});
   row.video=await page.evaluate(()=>{const p=window.__elfura.player,v=p.video;return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,languages:p.getAudioTracks().map(t=>({lang:t.lang,kind:t.kind})),current:p.currentSource?{lang:p.currentSource.audioLang??null,type:p.currentSource.type,multi:!!p.currentSource.multiAudio}:null,options:p.sources.map(s=>({lang:s.audioLang??null,type:s.type,multi:!!s.multiAudio})),subtitleCount:p.getSubtitleTracks?.().length??0}});
   if(!(row.video.duration>1100&&row.video.duration<1900))throw Error('unexpected-duration');
   for(const lang of ['ja','en','ja']){
    step='switch-'+lang;const changed=await page.evaluate(lang=>window.__elfura.player.setAudio(lang),lang);row.afterSwitch=await page.evaluate(()=>{const p=window.__elfura.player;return {current:p.currentSource?{lang:p.currentSource.audioLang??null,type:p.currentSource.type,multi:!!p.currentSource.multiAudio}:null,currentAudio:p.currentAudio?{lang:p.currentAudio.lang,kind:p.currentAudio.kind}:null,ready:p.video.readyState,time:p.video.currentTime,tracks:p.getAudioTracks().map(t=>({lang:t.lang,kind:t.kind}))}});if(!changed)throw Error('switch-refused');
    await page.waitForFunction(lang=>{const p=window.__elfura.player;return p.currentSource?.audioLang===lang&&p.video.readyState>=1},lang,{timeout:20000});
    await page.evaluate(()=>{const v=window.__elfura.player.video;v.currentTime=420;v.play().catch(()=>{})});
    await page.waitForFunction(()=>{const v=window.__elfura.player.video;return !v.seeking&&v.currentTime>=420&&v.readyState>=2},null,{timeout:20000});
    const capture=!!clipDir&&ep===1&&s.id!=='1429'&&row.tracks.length<2;
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
  row.finalState=await page.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {current:p?.currentSource?{lang:p.currentSource.audioLang??null,type:p.currentSource.type}:null,ready:v?.readyState,time:v?.currentTime,paused:v?.paused,error:v?.error?.code??null,activeProbe:!!p?.activeProbe}}).catch(()=>null);page.off('response',response);row.api=statuses;rows.push(row);console.log('anime sample '+JSON.stringify(row));
 }
 console.log('::notice title=Prototype anime separate-audio browser audit::'+JSON.stringify({rows,total:rows.length,passed:rows.filter(r=>r.ok).length}));
}finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
