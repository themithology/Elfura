// Research only: test raw playlist references from documented Novus embeds.
// No raw URLs, cookies or response bodies are printed or committed.
import {anilistIdForTmdb} from '../../dist/backend/sources/anime-db.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const origin='https://novuscloud.buzz',ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const samples=[['Naruto','46260',1],['Naruto','46260',2],['Jujutsu Kaisen','95479',1],['Attack on Titan','1429',1],['Naruto negative episode','46260',9999]];
const output={};
for(const [title,id,ep] of samples){
 const mapping=await anilistIdForTmdb(id),rows=[];
 for(const lane of ['hsub','sub','dub']){const row={title,ep,lane};try{
  if(!mapping)throw Error('mapping');
  const page=new URL(`/embed/ani/${mapping.anilistId}/${ep}/${lane}`,origin);page.searchParams.set('k','1');
  const r=await fetch(page,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{'User-Agent':ua,Referer:'https://anikototv.to/','Sec-Fetch-Dest':'iframe'}});row.pageStatus=r.status;
  const html=await readBoundedText(r,1500000);if(!r.ok||!html)throw Error('page');
  row.m3u8Mentions=(html.match(/\.m3u8/gi)??[]).length;
  const values=[];
  for(const m of html.matchAll(/(?:["'](?:file|src|url)["']|\b(?:file|src|url))\s*:\s*["']([^"'\r\n]{1,4096})["']/gi)){
   const raw=m[1].replace(/\\\//g,'/').replace(/\\u0026/gi,'&');
   if(!/\.m3u8/i.test(raw))continue;
   try{const u=new URL(raw,origin);if(u.protocol==='https:'&&!u.username&&!u.password&&isSafeUpstreamUrl(u.href)&&!values.includes(u.href))values.push(u.href);}catch{}
  }
  row.candidates=values.length;row.checks=[];
  for(const source of values.slice(0,2)){
   const check={sameHost:new URL(source).origin===origin,fingerprint:createHash('sha256').update(source).digest('hex').slice(0,12)};
   try{const mr=await fetch(source,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'User-Agent':ua,Referer:page.href}});check.status=mr.status;const text=await readBoundedText(mr,256000);check.hls=!!text?.trimStart().startsWith('#EXTM3U');check.master=!!text?.includes('#EXT-X-STREAM-INF');check.subtitles=!!text?.includes('TYPE=SUBTITLES');
    if(mr.ok&&check.hls&&!output[`${id}-${ep}-${lane}`])output[`${id}-${ep}-${lane}`]={url:source,referer:page.href};
   }catch(e){check.error=e.name;}row.checks.push(check);
  }
 }catch(e){row.error=e.message==='mapping'?'mapping':e.message==='page'?'page':e.name;}rows.push(row);}
 console.log('::notice title=Novus raw stream research::'+JSON.stringify(rows));
}
if(process.env.RESEARCH_STREAM_FILE)await writeFile(process.env.RESEARCH_STREAM_FILE,JSON.stringify(output),{mode:0o600});
