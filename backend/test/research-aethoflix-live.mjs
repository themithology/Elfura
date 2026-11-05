// Research-only probe. No production code uses Aethoflix. Avoid printing signed media URLs.
const root='https://embed.aethoflix.live';
const paths=['/','/embed/movie/693134','/embed/tv/93405/1/1','/api/extract?tmdbId=93405&mediaType=tv&season=1&episode=1&server=callisto','/api/scan?tmdbId=93405&mediaType=tv&season=1&episode=1'];
function notice(x) {console.log(`::notice title=AethoLive::${JSON.stringify(x).replace(/%/g,'%25').replace(/\n/g,'%0A')}`);}
async function limited(r,max=4_000_000) {
  if(!r.body)return '';
  const reader=r.body.getReader(), chunks=[];let size=0;
  try { while(size<max) {let x=await reader.read();if(x.done)break;chunks.push(x.value);size+=x.value.length;} } finally {await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks).subarray(0,max).toString('utf8');
}
const responses=await Promise.all(paths.map(async path=>{
  try {const r=await fetch(root+path,{signal:AbortSignal.timeout(12000)});const body=await limited(r);return {path:path.split('?')[0],status:r.status,contentType:r.headers.get('content-type'),finalHost:new URL(r.url).hostname,body};}
  catch(e){return {path:path.split('?')[0],error:e.name};}
}));
for(const r of responses) notice({path:r.path,status:r.status,contentType:r.contentType,finalHost:r.finalHost,error:r.error,html404:/the requested path could not be found/i.test(r.body||'')});
const html=responses[0]?.body||'';
const scripts=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m=>new URL(m[1],root).href).filter(u=>new URL(u).origin===root).slice(0,12);
const files=await Promise.all(scripts.map(async u=>{
 try {const r=await fetch(u,{signal:AbortSignal.timeout(12000)});const text=await limited(r);return {status:r.status,text};}catch{return {status:0,text:''};}
}));
const all=html+'\n'+files.map(f=>f.text).join('\n');
const hostnames=[...new Set([...all.matchAll(/https?:\\?\/\\?\/([a-z0-9.-]+\.[a-z]{2,})(?:[\/:"'\\]|$)/gi)].map(m=>m[1].toLowerCase()))];
const relevant=hostnames.filter(h=>/aetho|rousav|vidbolt|vidrift|vidsync|vidlink|vidrock|vidstuck|nxsha|zxcstream|workers|hscow|telegram|tgflix|tghub/i.test(h)).sort();
const markers=['/api/extract','/api/scan','/embed/movie/','/embed/tv/','/api/proxy-m3u8','rousav','vidbolt','nxsha','vidstuck'];
notice({scripts:scripts.length,statuses:files.map(x=>x.status),relevantHosts:relevant,markers:Object.fromEntries(markers.map(m=>[m,all.includes(m)]))});
