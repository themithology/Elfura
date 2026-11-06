// Research only. Query every advertised label separately; never print opaque URLs.
import {createHash} from 'node:crypto';
const root='https://embed.aethoflix.live';
const type=process.env.TEST_TYPE||'tv', id=process.env.TEST_TMDB||'93405';
const common={tmdbId:id,mediaType:type,...(type==='tv'?{season:'1',episode:'1'}:{})};
const hash=x=>createHash('sha256').update(x).digest('hex').slice(0,12);
const notice=x=>console.log('::notice title=AethoAll::'+JSON.stringify(x).replace(/%/g,'%25'));
async function json(url) {const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Mozilla/5.0',Referer:root+'/'},signal:AbortSignal.timeout(20000)}); if(!r.ok) throw new Error('HTTP '+r.status); return r.json();}
const scan=await json(`${root}/api/scan?${new URLSearchParams(common)}`);
const labels=scan.scanReport||[];
notice({type,id,reported:labels.length,inventory:labels.map(({id,name,provider,languages})=>({id,name,provider,languages}))});
let cursor=0;const results=[];
await Promise.all(Array.from({length:3},async()=>{while(cursor<labels.length){const item=labels[cursor++],started=Date.now();try{
  const body=await json(`${root}/api/extract?${new URLSearchParams({...common,server:item.id})}`);
  const own=body.byServer?.[item.id]?.sources||[], top=body.sources||[];
  const urls=own.map(s=>s.url).filter(Boolean);const canonical=urls.map(hash).sort();
  const all=Object.entries(body.byServer||{}).map(([key,v])=>({id:key,hashes:(v.sources||[]).map(s=>s.url).filter(Boolean).map(hash).sort()}));
  const matching=all.filter(x=>JSON.stringify(x.hashes)===JSON.stringify(canonical)).map(x=>x.id);
  results.push({id:item.id,ms:Date.now()-started,own:own.length,top:top.length,hashes:canonical,matching,claimedLanguages:[...new Set(own.flatMap(s=>s.audioLanguages||[s.language]).filter(Boolean))]});
 }catch(e){results.push({id:item.id,ms:Date.now()-started,error:e.message})}}}));
results.sort((a,b)=>a.id.localeCompare(b.id));
for(let i=0;i<results.length;i+=8) notice({type,id,part:i/8+1,results:results.slice(i,i+8).map(r=>({id:r.id,ms:r.ms,own:r.own,top:r.top,hashes:r.hashes,matchingCount:r.matching?.length,claimedLanguages:r.claimedLanguages,error:r.error}))});
notice({type,id,completed:results.length,withSources:results.filter(r=>r.own>0).length,failures:results.filter(r=>r.error).length,note:'Exact relay URL hashes only; tokens may rotate across requests. Matching counts are within one response.'});
