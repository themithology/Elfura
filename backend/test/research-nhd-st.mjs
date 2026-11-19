// Research only: inspect the current public embed surface without logging signed URLs.
const origin='https://nhdapi.st';
for (const path of ['/movie/872585','/embed/movie/872585','/tv/93405/1/1','/embed/tv/93405/1/1']) {
 try {
  const r=await fetch(origin+path,{signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0'}});
  const t=(await r.text()).slice(0,500000);
  const hosts=[...new Set([...t.matchAll(/https?:\\?\/\\?\/([a-z0-9.-]+)/gi)].map(m=>m[1].toLowerCase()))].slice(0,25);
  const scripts=[...t.matchAll(/<script[^>]+src=["']([^"']+)/gi)].map(m=>{try {const u=new URL(m[1],r.url);return u.hostname+u.pathname;}catch{return 'invalid';}}).slice(0,15);
  console.log(`::notice title=NHDResearch::${JSON.stringify({path,status:r.status,finalHost:new URL(r.url).hostname,bytes:t.length,hosts,scripts,cloudflare:/just a moment|cloudflare/i.test(t)}).replace(/%/g,'%25')}`);
 } catch(e) {console.log(`::notice title=NHDResearch::${JSON.stringify({path,error:e.name,cause:e.cause?.code})}`);}
}
