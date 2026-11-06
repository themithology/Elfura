// Hit real /diagnose endpoints; output only sanitized aggregate observations.
import {createBackendServer} from '../../dist/backend/index.js';
const {server}=createBackendServer({isProd:false});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const local=`http://127.0.0.1:${server.address().port}`;
const production='https://embed.theogpiratebot.online';
const cases=[{type:'movie',id:'693134'}, {type:'movie',id:'872585'}, {type:'tv',id:'93405'}];
async function check(env,base,c) {
 const start=Date.now();try {
  const params=new URLSearchParams({type:c.type,tmdb:c.id,s:'1',e:'1'});
  const r=await fetch(`${base}/diagnose/?${params}`,{signal:AbortSignal.timeout(45000)});
  if(!r.ok){console.log('::notice title=DiagnoseConfirmation::'+JSON.stringify({env,...c,status:r.status,elapsedMs:Date.now()-start}));return;}
  const x=await r.json();
  const sources=(x.sources||[]).map(s=>({id:s.id,raw:s.raw,verified:s.verified,verifiedAlive:s.verifiedAlive,multiAudio:s.multiAudio,ms:s.ms,error:s.error,options:(s.options||[]).filter(o=>o.probe?.alive||o.reachability==='verified').map(o=>({type:o.type,claimedAudio:o.claimedAudio,verifiedMultiAudio:o.verifiedMultiAudio,kind:o.probe?.manifestKind,audio:o.probe?.audioLanguages||[]})).slice(0,6)}));
  console.log('::notice title=DiagnoseConfirmation::'+JSON.stringify({env,...c,status:r.status,build:x.build?.commit,generatedAt:x.generatedAt,totalMs:x.totalMs,tmdb:x.tmdb,sources,selected:(x.selected||[]).map(s=>({sourceId:s.sourceId,multiAudio:s.multiAudio,languages:s.languages,verified:s.verified})),hints:x.hints}));
 }catch(e){console.log('::notice title=DiagnoseConfirmation::'+JSON.stringify({env,...c,error:e.name,cause:e.cause?.code||null,elapsedMs:Date.now()-start}));}
}
try {for(const c of cases)await Promise.all([check('latest-checkout',local,c),check('production',production,c)]);}
finally {await new Promise(r=>server.close(r));}
