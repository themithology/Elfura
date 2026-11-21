// End-to-end research of already-registered groups via the production relay/player.
// Fixture TMDB and playback response. No upstream URLs or tickets are logged.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const id=process.env.AUDIT_SOURCE;
if(!['source-1','source-4','source-14'].includes(id))throw Error('unknown source');
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
registry.adapters=registry.adapters.filter(a=>a.id===id);
let browser;
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 // Sparticuz's single-process Chromium can exit when the last page closes.
 // Keep a blank page open throughout the audit.
 const keeper=await browser.newPage();
 const deadline=(p,ms)=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('audit-deadline')),ms);t.unref();})]);
 const rows=[];
 for(const s of samples){
  const row={source:id,sample:s.label};let page,step='resolve';
  try{
   const result=await deadline(registry.resolvePlayback({type:s.type,tmdbId:s.id,season:s.season,episode:s.episode,sourceId:id}),25000);
   row.options=result?.sources?.length??0;if(!row.options)throw Error('no candidate');
   const opt=result.sources[0];row.type=opt.type;
   page=await browser.newPage();
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
  }catch(e){row.ok=false;row.step=step;row.error=e.name==='TimeoutError'||e.message==='audit-deadline'?'timeout':e.message==='no candidate'?'no-candidate':e.message==='unexpected-duration'?'unexpected-duration':/browser has been closed|page, context or browser has been closed/i.test(e.message)?'browser-closed':e.name;}
  finally{if(page)await deadline(page.close(),4000).catch(()=>{});}
  rows.push(row);console.log('browser-sample '+JSON.stringify(row));
 }
 for(const name of ['Game of Thrones','Breaking Bad','Naruto']){
  const e1=rows.find(r=>r.sample===name+' E1'),e2=rows.find(r=>r.sample===name+' E2');
  console.log('::notice title=Episode frame comparison::'+JSON.stringify({source:id,name,distinct:!!e1?.frameHash&&!!e2?.frameHash&&e1.frameHash!==e2.frameHash}));
 }
 console.log('::notice title=Browser sample summary::'+JSON.stringify({source:id,total:rows.length,passed:rows.filter(r=>r.ok).length,nonSilent:rows.filter(r=>r.audioRms>0.0001).length,rows}));
 await keeper.close();
}finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
