// Research Aethoflix's reported labels vs unique playable manifests. No URLs or tokens logged.
import {createHash} from 'node:crypto';
const root='https://embed.aethoflix.live', type=process.env.TEST_TYPE||'movie', id=process.env.TEST_TMDB||'693134';
const q=new URLSearchParams({tmdbId:id,mediaType:type,server:'orion'});if(type==='tv'){q.set('season','1');q.set('episode','1');}
const headers={Accept:'application/json',Referer:`${root}/embed/${type}/${id}`, 'User-Agent':'Mozilla/5.0'};
function hash(s){return createHash('sha256').update(s).digest('hex').slice(0,12);}
function safeUrl(path,base=root){try{const u=new URL(path,base);if(u.origin!==root)return null;return u.toString()}catch{return null}}
async function get(url,accept){const r=await fetch(url,{headers:{...headers,Accept:accept},signal:AbortSignal.timeout(12000)});return r;}
try {
 const started=Date.now(), r=await get(`${root}/api/extract?${q}`,'application/json'),j=await r.json();
 const buckets=Object.entries(j.byServer||{}), unique=new Map();
 for(const [name,bucket] of buckets){for(const s of bucket.sources||[]){const u=safeUrl(s.url);if(u){const x=unique.get(u)||{url:u,nodes:[],labels:[]};x.nodes.push(name);if(s.language&&!x.labels.includes(s.language))x.labels.push(s.language);unique.set(u,x)}}}
 const candidates=[...unique.values()].slice(0,8);
 const results=await Promise.all(candidates.map(async c=>{try{const a=await get(c.url,'application/vnd.apple.mpegurl');const txt=await a.text();const audio=txt.split('\n').filter(x=>/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(x)).map(x=>({lang:/LANGUAGE="([^"]+)"/i.exec(x)?.[1]||null,name:/NAME="([^"]+)"/i.exec(x)?.[1]||null}));const childRaw=txt.split(/\r?\n/).find(x=>x.trim()&&!x.startsWith('#'));const childUrl=childRaw?safeUrl(childRaw,c.url):null;let child=null;if(childUrl){const cr=await get(childUrl,'application/vnd.apple.mpegurl');const ct=await cr.text();const segment=ct.split(/\r?\n/).find(x=>x.trim()&&!x.startsWith('#'));const segUrl=segment?safeUrl(segment,childUrl):null;let seg=null;if(segUrl){const sr=await fetch(segUrl,{headers:{...headers,Range:'bytes=0-1023'},signal:AbortSignal.timeout(10000)});seg={status:sr.status,type:sr.headers.get('content-type')};await sr.body?.cancel()}child={status:cr.status,isHls:ct.trimStart().startsWith('#EXTM3U'),segment:seg};}
 return {id:hash(c.url),nodes:c.nodes.length,labels:c.labels,status:a.status,isHls:txt.trimStart().startsWith('#EXTM3U'),audio,child};}catch(e){return{id:hash(c.url),nodes:c.nodes.length,error:e.name}}}));
 console.log('::notice title=AethoMatrix::'+JSON.stringify({type,id,status:r.status,elapsedMs:Date.now()-started,reportedBuckets:buckets.length,reportedSources:buckets.reduce((n,[,x])=>n+(x.sources?.length||0),0),distinct:unique.size,results}));
}catch(e){console.log('::notice title=AethoMatrix::'+JSON.stringify({type,id,error:e.name}));process.exitCode=1;}
