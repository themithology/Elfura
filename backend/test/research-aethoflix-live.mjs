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
 for(let attempt=0;attempt<2;attempt++) {try {const r=await fetch(u,{signal:AbortSignal.timeout(30000)});const text=await limited(r);return {status:r.status,text};}catch{}}
 return {status:0,text:''};
}));
const all=html+'\n'+files.map(f=>f.text).join('\n');
await import('node:fs/promises').then(fs=>fs.writeFile('/tmp/aethoflix-public-client.txt',all));
const hostnames=[...new Set([...all.matchAll(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[\/:"'`\\\s]|$)/gi)].map(m=>m[1].toLowerCase()))];
const relevant=hostnames.filter(h=>/aetho|rousav|vidbolt|vidrift|vidsync|vidlink|vidrock|vidstuck|nxsha|zxcstream|workers|hscow|telegram|tgflix|tghub/i.test(h)).sort();
const markers=['/api/extract','/api/scan','/embed/movie/','/embed/tv/','/api/proxy-m3u8','rousav','vidbolt','nxsha','vidstuck'];
notice({scripts:scripts.length,statuses:files.map(x=>x.status),relevantHosts:relevant,markers:Object.fromEntries(markers.map(m=>[m,all.includes(m)]))});
const terms=['rousav','vidbolt','AethoOrion','AethoRousav','/api/extract','/api/proxy-m3u8','aethoflix.world'];
const contexts=Object.fromEntries(terms.map(term=>{ const i=all.indexOf(term); return [term,i<0?'missing':all.slice(Math.max(0,i-300),i+450).replace(/https?:\\?\/\\?\/[^\s"'`<>]+\?[^\s"'`<>]+/gi,'[url-redacted]')]; }));
const definitions=[...all.matchAll(/\{id:`([^`]+)`,name:`Aetho[^`]+`,description:`[^`]*`,provider:`([^`]+)`,upstreamServer:`([^`]+)`/g)].map(m=>({id:m[1],provider:m[2],upstream:m[3]}));
notice({definitions,contexts});
// Preserve complete source labels and the client-side request construction without tokens.
const defRaw=[...all.matchAll(/\{id:`([^`]+)`,name:`Aetho[^`]+`,description:`[^`]*`,provider:`[^`]+`,upstreamServer:`[^`]+`[^}]*\}/g)].map(m=>m[0]);
notice({sourceDefinitions:defRaw});
const details={};
for(const term of ['provider:`sniper`','upstreamServer:`download`','/api/extract','/api/scan']) {
 const matches=[...all.matchAll(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))].slice(0,3);
 details[term]=matches.map(m=>all.slice(Math.max(0,m.index-350),m.index+700).replace(/https?:\\?\/\\?\/[^\s"'`<>]+\?[^\s"'`<>]+/gi,'[url-redacted]'));
}
notice({details});

// Recheck the deployed public client and endpoint availability.

notice({audit: "fresh-client-definitions"});
