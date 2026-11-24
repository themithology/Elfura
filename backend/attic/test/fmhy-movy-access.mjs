// Access research only: never print seeds, encrypted payloads or media URLs.
// HTTP status or encrypted data is not evidence of a playable source.
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
const headers={Origin:'https://www.movy.sx',Referer:'https://www.movy.sx/',Accept:'application/json','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'};
const samples=[{name:'Fight Club',id:'550',type:'movie',title:'Fight Club',year:'1999',imdb:'tt0137523'},{name:'Game of Thrones E1',id:'1399',type:'tv',title:'Game of Thrones',year:'2011',imdb:'tt0944947',season:1,episode:1},{name:'Game of Thrones E2',id:'1399',type:'tv',title:'Game of Thrones',year:'2011',imdb:'tt0944947',season:1,episode:2}];
const results=[];
for(const s of samples){const row={name:s.name,servers:[]};
 try{
  const seedResponse=await fetch(`https://api.wecollege.net/seed?mediaId=${s.id}`,{headers,redirect:'error',signal:AbortSignal.timeout(6000)});
  row.seedStatus=seedResponse.status;const seedBody=await readBoundedText(seedResponse,50000);let seed;try{seed=JSON.parse(seedBody??'null')?.seed}catch{}
  row.hasSeed=typeof seed==='string'&&seed.length>0&&seed.length<1000;
  if(seedResponse.ok&&row.hasSeed){
   const query=new URLSearchParams({title:encodeURIComponent(s.title),mediaType:s.type,year:s.year,totalSeasons:s.type==='tv'?'8':'0',seasonId:String(s.season??1),episodeId:String(s.episode??1),tmdbId:s.id,imdbId:s.imdb,enc:'2',seed});
   row.servers=await Promise.all(['miami','boise','reno'].map(async name=>{try{const r=await fetch(`https://api.wecollege.net/${name}/sources?${query}`,{headers,redirect:'error',signal:AbortSignal.timeout(8000)});const text=await readBoundedText(r,500000);return {name,status:r.status,nonempty:!!text};}catch(e){return {name,error:e?.cause?.code??e.name}}}));
  }
 }catch(e){row.error=e?.cause?.code??e.name;}results.push(row);
}
console.log('::notice title=Movy access research::'+JSON.stringify(results));
