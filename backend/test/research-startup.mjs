// Live, bounded startup audit. Never log tickets, URLs, or upstream credentials.
import { createBackendServer } from '../../dist/backend/index.js';
const {server}=createBackendServer({isProd:false,requireToken:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
for(const c of [{type:'movie',id:'872585'},{type:'movie',id:'299534'},{type:'movie',id:'579974'},{type:'tv',id:'93405'},{type:'tv',id:'85937'}]) {
 const start=Date.now();try{const q=new URLSearchParams({type:c.type,tmdb:c.id,...c.type==='tv'?{s:'1',e:'1'}:{}});const r=await fetch(base+'/api/v1/playback?'+q,{signal:AbortSignal.timeout(35000)});const d=await r.json();console.log(`::notice title=StartupAudit::${JSON.stringify({id:c.id,type:c.type,status:r.status,ms:Date.now()-start,sources:(d.sources||[]).map(s=>({id:s.sourceId,multi:s.multiAudio,langs:s.availableAudioLangs||[]})).slice(0,12),error:d.error}).replace(/%/g,'%25')}`);}catch(e){console.log(`::notice title=StartupAudit::${JSON.stringify({id:c.id,ms:Date.now()-start,error:e.name})}`)}
}
await new Promise(r=>server.close(r));
