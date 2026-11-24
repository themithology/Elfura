// Research only: fixed, public titles; never log links, keys, or response bodies.
// Access and source labels are NOT evidence of playback, episode identity, or reliability.
import {fetch as browserFetch} from 'wreq-js';
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',Accept:'text/html,application/json,*/*','Accept-Language':'en-US,en;q=0.9'};
const targets=[
 ['MovieLinkBD search Naruto','https://movielinkbd.tv/search?q=Naruto'],
 ['MovieLinkBD search Jujutsu','https://movielinkbd.tv/search?q=Jujutsu%20Kaisen'],
 ['MovieLinkBD search Reacher','https://movielinkbd.tv/search?q=Reacher'],
 ['MovieLinkBD search Dune','https://movielinkbd.tv/search?q=Dune'],
 ['HiCine search Naruto','https://api.hicine.sbs/api/search/Naruto'],
 ['HiCine search Jujutsu','https://api.hicine.sbs/api/search/Jujutsu%20Kaisen'],
 ['HiCine search Reacher','https://api.hicine.sbs/api/search/Reacher'],
 ['HiCine search Dune','https://api.hicine.sbs/api/search/Dune'],
];
async function request(url,browser){
 const options={headers,signal:AbortSignal.timeout(12000),redirect:'manual'};
 const r=browser?await browserFetch(url,{...options,browser:'chrome_149',os:'windows',timeout:11000}):await fetch(url,options);
 let size=0,parts=[];const reader=r.body?.getReader();
 if(reader)try{while(true){const n=await reader.read();if(n.done)break;size+=n.value.length;if(size>1500000)throw Error('oversize');parts.push(n.value);}}finally{await reader.cancel().catch(()=>{});}
 return {status:r.status,text:Buffer.concat(parts).toString('utf8')};
}
async function sample([name,url]){
 const row={name};
 try{
  let r=await request(url,false);row.status=r.status;
  if(r.status===403||r.status===503){try{r=await request(url,true);row.browserTlsStatus=r.status;}catch(e){row.browserTlsError=e?.cause?.code??e.name;}}
  row.cloudflare=/just a moment|cf-chl|attention required/i.test(r.text.slice(0,10000));
  if(r.status!==200)return row;
  try{
   const json=JSON.parse(r.text);row.shape=Array.isArray(json)?'array':typeof json;row.keys=Array.isArray(json)?[]:Object.keys(json??{}).slice(0,15);
   const collections=Array.isArray(json)?[json]:Object.values(json??{}).filter(Array.isArray);
   row.arrayCounts=collections.map(x=>x.length).slice(0,10);
   const sample=collections.flat().find(x=>x&&typeof x==='object');
   if(sample){row.itemKeys=Object.keys(sample).slice(0,20);const title=sample.title??sample.name;if(typeof title==='string')row.firstTitle=title.replace(/<[^>]+>/g,'').slice(0,90);}
  }catch{
   row.shape='html';row.cards=(r.text.match(/class=["'][^"']*movie-card/gi)||[]).length;
   row.title=(r.text.match(/<title[^>]*>([^<]*)/i)?.[1]??'').slice(0,80);
  }
 }catch(e){row.error=e?.cause?.code??e.name;}
 return row;
}
const rows=await Promise.all(targets.map(sample));
for(const r of rows)console.log('::notice title=Candidate discovery::'+JSON.stringify(r));
