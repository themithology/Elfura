// Bounded live observation, not a full movie verification; never prints stream URLs or tickets.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
process.env.ELFURA_EXPERIMENTAL_HLS_DOWNLOADS='1';
const {server}=createBackendServer({...loadBackendConfig(),isProd:false,requireToken:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
try {
 for(const [type,id,extra] of [['movie','693134',''],['movie','940721',''],['tv','93405','&season=1&episode=1']]) {
  try {
   const res=await fetch(`${base}/dl/api/resolve?type=${type}&tmdb=${id}${extra}`,{signal:AbortSignal.timeout(45000)});const data=await res.json();const items=data.items||[];
   let observed='no options';
   for(const item of items.slice(0,3)) {
    try {const r=await fetch(`${base}/dl/go?t=${encodeURIComponent(item.ticket)}`,{signal:AbortSignal.timeout(20000)});if(!r.ok){observed=`HTTP ${r.status}`;continue;}const reader=r.body.getReader();let count=0;while(count<65536){const x=await reader.read();if(x.done)break;count+=x.value.length;}await reader.cancel();observed=`started (${count} bytes, ${item.quality}, ${item.languages.join('/')})`;if(count)break;}catch{observed='timeout or stream failure';}
   }
   console.log(`::notice title=HLSLive::${JSON.stringify({type,id,options:items.length,observed})}`);
  }catch(e){console.log(`::notice title=HLSLive::${JSON.stringify({type,id,error:String(e).slice(0,120)})}`);}
 }
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
