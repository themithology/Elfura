// Research-only; no upstream links, tokens, cookies or page bodies are logged.
// Use fixed public title samples and report only status/shape/evidence.
import {createHash} from 'node:crypto';
import {wreqFetch,closeWreqSessions} from '../../dist/backend/vendor/anivexa/core/wreq.js';
import {extractManifestAudioLangs} from '../../dist/backend/relay.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const headers={'User-Agent':ua,Accept:'text/html,application/json,*/*','Accept-Language':'en-US,en;q=0.9'};
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
async function get(u, opts={}) {
 if(!isSafeUpstreamUrl(String(u)))throw Error('unsafe-url');
 const r=await fetch(u,{...opts,redirect:'error',headers:{...headers,...opts.headers},signal:AbortSignal.timeout(9000)});
 const len=Number(r.headers.get('content-length')??0);
 if(len>2_000_000){await r.body?.cancel();throw Error('oversize');}
 return {status:r.status,text:await r.text(),url:r.url};
}
const hosts=['animesalt.cx','animesalt.ac','animesalt.link','animesalt.ro','animesalt.me','animesalt.cc','watchanimeworld.top','watchanimeworld.in','www.desidubanime.me'];
const rows=await Promise.all(hosts.map(async host=>{
 const row={host};
 try{
  const res=await get(`https://${host}/`);row.status=res.status;row.cf=/cf-chl|just a moment/i.test(res.text);
  if(res.status===403){
   try{const wr=await wreqFetch(`https://${host}/`,{session:'audit-'+host,headers,signal:AbortSignal.timeout(10000)});row.browserTlsStatus=wr.status;await wr.body?.cancel();}catch(e){row.browserTlsError=e.name;}
  }
 }catch(e){row.error=e.name;}
 return row;
}));
console.log('::notice title=Anime raw provider access::'+JSON.stringify(rows));
const active=rows.filter(r=>['animesalt.cx','animesalt.ac'].includes(r.host) && (r.status===200 || r.browserTlsStatus===200));
const reports=[];
for(const access of active) for(const [title,slug] of [['Naruto','naruto'],['Jujutsu Kaisen','jujutsu-kaisen']]) for(const episode of [1,2]) {
 const host=access.host;
 const row={host,title,episode};
 try {
  const episodeUrl=`https://${host}/episode/${slug}-1x${episode}/`;
  let page;
  if(access.status!==200 && access.browserTlsStatus===200){
   const wr=await wreqFetch(episodeUrl,{session:'audit-'+host,headers:{...headers,Referer:`https://${host}/`},signal:AbortSignal.timeout(12000)});
   page={status:wr.status,text:await wr.text(),url:wr.url};
  } else page=await get(episodeUrl,{headers:{Referer:`https://${host}/`}});
  row.status=page.status;
  if(page.status!==200){reports.push(row);continue;}
  const titleText=page.text.match(/<title[^>]*>([^<]+)/i)?.[1]??'';row.pageTitle=titleText.slice(0,110);row.titleMatches=titleText.toLowerCase().includes(title.toLowerCase());
  try{row.finalPath=new URL(page.url).pathname}catch{}
  const found=[...page.text.matchAll(/(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)].map(m=>m[1].replace(/&amp;/g,'&'));
  const iframeTags=[...page.text.matchAll(/<iframe\b[^>]*>/gi)].map(m=>m[0]);
  row.iframeTags=iframeTags.length;
  row.iframeHosts=iframeTags.map(t=>{const s=t.match(/(?:src|data-src)\s*=\s*["']([^"']+)/i)?.[1];try{return new URL(s,`https://${host}`).hostname}catch{return 'none'}}).slice(0,12);
  row.videoPaths=(page.text.match(/\/video\/[a-f0-9]{10,}/gi)??[]).length;
  row.playerStrings=(page.text.match(/(?:as-cdn|zephyrix|zephyrflick|multi-lang-plyr)/gi)??[]).length;
  let iframe;
  for(const item of found){try{const u=new URL(item,`https://${host}`);if(/^as-cdn\d*\.top$|^(?:play\.)?zephyrix\.org$|^zephyrflick\.[a-z]+$|^ravok\.buzz$/i.test(u.hostname)&&/^\/video\/[a-f0-9]+\/?$/i.test(u.pathname)){iframe=u;break}}catch{}}
  row.iframeCount=found.length;row.rawPlayer=!!iframe;
  if(!iframe){reports.push(row);continue;}
  const id=iframe.pathname.split('/').filter(Boolean).at(-1);
  const api=new URL('/player/index.php',iframe.origin);api.search=new URLSearchParams({data:id,do:'getVideo'});
  const p=await get(api,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest',Origin:iframe.origin,Referer:iframe.href},body:new URLSearchParams({hash:id,r:`https://${host}/`}).toString()});
  row.apiStatus=p.status;const json=JSON.parse(p.text);const manifest=new URL(json.videoSource||json.securedLink,iframe.origin);row.manifestKey=hash(manifest.href);
  const h={Referer:iframe.origin+'/',Origin:iframe.origin};
  const mr=await get(manifest,{headers:h});row.manifestStatus=mr.status;row.manifest=mr.text.startsWith('#EXTM3U');row.audio=extractManifestAudioLangs(mr.text);row.variants=(mr.text.match(/#EXT-X-STREAM-INF:/g)??[]).length;row.codecs=[...new Set([...mr.text.matchAll(/CODECS="([^"]+)"/g)].map(x=>x[1]))];
  const lines=mr.text.split(/\r?\n/);const pos=lines.findIndex(s=>s.startsWith('#EXT-X-STREAM-INF:'));const child=pos<0?null:lines.slice(pos+1).find(s=>s.trim()&&!s.startsWith('#'));
  if(child){const cr=await get(new URL(child,manifest),{headers:h});row.childStatus=cr.status;const seg=cr.text.split(/\r?\n/).find(s=>s.trim()&&!s.startsWith('#'));if(seg){const url=new URL(seg,new URL(child,manifest));if(!isSafeUpstreamUrl(url.href))throw Error('unsafe segment');const sr=await fetch(url,{redirect:'error',headers:{...headers,...h,Range:'bytes=0-2047'},signal:AbortSignal.timeout(9000)});row.segmentStatus=sr.status;await sr.body?.cancel();}}
 }catch(e){row.error=String(e.message??e).replace(/https?:\/\/\S+/g,'[url]').slice(0,90);}
 reports.push(row);
}
console.log('::notice title=AnimeSalt raw streams::'+JSON.stringify(reports));
await closeWreqSessions().catch(()=>{});
