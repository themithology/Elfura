// Access and manifest research: statuses and fingerprints only. Never log upstream URLs or tokens.
import {createHash} from 'node:crypto';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
import {classifyUpstreamUrl} from '../../dist/backend/sources/provenance.js';
const headers={Origin:'https://cineruv.website',Referer:'https://cineruv.website/',Accept:'application/json','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'};
const samples=[
 {name:'Fight Club',type:'movie',id:'550',title:'Fight Club',year:1999}, {name:'Dune Part Two',type:'movie',id:'693134',title:'Dune: Part Two',year:2024}, {name:'Casablanca',type:'movie',id:'289',title:'Casablanca',year:1943},{name:'Parasite',type:'movie',id:'496243',title:'Parasite',year:2019},
 {name:'Game of Thrones E1',type:'tv',id:'1399',title:'Game of Thrones',year:2011,season:1,episode:1}, {name:'Game of Thrones E2',type:'tv',id:'1399',title:'Game of Thrones',year:2011,season:1,episode:2},
 {name:'Breaking Bad E1',type:'tv',id:'1396',title:'Breaking Bad',year:2008,season:1,episode:1},{name:'Breaking Bad E2',type:'tv',id:'1396',title:'Breaking Bad',year:2008,season:1,episode:2}, {name:'Breaking Bad S5E16',type:'tv',id:'1396',title:'Breaking Bad',year:2008,season:5,episode:16},
 {name:'Naruto E1',type:'tv',id:'46260',title:'Naruto',year:2002,season:1,episode:1},{name:'Naruto E2',type:'tv',id:'46260',title:'Naruto',year:2002,season:1,episode:2},
 {name:'Nonexistent movie',type:'movie',id:'999999999999',title:'Nonexistent movie',year:1874},{name:'Nonexistent episode',type:'tv',id:'1396',title:'Breaking Bad',year:2008,season:999,episode:999}];
const rows=[];
for(const s of samples){const row={sample:s.name};try{
 const params=new URLSearchParams({tmdbId:s.id,type:s.type,title:s.title,year:String(s.year),language:'en',...(s.type==='tv'?{season:String(s.season),episode:String(s.episode)}:{})});
 const r=await fetch(`https://api.movenerds.space/api/stream?${params}`,{headers,redirect:'error',signal:AbortSignal.timeout(18000)});row.status=r.status;
 const text=await readBoundedText(r,500000);let p;try{p=JSON.parse(text??'null')}catch{}
 row.success=p?.success===true;row.identity=typeof p?.title==='string'&&p.title.toLowerCase()===s.title.toLowerCase()&&(s.type==='movie'?p.year===s.year:p.season===s.season&&p.episode===s.episode);
 const list=[...(Array.isArray(p?.primarySources)?p.primarySources:[]),...Object.values(p?.allProviders??{}).flat()].filter(x=>x?.type==='hls'&&typeof x.url==='string').slice(0,12);
 const urls=[...new Set(list.map(x=>{try{return new URL(x.url,'https://api.movenerds.space').href}catch{return ''}}))].filter(x=>isSafeUpstreamUrl(x)&&new URL(x).protocol==='https:');row.candidates=urls.length;
 const cs=urls.slice(0,3).map(url=>({key:url,url,type:'hls',quality:'auto',headers}));
 if(cs.length){const checked=await verifyAndFilterCandidatesDetailed(cs,AbortSignal.timeout(7000));row.alive=checked.verifiedAliveCount;row.hosts=cs.map(c=>({hash:createHash('sha256').update(new URL(c.url).hostname).digest('hex').slice(0,10),class:classifyUpstreamUrl(c.url)}));}
 }catch(e){row.error=e?.cause?.code??e.name;}rows.push(row);}
console.log('::notice title=Cineruv API research::'+JSON.stringify(rows));
