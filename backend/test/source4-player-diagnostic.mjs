// Research diagnostic: sanitized player/relay telemetry, no URLs or tokens.
// Fixture TMDB and playback response. No upstream URLs or tickets are logged.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const id=process.env.AUDIT_SOURCE;
const index=Number(process.env.AUDIT_INDEX??'0');
if(!['source-1','source-4','source-14'].includes(id)||!Number.isInteger(index)||index<0||index>3)throw Error('unknown audit configuration');
const samples=[
 {label:'Fight Club',type:'movie',id:'550',title:'Fight Club',year:'1999',runtime:139},
 {label:'Dune Part Two',type:'movie',id:'693134',title:'Dune: Part Two',year:'2024',runtime:166},
 {label:'Casablanca',type:'movie',id:'289',title:'Casablanca',year:'1943',runtime:102},
 {label:'Game of Thrones E1',type:'tv',id:'1399',title:'Game of Thrones',year:'2011',season:1,episode:1,runtime:62},
 {label:'Game of Thrones E2',type:'tv',id:'1399',title:'Game of Thrones',year:'2011',season:1,episode:2,runtime:56},
 {label:'Breaking Bad E1',type:'tv',id:'1396',title:'Breaking Bad',year:'2008',season:1,episode:1,runtime:58},
 {label:'Breaking Bad E2',type:'tv',id:'1396',title:'Breaking Bad',year:'2008',season:1,episode:2,runtime:48},
 {label:'Naruto E1',type:'tv',id:'46260',title:'Naruto',year:'2002',season:1,episode:1,runtime:24,lang:'ja'},
 {label:'Naruto E2',type:'tv',id:'46260',title:'Naruto',year:'2002',season:1,episode:2,runtime:24,lang:'ja'},
];
const orig=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url??String(input));
 if(u.hostname==='tmdb-fixture.example'){
  const parts=u.pathname.split('/'),kind=parts.includes('tv')?'tv':'movie',n=parts.indexOf(kind),sample=samples.find(s=>s.type===kind&&s.id===parts[n+1]);
  if(!sample)return new Response(null,{status:404});
  if(parts.includes('episode'))return Response.json({name:'Sample episode',runtime:sample.runtime});
  return Response.json({id:Number(sample.id),name:sample.title,title:sample.title,original_name:sample.title,first_air_date:sample.year+'-01-01',release_date:sample.year+'-01-01',original_language:sample.lang??'en',genres:[{name:sample.lang?'Animation':'Drama'}],episode_run_time:[sample.runtime],runtime:sample.runtime,images:{logos:[]}});
 }
 return orig(input,init);
};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-matrix-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});
let counts={};
server.on('request',(req,res)=>{if(req.url?.startsWith('/api/proxy?'))res.on('finish',()=>{const k=`${res.statusCode}:${String(res.getHeader('content-type')??'').split(';')[0]}`;counts[k]=(counts[k]??0)+1;});});
registry.adapters=registry.adapters.filter(a=>a.id===id);
let browser;
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 // Reuse one page: closing a page/context can terminate the single-process
 // Chromium binary on Actions and invalidate the remaining samples.
 const page=await browser.newPage();
 // Capture only structural playlist properties; never print body, URLs, or tickets.
 let playlists=[];
 page.on('response', async response=>{try{
   const u=new URL(response.url());if(u.origin!==base||!u.pathname.startsWith('/api/proxy')||!(response.headers()['content-type']??'').includes('mpegurl'))return;
   const text=await response.text();playlists.push({startsM3u:text.trimStart().startsWith('#EXTM3U'),bytes:Buffer.byteLength(text),streams:(text.match(/#EXT-X-STREAM-INF/g)??[]).length,media:(text.match(/#EXTINF/g)??[]).length,headerLines:text.split('\n').filter(x=>x.startsWith('#EXT')).length,codecs:[...text.matchAll(/CODECS="([^"]+)"/g)].map(m=>m[1]).filter(x=>/^[a-zA-Z0-9., _-]{1,120}$/.test(x)).slice(0,6)});
 }catch{}});
 await page.addInitScript(()=>{window.__auditHlsErrors=[];let last=null;const timer=setInterval(()=>{const h=window.__elfura?.player?.hls;if(h&&h!==last){last=h;h.on('hlsError',(_event,d)=>window.__auditHlsErrors.push({type:d.type,details:d.details,fatal:d.fatal}));}if(window.__auditHlsErrors.length>30)clearInterval(timer)},25);});
 const deadline=(p,ms)=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('audit-deadline')),ms);t.unref();})]);
 const rows=[];
 const selectedSamples=process.env.AUDIT_SHORT==='1'?samples.filter(s=>['Fight Club','Game of Thrones E1','Naruto E1'].includes(s.label)):samples;
 for(const s of selectedSamples){
  const row={source:id,sample:s.label,index};let step='resolve';counts={};playlists=[];
  try{
   const result=await deadline(registry.resolvePlayback({type:s.type,tmdbId:s.id,season:s.season,episode:s.episode,sourceId:id}),25000);
   row.options=result?.sources?.length??0;if(row.options<=index)throw Error('no candidate');
   const opt=result.sources[index];row.type=opt.type;row.option={audioLang:opt.audioLang??null,multiAudio:!!opt.multiAudio,quality:opt.quality??null};
   await page.route('**/api/v1/playback**',route=>route.fulfill({json:{...result,primary:opt,sources:[opt],sourceGroups:[],pendingSources:[]}}));
   const path=s.type==='movie'?`movie/${s.id}`:`tv/${s.id}/${s.season}/${s.episode}`;
   await page.goto(`${base}/embed/${path}?autoplay=1`,{waitUntil:'domcontentloaded',timeout:15000});
   step='frames';
   await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v?.videoWidth>0&&v.currentTime>1&&v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:25000});
   Object.assign(row,await page.evaluate(()=>{const v=window.__elfura.player.video;return {width:v.videoWidth,height:v.videoHeight,duration:Number.isFinite(v.duration)?v.duration:null,frames:v.getVideoPlaybackQuality().totalVideoFrames}}));
   step='audio';
   row.audioRms=await deadline(page.evaluate(async()=>{
    const v=window.__elfura.player.video;const ctx=new AudioContext(),source=ctx.createMediaStreamSource(v.captureStream()),analyser=ctx.createAnalyser();source.connect(analyser);
    const data=new Float32Array(analyser.fftSize),end=Date.now()+4000;let max=0;
    while(Date.now()<end){analyser.getFloatTimeDomainData(data);let sum=0;for(const x of data)sum+=x*x;max=Math.max(max,Math.sqrt(sum/data.length));await new Promise(r=>setTimeout(r,100));}
    source.disconnect();await ctx.close();return Math.round(max*100000)/100000;
   }),10000);
   step='seek';
   if(!(row.duration>330))throw Error('unexpected-duration');
   await page.evaluate(()=>{window.__elfura.player.video.currentTime=300});
   await page.waitForFunction(()=>{const v=window.__elfura.player.video;return !v.seeking&&v.currentTime>300&&v.readyState>=2},null,{timeout:20000});
   const pixels=await page.evaluate(()=>{const v=window.__elfura.player.video,c=document.createElement('canvas');c.width=64;c.height=36;const x=c.getContext('2d');x.drawImage(v,0,0,64,36);return [...x.getImageData(0,0,64,36).data]});
   row.frameHash=createHash('sha256').update(Buffer.from(pixels)).digest('hex').slice(0,12);row.ok=true;
  }catch(e){row.ok=false;row.step=step;row.error=e.name==='TimeoutError'||e.message==='audit-deadline'?'timeout':e.message==='no candidate'?'no-candidate':e.message==='unexpected-duration'?'unexpected-duration':/browser has been closed|page, context or browser has been closed/i.test(e.message)?'browser-closed':e.name;
   if(step==='frames')row.state=await deadline(page.evaluate(()=>{const p=window.__elfura?.player,v=p?.video,h=p?.hls;return {time:v?.currentTime??0,width:v?.videoWidth??0,height:v?.videoHeight??0,ready:v?.readyState??0,network:v?.networkState??null,error:v?.error?.code??null,paused:v?.paused??null,srcType:v?.currentSrc?.startsWith('blob:')?'blob':v?.currentSrc?'other':'none',engine:p?.engineKind??null,hasHls:!!h,levels:h?.levels?.length??0,hlsState:h?.streamController?.state??null,sourceSelected:!!p?.currentSource,sourceCount:p?.sources?.length??0,loadSeq:p?.engineLoadSeq??0};}),3000).catch(()=>null);
  }
  finally{await deadline(page.unroute('**/api/v1/playback**'),4000).catch(()=>{});}
  row.relayCounts=counts;row.playlists=playlists;row.hlsErrors=await page.evaluate(()=>window.__auditHlsErrors??[]).catch(()=>[]);rows.push(row);console.log('browser-sample '+JSON.stringify(row));
 }
 for(const name of ['Game of Thrones','Breaking Bad','Naruto']){
  const e1=rows.find(r=>r.sample===name+' E1'),e2=rows.find(r=>r.sample===name+' E2');
  console.log('::notice title=Episode frame comparison::'+JSON.stringify({source:id,name,distinct:!!e1?.frameHash&&!!e2?.frameHash&&e1.frameHash!==e2.frameHash}));
 }
 console.log('::notice title=Browser sample summary::'+JSON.stringify({source:id,total:rows.length,passed:rows.filter(r=>r.ok).length,nonSilent:rows.filter(r=>r.audioRms>0.0001).length,rows}));

}finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
