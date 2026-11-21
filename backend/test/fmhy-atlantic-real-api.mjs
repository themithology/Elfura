// Research-only injected Atlantic candidate via production registry, relay and player.
// Fixture TMDB; real playback endpoint, envelope and relay. No upstream URLs or tickets are logged.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createHash} from 'node:crypto';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const id='source-28';
const index=Number(process.env.AUDIT_INDEX??'0');
if(!Number.isInteger(index)||index!==0)throw Error('unknown audit configuration');
const samples=[
 {label:'Fight Club',type:'movie',id:'550',title:'Fight Club',year:'1999',runtime:139},
 {label:'Inception',type:'movie',id:'27205',title:'Inception',year:'2010',runtime:148},
 {label:'Dune Part Two',type:'movie',id:'693134',title:'Dune: Part Two',year:'2024',runtime:166},
 {label:'Parasite',type:'movie',id:'496243',title:'Parasite',year:'2019',runtime:132},
 {label:'Casablanca',type:'movie',id:'289',title:'Casablanca',year:'1943',runtime:102},
 {label:'Game of Thrones E1',type:'tv',id:'1399',title:'Game of Thrones',year:'2011',season:1,episode:1,runtime:62},
 {label:'Game of Thrones E2',type:'tv',id:'1399',title:'Game of Thrones',year:'2011',season:1,episode:2,runtime:56},
 {label:'Breaking Bad E1',type:'tv',id:'1396',title:'Breaking Bad',year:'2008',season:1,episode:1,runtime:58},
 {label:'Breaking Bad E2',type:'tv',id:'1396',title:'Breaking Bad',year:'2008',season:1,episode:2,runtime:48},
 {label:'Breaking Bad S3E10',type:'tv',id:'1396',title:'Breaking Bad',year:'2008',season:3,episode:10,runtime:47},
 {label:'Breaking Bad S5E16',type:'tv',id:'1396',title:'Breaking Bad',year:'2008',season:5,episode:16,runtime:55},
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
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:true});
// This is an injected diagnostic, not a registered production adapter.
// IDs and response handling remain backend-side; registry issues normal tickets.
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',Origin:'https://atlantic.bz',Referer:'https://atlantic.bz/'};
const upstreamHosts=new Set();
registry.adapters=[{id,label:'Source 28',enabled:()=>true,async resolve(q){
 try {
  if(!/^\d{1,12}$/.test(q.tmdbId)||!['movie','tv'].includes(q.type))return {candidates:[]};
  const params=new URLSearchParams({tmdbId:q.tmdbId,type:q.type,...(q.type==='tv'?{seasonId:String(q.season),episodeId:String(q.episode)}:{})});
  const r=await fetch(`https://stream.hls.lol/vidbox?${params}`,{headers,redirect:'error',signal:q.signal?AbortSignal.any([q.signal,AbortSignal.timeout(7000)]):AbortSignal.timeout(7000)});
  const text=await readBoundedText(r,100000);const data=JSON.parse(text??'null');
  const candidate=data?.sources?.Vidbox;
  if(!r.ok||candidate?.type!=='hls'||typeof candidate.url!=='string'||!isSafeUpstreamUrl(candidate.url)||new URL(candidate.url).protocol!=='https:')return {candidates:[]};
  const u=new URL(candidate.url);
  upstreamHosts.add(u.hostname);
  return {candidates:[{key:u.href,url:u.href,type:'hls',quality:'auto',rank:20,headers}]};
 }catch{return {candidates:[]};}
}}];
let browser;
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 // Reuse one page: closing a page/context can terminate the single-process
 // Chromium binary on Actions and invalidate the remaining samples.
 const page=await browser.newPage();
 let apiStatuses=[],exposedUpstream=false;
 page.on('response',res=>{try{const url=new URL(res.url());if(url.origin===base&&url.pathname==='/api/v1/playback')apiStatuses.push(res.status());}catch{}});
 page.on('request',req=>{try{if(upstreamHosts.has(new URL(req.url()).hostname))exposedUpstream=true}catch{}});
 const deadline=(p,ms)=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('audit-deadline')),ms);t.unref();})]);
 const rows=[];
 const selectedSamples=process.env.AUDIT_SHORT==='1'?samples.filter(s=>['Fight Club','Game of Thrones E1','Naruto E1'].includes(s.label)):samples;
 for(const s of selectedSamples){
  const row={source:id,sample:s.label,index};let step='resolve';apiStatuses=[];exposedUpstream=false;
  try{
   const path=s.type==='movie'?`movie/${s.id}`:`tv/${s.id}/${s.season}/${s.episode}`;
   await page.goto(`${base}/embed/${path}?autoplay=1&source=source-28`,{waitUntil:'domcontentloaded',timeout:15000});
   step='frames';
   await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v?.videoWidth>0&&v.currentTime>1&&v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:25000});
   Object.assign(row,await page.evaluate(()=>{const v=window.__elfura.player.video;return {width:v.videoWidth,height:v.videoHeight,duration:Number.isFinite(v.duration)?v.duration:null,frames:v.getVideoPlaybackQuality().totalVideoFrames}}));
   const firstPixels=await page.evaluate(()=>{const v=window.__elfura.player.video,c=document.createElement('canvas');c.width=64;c.height=36;const x=c.getContext('2d');x.drawImage(v,0,0,64,36);return [...x.getImageData(0,0,64,36).data]});
   row.firstFrameHash=createHash('sha256').update(Buffer.from(firstPixels)).digest('hex').slice(0,12);
   step='audio';
   row.audioRms=await deadline(page.evaluate(async()=>{
    const v=window.__elfura.player.video;const ctx=new AudioContext(),source=ctx.createMediaStreamSource(v.captureStream()),analyser=ctx.createAnalyser();source.connect(analyser);
    const data=new Float32Array(analyser.fftSize),end=Date.now()+4000;let max=0;
    while(Date.now()<end){analyser.getFloatTimeDomainData(data);let sum=0;for(const x of data)sum+=x*x;max=Math.max(max,Math.sqrt(sum/data.length));await new Promise(r=>setTimeout(r,100));}
    source.disconnect();await ctx.close();return Math.round(max*100000)/100000;
   }),10000);
   step='seek';
   if(!(row.duration>330) || Math.abs(row.duration-s.runtime*60)>s.runtime*60*0.3)throw Error('unexpected-duration');
   if(!(row.audioRms>0.0001))throw Error('silent-audio');
   await page.evaluate(()=>{window.__elfura.player.video.currentTime=300});
   await page.waitForFunction(()=>{const v=window.__elfura.player.video;return !v.seeking&&v.currentTime>300&&v.readyState>=2},null,{timeout:20000});
   const pixels=await page.evaluate(()=>{const v=window.__elfura.player.video,c=document.createElement('canvas');c.width=64;c.height=36;const x=c.getContext('2d');x.drawImage(v,0,0,64,36);return [...x.getImageData(0,0,64,36).data]});
   row.frameHash=createHash('sha256').update(Buffer.from(pixels)).digest('hex').slice(0,12);row.ok=true;
  }catch(e){row.ok=false;row.step=step;row.error=e.name==='TimeoutError'||e.message==='audit-deadline'?'timeout':e.message==='no candidate'?'no-candidate':e.message==='unexpected-duration'?'unexpected-duration':e.message==='silent-audio'?'silent-audio':/browser has been closed|page, context or browser has been closed/i.test(e.message)?'browser-closed':e.name;
   if(step==='frames')row.state=await deadline(page.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {time:v?.currentTime??0,width:v?.videoWidth??0,height:v?.videoHeight??0,ready:v?.readyState??0,error:v?.error?.code??null};}),3000).catch(()=>null);
  }
  row.apiStatuses=apiStatuses;row.exposedUpstream=exposedUpstream;
  rows.push(row);console.log('browser-sample '+JSON.stringify(row));
 }
 for(const name of ['Game of Thrones','Breaking Bad','Naruto']){
  const e1=rows.find(r=>r.sample===name+' E1'),e2=rows.find(r=>r.sample===name+' E2');
  console.log('::notice title=Episode frame comparison::'+JSON.stringify({source:id,name,distinct:!!e1?.frameHash&&!!e2?.frameHash&&e1.frameHash!==e2.frameHash}));
 }
 console.log('::notice title=Browser sample summary::'+JSON.stringify({source:id,total:rows.length,passed:rows.filter(r=>r.ok).length,nonSilent:rows.filter(r=>r.audioRms>0.0001).length,rows}));

}finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
