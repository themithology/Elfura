// Research only: inspect documented AniList embeds; never print stream URLs,
// identifiers hidden in player payloads, tokens, cookies, or upstream scripts.
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {anilistIdForTmdb} from '../../dist/backend/sources/anime-db.js';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const samples=[['Naruto','46260'],['Jujutsu Kaisen','95479'],['Attack on Titan','1429']];
const cases=[['Novus','https://novuscloud.buzz','/embed/ani/','sub'],['Novus','https://novuscloud.buzz','/embed/ani/','dub'],['Novus','https://novuscloud.buzz','/embed/ani/','hsub'],['MegaPlay','https://megaplay.buzz','/stream/ani/','sub'],['MegaPlay','https://megaplay.buzz','/stream/ani/','dub']];
for(const [title,id] of samples){
 const mapped=await anilistIdForTmdb(id);if(!mapped){console.log('::notice title=Host discovery::'+JSON.stringify({title,error:'no-mapping'}));continue;}
 const rows=[];
 for(const [host,origin,path,lane] of cases){
  const row={title,host,lane};
  try{
   const url=new URL(`${path}${mapped.anilistId}/1/${lane}`,origin);if(host==='Novus')url.searchParams.set('k','1');
   const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'User-Agent':ua,Referer:'https://anikototv.to/', 'Sec-Fetch-Dest':'iframe'}});row.status=r.status;
   const html=await readBoundedText(r,1500000);if(html){
    row.titlePresent=/<title/i.test(html);row.playerId=!!html.match(/data-id=["']\d+["']/i);row.m3u8InPage=/\.m3u8/i.test(html);
    row.embedOnly=/embedded playback only|works inside an embed/i.test(html);
    const scripts=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(x=>{try{return new URL(x[1],origin)}catch{return null}}).filter(u=>u&&u.origin===origin&&u.protocol==='https:'&&!u.hash).slice(0,8);
    row.assets=scripts.map(x=>x.pathname.slice(0,120));row.scriptSummary=[];
    // Only first sample per lane needs script inspection.
    if(title==='Naruto')for(const script of scripts){
     try{const sr=await fetch(script,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{'User-Agent':ua,Referer:url.href}});const text=await readBoundedText(sr,2000000);if(text)row.scriptSummary.push({path:script.pathname.slice(0,100),status:sr.status,sourceApi:/getSources/i.test(text),m3u8:/m3u8/i.test(text),hls:/hls/i.test(text),routes:[...new Set([...text.matchAll(/["'](\/?(?:stream|api|embed)\/[a-zA-Z0-9_\/-]{2,60})["']/g)].map(x=>x[1]))].slice(0,12)});}catch{row.scriptSummary.push({path:script.pathname.slice(0,100),error:'fetch'});}
    }
   }
  }catch(e){row.error=e.name;}rows.push(row);
 }
 console.log('::notice title=Host discovery::'+JSON.stringify(rows));
}
