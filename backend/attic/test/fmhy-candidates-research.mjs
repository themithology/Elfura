// FMHY discovery research only. No raw media links, cookies, keys or bodies logged.
// A reachable manifest is NOT proof of playback, identity or long-term reliability.
import {randomBytes,createHash} from 'node:crypto';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {fetch as browserFetch} from 'wreq-js';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const headers={'User-Agent':ua,Accept:'application/json, */*',Origin:'https://beta.cinecat.eu',Referer:'https://beta.cinecat.eu/'};
async function json(url,options={}){
 const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(12000),headers:{...headers,...options.headers}});
 const text=await readBoundedText(r,1_000_000);let data=null;try{data=JSON.parse(text)}catch{}
 return {status:r.status,data,cf:/just a moment|cf-chl|anubis|checking your browser/i.test((text??'').slice(0,10000))};
}
const cases=[
 {name:'Fight Club',type:'movie',id:'550',title:'Fight Club',year:'1999',imdb:'tt0137523'},
 {name:'Dune Part Two',type:'movie',id:'693134',title:'Dune: Part Two',year:'2024',imdb:'tt15239678'},
 {name:'Casablanca',type:'movie',id:'289',title:'Casablanca',year:'1943',imdb:'tt0034583'},
 {name:'Parasite',type:'movie',id:'496243',title:'Parasite',year:'2019',imdb:'tt6751668'},
 {name:'Game of Thrones E1',type:'tv',id:'1399',title:'Game of Thrones',year:'2011',season:1,episode:1},
 {name:'Game of Thrones E2',type:'tv',id:'1399',title:'Game of Thrones',year:'2011',season:1,episode:2},
 {name:'Breaking Bad E1',type:'tv',id:'1396',title:'Breaking Bad',year:'2008',season:1,episode:1},
 {name:'Breaking Bad E2',type:'tv',id:'1396',title:'Breaking Bad',year:'2008',season:1,episode:2},
 {name:'Naruto E1',type:'tv',id:'46260',title:'Naruto',year:'2002',season:1,episode:1},
 {name:'Naruto E2',type:'tv',id:'46260',title:'Naruto',year:'2002',season:1,episode:2},
];
let laneNames=[];
try{const r=await json('https://edge.cinecat.eu/sources');laneNames=(r.data?.sources??[]).map(s=>s.name).filter(x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(x)).slice(0,8);console.log('::notice title=Cinecat discovery::'+JSON.stringify({status:r.status,lanes:laneNames}));}catch(e){console.log('::notice title=Cinecat discovery::'+JSON.stringify({error:e?.cause?.code??e.name}));}
const results=[];
for(const c of cases){
 const qs=new URLSearchParams({tmdb:c.id,type:c.type,...(c.type==='tv'?{season:String(c.season),episode:String(c.episode)}:{})});
 const path=c.type==='tv'?`tv/${c.id}/${c.season}/${c.episode}`:`movie/${c.id}`;
 const tasks=[['zcdn',`https://zcdn1.c3204a347-edge.workers.dev/cdn?${qs}`],['aphrodite',`https://cdn.hls.lol/content/${path}`],...laneNames.map(lane=>[lane,`https://edge.cinecat.eu/sources/${encodeURIComponent(lane)}?${qs}`])];
 const rows=await Promise.all(tasks.map(async ([lane,url])=>{
  const row={lane};try{
   const r=await json(url);row.status=r.status;let urls=[];
   if(lane==='zcdn'&&r.data?.ready&&typeof r.data.url==='string'){const u=new URL(r.data.url);if(typeof r.data.rb==='string'&&r.data.rb)u.searchParams.set('_rb',r.data.rb);urls=[u.href];}
   else if(lane==='aphrodite'&&r.data?.found&&r.data?.type==='hls'&&typeof r.data.url==='string')urls=[r.data.url];
   else if(Array.isArray(r.data?.streams))urls=r.data.streams.filter(x=>(!x.kind||x.kind==='hls')&&typeof x.url==='string').map(x=>{try{return new URL(x.url,'https://edge.cinecat.eu').href}catch{return ''}});
   const safe=urls.filter(u=>isSafeUpstreamUrl(u)).slice(0,2);row.streams=urls.length;
   const candidates=safe.map(u=>({key:u,url:u,type:'hls',quality:'auto',headers:{'User-Agent':ua,Origin:'https://beta.cinecat.eu',Referer:'https://beta.cinecat.eu/'}}));
   if(candidates.length){const v=await verifyAndFilterCandidatesDetailed(candidates,AbortSignal.timeout(5000));row.alive=v.verifiedAliveCount;row.dead=v.probedDead.size;row.fingerprints=candidates.filter(x=>v.probedAlive.has(x.url)).map(x=>createHash('sha256').update(x.url).digest('hex').slice(0,10));}
  }catch(e){row.error=e?.cause?.code??e.name;}return row;
 }));
 results.push({name:c.name,rows});console.log('sample '+JSON.stringify({name:c.name,rows}));
}
console.log('::notice title=FMHY Cinecat coverage::'+JSON.stringify(results));
const fly=[];
for(const c of [cases[0],cases[4],cases[5]]){
 const q=new URLSearchParams({type:c.type,viewerId:randomBytes(16).toString('hex'),title:c.title,tmdbId:c.id,year:c.year,...(c.imdb?{imdb:c.imdb}:{}),...(c.type==='tv'?{season:String(c.season),episode:String(c.episode)}:{})});
 const url=`https://flystream.net/api/streams?${q}`,row={name:c.name};
 try{const r=await json(url,{headers:{Origin:'https://flystream.net',Referer:'https://flystream.net/'}});row.status=r.status;row.challenge=r.cf;row.streams=Array.isArray(r.data?.streams)?r.data.streams.length:0;
 if(r.status===403){try{const w=await browserFetch(url,{browser:'chrome_149',os:'windows',redirect:'manual',signal:AbortSignal.timeout(12000),timeout:11000,headers:{'User-Agent':ua,Referer:'https://flystream.net/',Accept:'application/json'}});row.browserTlsStatus=w.status;await w.body?.cancel();}catch(e){row.browserTlsError=e?.cause?.code??e.name;}}
 }catch(e){row.error=e?.cause?.code??e.name;}fly.push(row);
}
console.log('::notice title=FMHY FlyStream access::'+JSON.stringify(fly));
