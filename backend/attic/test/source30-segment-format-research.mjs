// Live upstream format inspection. Never print URLs, media bytes or tokens.
import {createSource30Adapter} from '../../../dist/backend/sources/source30.js';
import {restrictedFetchWithRedirects} from '../../../dist/backend/restricted-fetch.js';
import {readBoundedText} from '../../../dist/backend/sources/upstream-fetch.js';
import {resolveHlsChildUrl} from '../../../dist/backend/relay.js';
import {sniffMediaBytes} from '../../../dist/backend/sources/media-sniff.js';
const a=createSource30Adapter(()=>true,{mapEpisode:async()=>({anilistId:'20',episode:2})});
const options=(await a.resolve({type:'tv',tmdbId:'46260',season:1,episode:2})).candidates;
const out=[];
for(const c of options.filter(x=>x.audioVariant==='dub')) {
 let url=c.url;
 const get=async u=>restrictedFetchWithRedirects(u,{headers:c.headers,signal:AbortSignal.timeout(12000)},'*public*');
 let r=await get(url);let text=await readBoundedText(r,500000);
 let ref=text.split(/\r?\n/).map(x=>x.trim()).find(x=>x&&!x.startsWith('#'));
 url=resolveHlsChildUrl(ref,r.url||url);r=await get(url);text=await readBoundedText(r,500000);
 const parts=[];let t=0,dur=0;
 for(const line of text.split(/\r?\n/).map(x=>x.trim())){const m=line.match(/^#EXTINF:([\d.]+)/);if(m)dur=Number(m[1]);else if(line&&!line.startsWith('#')&&dur){parts.push({t,ref:line});t+=dur;dur=0;}}
 const chosen=[...parts.slice(0,5),...parts.filter(x=>x.t>=410&&x.t<440).slice(0,6)];
 for(const seg of chosen)try{
  const res=await get(resolveHlsChildUrl(seg.ref,r.url||url));const reader=res.body?.getReader();const first=await reader?.read();const bytes=first?.value??new Uint8Array();
  const sample=bytes.slice(0,512);const printable=[...sample].filter(x=>(x>=32&&x<=126)||x===9||x===10||x===13).length;
  const prefix=new TextDecoder().decode(sample).replace(/^\uFEFF/,'').trimStart().toLowerCase();
  out.push({at:Math.round(seg.t),status:res.status,contentType:(res.headers.get('content-type')??'').split(';')[0],firstBytes:bytes.length,sniff:sniffMediaBytes(sample),looksHtml:/^<(?:!doctype|html|head|body|script)/.test(prefix),printablePercent:sample.length?Math.round(100*printable/sample.length):0});
  await reader?.cancel();
 }catch(e){out.push({at:Math.round(seg.t),error:e.name});}
}
console.log('::notice title=Segment format inspection::'+JSON.stringify(out));
if(!out.length)process.exitCode=1;
