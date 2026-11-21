// Catalogue/manifest survey for Source 28. TVMaze is a comparison fixture,
// not a substitute for the real TMDB metadata or proof of actual language.
import {createSource28Adapter} from '../../dist/backend/sources/source28.js';
import {verifyAndFilterCandidatesDetailed,candidateEvidence} from '../../dist/backend/sources/liveness.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
const samples=[
 {id:'46260',title:'Naruto',year:'2002'},{id:'95479',title:'Jujutsu Kaisen',year:'2020'},
 {id:'1429',title:'Attack on Titan',year:'2013'},{id:'37854',title:'One Piece',year:'1999'},
 {id:'85937',title:'Demon Slayer: Kimetsu no Yaiba',year:'2019'},{id:'65930',title:'My Hero Academia',year:'2016'},
 {id:'13916',title:'Death Note',year:'2006'},{id:'31911',title:'Fullmetal Alchemist: Brotherhood',year:'2009'},
 {id:'120089',title:'SPY x FAMILY',year:'2022'},{id:'114410',title:'Chainsaw Man',year:'2022'},
 {id:'127532',title:'Solo Leveling',year:'2024'},{id:'12971',title:'Dragon Ball Z',year:'1989'},
 {id:'30984',title:'Bleach',year:'2004'}];
const normalize=s=>s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
async function get(url){const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(9000),headers:{Accept:'application/json'}});return {status:r.status,data:JSON.parse((await readBoundedText(r,250000))??'null')}}
const rows=[];
for(const s of samples){const row={title:s.title};try{
 const search=await get(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(s.title)}`);row.searchStatus=search.status;
 const hits=(Array.isArray(search.data)?search.data:[]).map(x=>x.show).filter(x=>x&&normalize(x.name??'')===normalize(s.title)&&String(x.premiered??'').startsWith(s.year));row.matches=hits.length;
 if(hits.length!==1){rows.push(row);continue;}
 const e=await get(`https://api.tvmaze.com/shows/${Number(hits[0].id)}/episodebynumber?season=1&number=1`);row.episodeStatus=e.status;
 const name=e.data?.name;if(e.status!==200||typeof name!=='string'||!name){rows.push(row);continue;}
 const diag=[];const result=await createSource28Adapter(()=>true).resolve({type:'tv',tmdbId:s.id,season:1,episode:1,diag,signal:AbortSignal.timeout(14000),resolveMetaFallback:async()=>({rawTitle:s.title,episodeName:name,originalLanguage:'ja',genres:['Animation']})});
 row.candidates=result.candidates.length;row.result=diag.map(d=>d.detail).slice(0,1);
 if(result.candidates.length){const checked=await verifyAndFilterCandidatesDetailed(result.candidates,AbortSignal.timeout(8000));const ev=candidateEvidence(checked.candidates[0]??result.candidates[0]);row.alive=checked.verifiedAliveCount;row.languages=ev?.discoveredAudioLangs??[];row.duration=ev?.durationSec??null;}
 }catch(e){row.error=e?.cause?.code??e.name;}rows.push(row);
}
console.log('::notice title=Anime multi-audio catalogue research::'+JSON.stringify(rows));
