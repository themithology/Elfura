// Research only. Use the already-authorized bundled extractor with a restricted
// fetch wrapper, stripping the signing marker to ensure its VM path never runs.
// Never print response bodies, URLs, cookies, signing keys or ephemeral tokens.
import {extractMegaPlayDetails} from '../../dist/backend/vendor/anivexa/extractors/megaplay.js';
import {anilistIdForTmdb} from '../../dist/backend/sources/anime-db.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {createHash} from 'node:crypto';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {writeFile} from 'node:fs/promises';
const output={};
const origin='https://megaplay.buzz',ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function restricted(input,init={}){
 const url=new URL(input instanceof URL?input.href:typeof input==='string'?input:input.url);
 // Missing optional scripts must be empty strings, not null: the bundled
 // extractor's script scan does not tolerate failed optional script fetches.
 if(url.origin!==origin||url.username||url.password||!isSafeUpstreamUrl(url.href))return new Response('');
 let r;
 try { r=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(8000)}); }
 catch(e) { if(/\.js$/i.test(url.pathname)) return new Response(''); throw e; }
 if(!r.ok&&/\.js$/i.test(url.pathname))return new Response('');
 const text=await readBoundedText(r,2_000_000);
 if(text===null)throw Error('oversize');
 // The upstream extractor checks for this literal before running downloaded JS.
 // Neutralise it everywhere; a failed unsigned playlist is an explicit result.
 const safe=text.replaceAll('token=','token_disabled=');
 return new Response(safe,{status:r.status,headers:{'content-type':r.headers.get('content-type')??''}});
}
for(const [title,tmdb,ep] of [['Naruto','46260',1],['Naruto','46260',2],['Jujutsu Kaisen','95479',1],['Attack on Titan','1429',1]]){
 const mapping=await anilistIdForTmdb(tmdb),rows=[];
 for(const lane of ['sub','dub']){const row={title,episode:ep,lane};try{
  if(!mapping)throw Error('mapping');
  const page=`${origin}/stream/ani/${mapping.anilistId}/${ep}/${lane}`;
  const data=await extractMegaPlayDetails(page,{fetchImpl:restricted,userAgent:ua,referer:'https://anikototv.to/'});
  row.count=data.sources.length;row.tracks=data.tracks.length;row.trackShapes=data.tracks.slice(0,6).map(t=>({keys:Object.keys(t??{}).filter(k=>/^[a-zA-Z_]{1,24}$/.test(k)),kind:typeof t?.kind==='string'?t.kind.slice(0,16):null,label:typeof t?.label==='string'?t.label.slice(0,24):null,extension:(()=>{try{return new URL(t.file??t.url??'',origin).pathname.match(/\.[a-z0-9]{2,5}$/i)?.[0]??''}catch{return ''}})()}));row.sources=[];
  for(const source of data.sources.slice(0,2)){const v={variant:source.variant};try{const u=new URL(source.url);if(u.protocol!=='https:'||u.username||u.password||!isSafeUpstreamUrl(u.href))throw Error('unsafe');v.fingerprint=createHash('sha256').update(u.href).digest('hex').slice(0,12);const res=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{'User-Agent':ua,Referer:origin+'/'}});v.status=res.status;const text=await readBoundedText(res,256000);v.hls=!!text?.trimStart().startsWith('#EXTM3U');if(res.ok&&v.hls&&!output[`${tmdb}-${ep}-${lane}`])output[`${tmdb}-${ep}-${lane}`]={url:u.href,referer:origin+'/'};}catch(e){v.error=e.name;}row.sources.push(v);}
 }catch(e){row.error=/client script not found/.test(e.message)?'no-script':/file id not found/.test(e.message)?'no-id':/source routes not found/.test(e.message)?'no-routes':/response has no sources/.test(e.message)?'no-plaintext':e.name;if(e.name==='TypeError')row.detail=String(e.message).replace(/https?:\/\/\S+/g,'[url]').slice(0,140);}rows.push(row);}
 console.log('::notice title=MegaPlay safe extractor research::'+JSON.stringify(rows));
}
if(process.env.RESEARCH_STREAM_FILE)await writeFile(process.env.RESEARCH_STREAM_FILE,JSON.stringify(output),{mode:0o600});
