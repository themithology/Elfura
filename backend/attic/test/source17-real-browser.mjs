// Actual Source 17 -> registry -> relay -> Chromium player. TMDB metadata is a
// fixture. Reports playback metrics, never URLs, tickets or credentials.
import {createBackendServer} from '../../../dist/backend/index.js';
import {loadBackendConfig} from '../../../dist/backend/config.js';
import {createSource17Adapter} from '../../../dist/backend/sources/source17.js';
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
const samples=[{type:'movie',id:'1303331',title:'Dhamaal 4',runtime:141,kind:'hls'},{type:'movie',id:'550',title:'Fight Club',runtime:139,kind:'hls'},{type:'movie',id:'550',title:'Fight Club',runtime:139,kind:'dash'},{type:'tv',id:'1396',title:'Breaking Bad',runtime:58,kind:'hls'},{type:'tv',id:'1396',title:'Breaking Bad',runtime:58,kind:'dash'},{type:'movie',id:'550',title:'Fight Club',runtime:139,kind:'mixed'}];
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(u.hostname!=='tmdb-fixture.example')return original(input,init);const sample=samples.find(s=>u.pathname.split('/').includes(s.id));if(!sample)return new Response(null,{status:404});if(u.pathname.includes('/episode/'))return Response.json({name:'Episode 1',runtime:sample.runtime});return Response.json({id:Number(sample.id),title:sample.title,name:sample.title,original_name:sample.title,release_date:'2020-01-01',first_air_date:'2020-01-01',original_language:'en',runtime:sample.runtime,episode_run_time:[sample.runtime],genres:[],images:{logos:[]}})};
const cfg=loadBackendConfig({ELFURA_SECRET:'fixture-only-source17-secret',TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});const actual=createSource17Adapter(()=>true);let filter='hls',lastInventory=null;registry.adapters=[{...actual,async resolve(q){const diag=[];const r=await actual.resolve({...q,diag});lastInventory={diag,types:r.candidates.filter(c=>new URL(c.url).hostname==='tgvidx.lovable.app').map(c=>c.type)};return {...r,candidates:r.candidates.filter(c=>(filter==='mixed'||c.type===filter)&&new URL(c.url).hostname==='tgvidx.lovable.app')}}}];
let browser;const results=[];
try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch({executablePath:await binary.executablePath(),args:[...binary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 for(const sample of samples){
  filter=sample.kind;lastInventory=null;registry.ramCache.clear();registry.finishedLate.clear();let step='page';const row={type:sample.type,id:sample.id,kind:sample.kind};
  try{
   const route=sample.type==='movie'?`movie/${sample.id}`:`tv/${sample.id}/1/1`;
   await page.goto(`${base}/embed/${route}?autoplay=1&muted=1&source=source-17`,{waitUntil:'domcontentloaded',timeout:20000});
   step='options';await page.waitForFunction(()=>window.__elfura?.player?.getSources().length>0,null,{timeout:35000});
   row.options=await page.evaluate(()=>window.__elfura.player.getSources().map(s=>({id:s.id,type:s.type})));
   if(sample.kind==='mixed'){
    const dash=row.options.find(x=>x.type==='dash');if(!dash||!row.options.some(x=>x.type==='hls'))throw Error('both-types-required');
    const hevc=await page.evaluate(()=>MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')||MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"'));
    row.hevcSupported=hevc;
    if(!hevc){step='force-dash';await page.evaluate(id=>window.__elfura.player.setSource(id),dash.id);step='fallback';await page.waitForFunction(()=>{const p=window.__elfura?.player,v=p?.video;return p?.currentSource?.type==='hls'&&v?.videoWidth>0&&v.currentTime>1},null,{timeout:35000});row.fallback=true;}
   }else if(!row.options.some(x=>x.type===sample.kind))throw Error('wrong-type');
   const hevc=await page.evaluate(()=>MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')||MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"'));
   if(sample.kind==='dash'&&!hevc){step='unsupported-codec';await page.waitForTimeout(9000);row.video=await page.evaluate(()=>{const v=window.__elfura.player.video;return {width:v.videoWidth,time:v.currentTime,ready:v.readyState}});if(row.video.width||row.video.time>0.5)throw Error('audio-only-playback');row.unsupportedRejected=true;}
   else {step='playback';await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v&&v.videoWidth>0&&v.currentTime>1&&v.readyState>=2},null,{timeout:35000});row.video=await page.evaluate(()=>{const v=window.__elfura.player.video;return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime,ready:v.readyState}})}
   row.ok=true;
  }catch(e){
   // Skip only an explicitly absent type in a successful inventory, never a
   // discovery error or a failure of a candidate that was actually present.
   const inventoryOk=lastInventory?.diag?.some(d=>d.ok);
   const missingType=inventoryOk&&(sample.kind==='mixed'
    ? ['hls','dash'].find(t=>!lastInventory.types.includes(t))
    : !lastInventory.types.includes(sample.kind)?sample.kind:null);
   if(missingType&&((sample.kind!=='mixed'&&step==='options')||(sample.kind==='mixed'&&e.message==='both-types-required'))){row.ok=null;row.skipped=`${missingType} not present in current upstream inventory`;row.inventory=lastInventory.types}
   else {row.ok=false;row.step=step;row.error=e.message==='wrong-type'||e.message==='both-types-required'||e.message==='audio-only-playback'?e.message:e.name;row.inventory=lastInventory;row.state=await page.evaluate(()=>{const v=window.__elfura?.player?.video;return v?{time:v.currentTime,width:v.videoWidth,ready:v.readyState}:null}).catch(()=>null)}
  }results.push(row);
 }

 console.log('::notice title=TGVIDX actual adapter and browser::'+JSON.stringify(results).replace(/%/g,'%25'));if(results.some(r=>r.ok===false)||!results.some(r=>r.kind==='hls'&&r.ok===true))process.exitCode=1;
}finally{await browser?.close().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=original;}
