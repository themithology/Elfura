// Independent, redacted availability survey; no CinePro code is included.
// HTTP success and advertised labels are not proof of browser playback or identity.
const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const samples = [
  {name:'Naruto S1E1', type:'tv', id:'46260', season:1, episode:1},
  {name:'Naruto S1E2', type:'tv', id:'46260', season:1, episode:2},
  {name:'Fight Club', type:'movie', id:'550'},
];
const peach = [
  ['peach-multi','https://usa.eat-peach.sbs/multi'],
  ['peach-holly','https://usa.eat-peach.sbs/holly'],
  ['peach-air','https://usa.eat-peach.sbs/air'],
  ['peach-net','https://uwu.eat-peach.sbs/net'],
  ['peach-bmb','https://uwu.eat-peach.sbs/bmb'],
  ['peach-moviebox','https://uwu.eat-peach.sbs/moviebox'],
];
function endpoint(sample, base){return `${base}/${sample.type}/${sample.id}${sample.type==='tv'?`/${sample.season}/${sample.episode}`:''}`;}
const jobs=[];
for(const s of samples){
  for(const [name,base] of peach) jobs.push({name,s,url:endpoint(s,base),referer:'https://peachify.top/',origin:'https://peachify.top'});
  for(const server of ['default','hexa','Gama','Liligoon','Sigma','Prime','Alfa','Lamda','ynx_vidsrc']) {
    const url=new URL('https://popr.ink/api/vidnest');
    for(const [k,v] of Object.entries({id:s.id,type:s.type,server,...(s.type==='tv'?{season:s.season,episode:s.episode}:{})}))url.searchParams.set(k,String(v));
    jobs.push({name:'popr-'+server,s,url:url.href,referer:'https://popr.ink/'});
  }
  for(const server of ['onion','allmovies','uniquestream','vidfast-alpha'])jobs.push({name:'tulnex-'+server,s,url:endpoint(s,`https://api.tulnex.com/${server}`)});
}
async function inspect(job){
 const row={provider:job.name,sample:job.s.name};
 try {
  const response=await fetch(job.url,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{'User-Agent':ua,Accept:'application/json, */*',...(job.referer?{Referer:job.referer}:{}),...(job.origin?{Origin:job.origin}:{})}});
  row.status=response.status;
  const length=Number(response.headers.get('content-length')||0);
  if(length>1000000){await response.body?.cancel();row.error='oversize';return row;}
  const reader=response.body?.getReader();let size=0,chunks=[];
  if(reader){try{for(;;){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>1000000){row.error='oversize';return row;}chunks.push(n.value);}}finally{await reader.cancel().catch(()=>{});}}
  const text=Buffer.concat(chunks).toString('utf8');let data;
  try{data=JSON.parse(text);}catch{row.bodyType=/^\s*</.test(text)?'html':'other';return row;}
  row.bodyType='json';row.keys=Object.keys(data??{}).slice(0,12);
  row.encrypted=Boolean(data?.isEncrypted || data?.payload);
  const sources=Array.isArray(data?.sources)?data.sources:Array.isArray(data?.results)?data.results.flatMap(r=>Array.isArray(r?.streams)?r.streams:[]):[];
  row.count=sources.length;
  const labels=new Set();for(const item of sources){if(!item||typeof item!=='object')continue;for(const k of ['language','lang','dub','audio','audioLang','audioName','quality']){const v=item[k];if(typeof v==='string'&&/^[a-z0-9 _.-]{1,35}$/i.test(v))labels.add(`${k}:${v}`);}}
  row.labels=[...labels].slice(0,20);
 }catch(e){row.error=e?.name??'error';}
 return row;
}
const rows=[];for(let i=0;i<jobs.length;i+=10)rows.push(...await Promise.all(jobs.slice(i,i+10).map(inspect)));
console.log('::notice title=Redacted Cinepro candidate survey::'+JSON.stringify(rows));
