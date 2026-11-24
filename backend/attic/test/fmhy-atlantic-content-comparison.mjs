// Experimental identity corroboration: compare video frames from independent
// adapters at several times. Fixture metadata and forced playback response;
// matching frames don't prove catalogue identity or independent ownership.
// Images, URLs, tokens and captions are never emitted or saved.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const samples=[
 {name:'Fight Club',type:'movie',id:'550',title:'Fight Club',year:'1999',runtime:139},
 {name:'Game of Thrones E1',type:'tv',id:'1399',title:'Game of Thrones',year:'2011',season:1,episode:1,runtime:62},
 {name:'Game of Thrones E2',type:'tv',id:'1399',title:'Game of Thrones',year:'2011',season:1,episode:2,runtime:56},
 {name:'Naruto E1',type:'tv',id:'46260',title:'Naruto',year:'2002',season:1,episode:1,runtime:24,lang:'ja'}
];
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(u.hostname!=='tmdb-fixture.example')return originalFetch(input,init);
 const parts=u.pathname.split('/'),kind=parts.includes('tv')?'tv':'movie',n=parts.indexOf(kind),s=samples.find(x=>x.type===kind&&x.id===parts[n+1]);
 if(!s)return new Response(null,{status:404});if(parts.includes('episode'))return Response.json({name:'Sample episode',runtime:s.runtime});
 return Response.json({id:Number(s.id),name:s.title,title:s.title,original_name:s.title,first_air_date:s.year+'-01-01',release_date:s.year+'-01-01',original_language:s.lang??'en',genres:[{name:s.lang?'Animation':'Drama'}],episode_run_time:[s.runtime],runtime:s.runtime,images:{logos:[]}});
};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-frame-comparison',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});
const source14=registry.adapters.find(a=>a.id==='source-14');
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',Origin:'https://atlantic.bz',Referer:'https://atlantic.bz/'};
const experimental={id:'source-28',label:'Source 28',enabled:()=>true,async resolve(q){try{
 const p=new URLSearchParams({tmdbId:q.tmdbId,type:q.type,...(q.type==='tv'?{seasonId:String(q.season),episodeId:String(q.episode)}:{})});
 const r=await fetch(`https://stream.hls.lol/vidbox?${p}`,{headers,redirect:'error',signal:AbortSignal.timeout(7000)}),data=JSON.parse((await readBoundedText(r,100000))??'null');
 const c=data?.sources?.Vidbox;if(!r.ok||c?.type!=='hls'||typeof c.url!=='string'||!isSafeUpstreamUrl(c.url)||new URL(c.url).protocol!=='https:')return {candidates:[]};
 return {candidates:[{key:c.url,url:c.url,type:'hls',quality:'auto',rank:20,headers}]};
 }catch{return {candidates:[]}}}};
let browser;const result=[];const frames={};
try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 for(const s of samples)for(const [tag,adapter] of [['reference',source14],['candidate',experimental]]){
  const row={sample:s.name,tag};let step='resolve';try{
   registry.adapters=[adapter];const p=await registry.resolvePlayback({type:s.type,tmdbId:s.id,season:s.season,episode:s.episode,sourceId:adapter.id});
   if(!p?.sources?.length)throw Error('no-candidate');const opt=p.sources[0];
   await page.route('**/api/v1/playback**',route=>route.fulfill({json:{...p,primary:opt,sources:[opt],sourceGroups:[],pendingSources:[]}}));
   const path=s.type==='movie'?`movie/${s.id}`:`tv/${s.id}/${s.season}/${s.episode}`;
   await page.goto(`${base}/embed/${path}?autoplay=1`,{waitUntil:'domcontentloaded',timeout:15000});step='frames';
   await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v?.videoWidth>0&&v.currentTime>1},null,{timeout:25000});
   row.duration=await page.evaluate(()=>window.__elfura.player.video.duration);
   frames[s.name]??={};frames[s.name][tag]=[];
   for(const t of [290,295,300,305,310]){
    await page.evaluate(t=>{const v=window.__elfura.player.video;v.currentTime=t;v.play().catch(()=>{});},t);
    await page.waitForFunction(t=>{const v=window.__elfura.player.video;return !v.seeking&&v.readyState>=2&&v.currentTime>=t},t,{timeout:20000});
    const pixels=await page.evaluate(()=>{const v=window.__elfura.player.video;v.pause();const c=document.createElement('canvas');c.width=32;c.height=18;const ctx=c.getContext('2d');ctx.drawImage(v,0,0,32,18);return [...ctx.getImageData(0,0,32,18).data]});
    frames[s.name][tag].push({t,pixels});
   }
   row.ok=true;
  }catch(e){row.ok=false;row.step=step;row.error=e.message==='no-candidate'?'no-candidate':e.name==='TimeoutError'?'timeout':e.name;}
  finally{await page.unroute('**/api/v1/playback**').catch(()=>{});}result.push(row);
 }
 function compare(a,b){let aa=[],bb=[];for(let i=0;i<a.length;i+=4){aa.push(.299*a[i]+.587*a[i+1]+.114*a[i+2]);bb.push(.299*b[i]+.587*b[i+1]+.114*b[i+2]);}const av=aa.reduce((x,y)=>x+y,0)/aa.length,bv=bb.reduce((x,y)=>x+y,0)/bb.length;let x=0,y=0,z=0;for(let i=0;i<aa.length;i++){const u=aa[i]-av,v=bb[i]-bv;x+=u*v;y+=u*u;z+=v*v;}return y>576*100&&z>576*100?x/Math.sqrt(y*z):null;}
 const pairs=[];for(const sample of samples){const f=frames[sample.name];if(!f?.reference?.length||!f?.candidate?.length)continue;let best=null;
 for(const a of f.reference)for(const b of f.candidate){const score=compare(a.pixels,b.pixels);if(score!==null&&(!best||score>best.correlation))best={correlation:score,refTime:a.t,candidateTime:b.t};}
 pairs.push({sample:sample.name,best:best?{...best,correlation:Math.round(best.correlation*1000)/1000}:null});}
 console.log('::notice title=Visual comparison research::'+JSON.stringify({result,pairs}));
}finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=originalFetch;}
