// Research only: known documented AniList routes + raw legacy response.
// Never execute provider scripts or print media URLs, tokens, payloads or cookies.
import {anilistIdForTmdb} from '../../dist/backend/sources/anime-db.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const origin='https://megaplay.buzz',ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const output={};
for(const [title,id,ep] of [['Naruto','46260',1],['Naruto','46260',2],['Jujutsu Kaisen','95479',1],['Attack on Titan','1429',1],['Naruto negative episode','46260',9999]]){
 const mapping=await anilistIdForTmdb(id),rows=[];
 for(const lane of ['sub','dub']){const row={title,ep,lane};try{
  if(!mapping)throw Error('mapping');
  const page=new URL(`/stream/ani/${mapping.anilistId}/${ep}/${lane}`,origin);
  const r=await fetch(page,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{'User-Agent':ua,Referer:'https://anikototv.to/'}});row.pageStatus=r.status;
  const html=await readBoundedText(r,1500000);if(!r.ok||!html)throw Error('page');
  const idMatches=[...html.matchAll(/\bdata-id\s*=\s*["'](\d{1,18})["']/gi)].map(x=>x[1]);const fileId=idMatches[0];row.idsFound=idMatches.length;
  if(!fileId)throw Error('no-id');
  const api=new URL('/stream/getSources',origin);api.searchParams.append('id',fileId);api.searchParams.append('id',fileId);
  const res=await fetch(api,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{'User-Agent':ua,Referer:page.href,'X-Requested-With':'XMLHttpRequest',Accept:'application/json'}});row.apiStatus=res.status;
  const text=await readBoundedText(res,256000);if(!res.ok||!text)throw Error('api');const data=JSON.parse(text);
  row.encrypted=typeof data.enc==='string';row.tracks=Array.isArray(data.tracks)?data.tracks.length:0;
  const source=typeof data.sources?.file==='string'?data.sources.file:null;row.plain=!!source;
  if(source){const u=new URL(source,origin);if(u.protocol==='https:'&&isSafeUpstreamUrl(u.href)&&!u.username&&!u.password){
   row.fingerprint=createHash('sha256').update(u.href).digest('hex').slice(0,12);
   try{const mr=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'User-Agent':ua,Referer:origin+'/'}});row.mediaStatus=mr.status;const body=await readBoundedText(mr,256000);row.hls=!!body?.trimStart().startsWith('#EXTM3U');if(mr.ok&&row.hls)output[`${id}-${ep}-${lane}`]={url:u.href,referer:origin+'/'};}catch(e){row.mediaError=e.name;}
  }}
 }catch(e){row.error=['mapping','page','no-id','api'].includes(e.message)?e.message:e.name;}rows.push(row);}
 console.log('::notice title=MegaPlay raw stream research::'+JSON.stringify(rows));
}
if(process.env.RESEARCH_STREAM_FILE)await writeFile(process.env.RESEARCH_STREAM_FILE,JSON.stringify(output),{mode:0o600});
