// Actual Source 17 and Elfura player for the requested Re:ZERO episode. Match
// live inventory labels in memory only; never log upstream URLs or tickets.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createSource17Adapter,decodeTgvidxResponse} from '../../dist/backend/sources/source17.js';
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
const original=globalThis.fetch;let names=new Map();
globalThis.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url??String(input));
 if(u.hostname==='tmdb-fixture.example'){
  if(u.pathname.includes('/episode/'))return Response.json({name:'The End of the Beginning and the Beginning of the End',runtime:49});
  return Response.json({id:65942,name:'Re:ZERO -Starting Life in Another World-',original_name:'Re:ZERO',first_air_date:'2016-01-01',original_language:'ja',episode_run_time:[49],genres:[{name:'Animation'}],images:{logos:[]}});
 }
 const r=await original(input,init);
 if(u.hostname==='tgvidx.lovable.app'&&u.pathname.includes('/_serverFn/ff183')){
  try{const data=decodeTgvidxResponse(await r.clone().text());for(const row of data?.links||[]){if(typeof row.url==='string'&&typeof row.server==='string')names.set(new URL(row.url,'https://tgvidx.lovable.app').href,row.server)}}catch{}
 }
 return r;
};
const cfg=loadBackendConfig({ELFURA_SECRET:'fixture-only-rezero-test',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const adapter=createSource17Adapter(()=>true);let selected='';const rows=[];let browser;
try{
 const diag=[];const discovered=await adapter.resolve({type:'tv',tmdbId:'65942',season:1,episode:1,diag});
 const inventory=discovered.candidates.map(c=>({name:names.get(c.url)||'unknown',type:c.type,subs:c.subtitles?.length||0}));
 console.log('::notice title=ReZero Source 17 inventory::'+JSON.stringify({candidates:inventory,diag}).replace(/%/g,'%25'));
 const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});registry.adapters=[{...adapter,async resolve(q){names=new Map();const r=await adapter.resolve(q);return {...r,candidates:r.candidates.filter(c=>names.get(c.url)===selected)}}}];
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{browser=await chromium.launch({executablePath:await binary.executablePath(),args:[...binary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
  for(const label of ['TG STREAMHG','TG VIDSHARED','TG VIDARA']){
   selected=label;registry.ramCache.clear();registry.finishedLate.clear();const row={label,found:inventory.some(x=>x.name===label)};let step='page';
   try{await page.goto(`${base}/embed/tv/65942/1/1?autoplay=1&muted=1&source=source-17`,{waitUntil:'domcontentloaded',timeout:20000});step='option';await page.waitForFunction(()=>window.__elfura?.player?.getSources().length>0,null,{timeout:25000});row.options=await page.evaluate(()=>window.__elfura.player.getSources().length);step='playback';await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v&&v.videoWidth>0&&v.currentTime>1&&v.readyState>=2},null,{timeout:30000});row.video=await page.evaluate(()=>{const v=window.__elfura.player.video;return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime,duration:v.duration,ready:v.readyState}});row.playback=true;
   }catch(e){row.playback=false;row.step=step;row.error=e.name;row.state=await page.evaluate(()=>{const v=window.__elfura?.player?.video;return v?{width:v.videoWidth,time:v.currentTime,ready:v.readyState}:null}).catch(()=>null)}rows.push(row);
  }
  console.log('::notice title=ReZero actual Source 17 playback::'+JSON.stringify(rows).replace(/%/g,'%25'));
 }finally{await browser?.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r))}
 if(!inventory.length)process.exitCode=1;
}finally{globalThis.fetch=original}
