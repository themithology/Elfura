// Isolated research. No provider code, media URLs, tokens or bodies are logged.
const api='https://api.hicine.sbs';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function json(url){
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{'User-Agent':ua,Accept:'application/json, */*'}});
 if(!r.ok){await r.body?.cancel();return {status:r.status};}
 const length=Number(r.headers.get('content-length')||0);if(length>1_500_000){await r.body?.cancel();throw Error('oversize');}
 const reader=r.body?.getReader();let n=0,parts=[];if(reader)try{for(;;){const next=await reader.read();if(next.done)break;n+=next.value.length;if(n>1_500_000)throw Error('oversize');parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
 return {status:r.status,data:JSON.parse(Buffer.concat(parts).toString('utf8'))};
}
const collections={bolly_movies:'bollywood_movies',bolly_series:'bollywood_series',movies:'hollywood_movies',series:'hollywood_series',anime:'anime'};
for(const query of ['Naruto','Jujutsu Kaisen','Reacher','Dune']){
 const report={query};
 try{
  const search=await json(`${api}/api/search/${encodeURIComponent(query)}`);report.status=search.status;
  const list=Array.isArray(search.data)?search.data:Array.isArray(search.data?.data)?search.data.data:[];
  report.hits=list.slice(0,12).map(x=>({title:String(x.title??'').replace(/<[^>]*>/g,'').slice(0,90),type:String(x.contentType??'').slice(0,30)}));
  const wanted=list.find(x=>{
   const t=String(x.title??'').toLowerCase();
   if(query==='Dune')return /^dune:\s*part two\s*\(2024\)/i.test(t);
   return t.includes(query.toLowerCase()) && ['series','anime','bolly_series'].includes(x.contentType);
  });
  if(wanted && /^\d{1,12}$/.test(String(wanted.record_id)) && collections[wanted.contentType]){
   const detail=await json(`${api}/api/${collections[wanted.contentType]}/${wanted.record_id}`);report.detailStatus=detail.status;
   const d=detail.data??{};report.detailKeys=Object.keys(d).filter(k=>/^(title|links|season_\d+)$/.test(k));
   report.detailTitle=String(d.title??'').replace(/<[^>]*>/g,'').slice(0,100);
   const seasons=Object.entries(d).filter(([k,v])=>/^season_\d+$/.test(k)&&typeof v==='string');
   report.seasons=seasons.map(([k,v])=>({season:k,episodes:[...v.matchAll(/episode\s*(\d+)/gi)].map(m=>Number(m[1])).slice(0,8),urls:(v.match(/https?:\/\//gi)||[]).length,hindi:/hindi/i.test(v)})).slice(0,3);
   report.movieLinks=typeof d.links==='string'?(d.links.match(/https?:\/\//gi)||[]).length:0;
   const text=[typeof d.links==='string'?d.links:'',...seasons.map(x=>x[1])].join('\n');
   const hosts=new Set();for(const match of text.matchAll(/https?:\/\/[^\s,<>"']+/gi)){try{hosts.add(new URL(match[0]).hostname)}catch{}}
   report.workerHosts=[...hosts].slice(0,8);
  }
 }catch(e){report.error=e?.cause?.code??e.name;}
 console.log('::notice title=HiCine discovery details::'+JSON.stringify(report));
}
