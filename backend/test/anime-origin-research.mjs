// Disposable host/redirect shape audit; never print URLs, query strings or media.
import {readFile} from 'node:fs/promises';
const streams=JSON.parse(await readFile(process.env.RESEARCH_STREAM_FILE,'utf8'));
const rows=[];
for(const [sample,s] of Object.entries(streams)){
 const root=new URL(s.url), ua='Mozilla/5.0';const row={sample,levels:[]};
 try{let current=s.url;for(let depth=0;depth<3;depth++){
  const r=await fetch(current,{redirect:'manual',headers:{'User-Agent':ua,Referer:s.referer},signal:AbortSignal.timeout(8000)});
  const level={status:r.status,origin:new URL(current).origin,locationOrigin:null,refs:[]};
  if(r.status>=300&&r.status<400){const l=r.headers.get('location');if(l)level.locationOrigin=new URL(l,current).origin;row.levels.push(level);break;}
  const text=await r.text();if(!text.trimStart().startsWith('#EXTM3U')){row.levels.push(level);break;}
  const refs=text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
  for(const m of text.matchAll(/URI="([^"]+)"/g))refs.push(m[1]);
  level.refs=[...new Set(refs.slice(0,100).map(ref=>{try{return new URL(ref,current).origin}catch{return 'invalid'}}))].slice(0,12);row.levels.push(level);
  const next=refs.find(x=>/\.m3u8(?:[?#]|$)/i.test(x))||((/#EXT-X-STREAM-INF/.test(text))?refs[0]:null);if(!next)break;current=new URL(next,current).href;
 }}catch(e){row.error=e.name;} rows.push(row);
}
console.log('::notice title=Anime media origin shapes::'+JSON.stringify(rows));
