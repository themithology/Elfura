// Research-only probe: loads a temporary, unmodified upstream checkout. No media URL is logged.
import {run as search} from '/tmp/moviebox-research/lib/search.js';
import {run as matrix} from '/tmp/moviebox-research/lib/episode-matrix.js';
import crypto from 'node:crypto';
const title=process.env.TITLE||'Godzilla Minus One';const kind=process.env.KIND||'movie';
const started=Date.now();
try {
 const res=await search({q:title,limit:10});
 const candidates=(res.body?.results||[]).filter(x=>x.type===kind);
 const chosen=candidates.find(x=>x.title?.toLowerCase()===title.toLowerCase())||candidates[0];
 if(!chosen){console.log('::notice title=DownloadResearch::'+JSON.stringify({title,phase:'search',status:res.status,count:candidates.length,ms:Date.now()-started}));process.exit(0);}
 const result=await matrix({id:chosen.detailPath,...(kind==='tv'?{season:1,episode:1}:{})});
 const langs=(result.body?.languages||[]).map(l=>({language:l.lanName,code:l.lanCode,original:l.original,files:(l.qualities||[]).filter(q=>q.url&&!q.vipLocked).map(q=>({resolution:q.resolution,mb:q.size_mb,duration:q.duration_sec,url:q.url}))}));
 const samples=[];
 for(const lang of langs.filter(x=>x.files.length).slice(0,3)){
  const file=lang.files.find(x=>x.resolution===720)||lang.files[0];
  try {const rawUrl=new URL(file.url);if(rawUrl.protocol==='http:')rawUrl.protocol='https:';const r=await fetch(rawUrl,{headers:{Range:'bytes=0-65535',Referer:'https://movieboxonline.net/', 'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(10000)});const reader=r.body?.getReader();const pieces=[];let size=0;if(reader){while(size<65536){const chunk=await reader.read();if(chunk.done)break;pieces.push(chunk.value);size+=chunk.value.length;}await reader.cancel();}const data=Buffer.concat(pieces,size).subarray(0,65536);samples.push({language:lang.code||lang.language,originalScheme:new URL(file.url).protocol,finalScheme:new URL(r.url).protocol,host:new URL(r.url).hostname,status:r.status,contentType:r.headers.get('content-type'),range:r.headers.get('content-range'),bytes:data.length,mp4Signature:Buffer.from(data.slice(4,8)).toString()==='ftyp',fingerprint:crypto.createHash('sha256').update(data.slice(0,4096)).digest('hex').slice(0,12)});}catch(e){samples.push({language:lang.code||lang.language,error:e.name});}
 }
 console.log('::notice title=DownloadResearch::'+JSON.stringify({title,matched:chosen.title,year:chosen.releaseDate,kind,phase:'matrix',status:result.status,ms:Date.now()-started,languages:langs.map(x=>({language:x.language,code:x.code,original:x.original,qualities:x.files.map(({resolution,mb,duration})=>({resolution,mb,duration}))})),samples}));
}catch(e){console.log('::notice title=DownloadResearch::'+JSON.stringify({title,error:e.name,message:e.message,ms:Date.now()-started}));process.exitCode=1;}
