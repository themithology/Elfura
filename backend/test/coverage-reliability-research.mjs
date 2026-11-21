// Diagnostic only: independently check existing production groups across titles.
// No raw URLs, headers or token values are logged. Liveness is not playback proof.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
import {createHash} from 'node:crypto';
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-matrix-secret',OPENSUBTITLES_ENABLED:'0'});
const {registry}=createBackendServer({...cfg,isProd:false,requireToken:false});
const ids=['source-1','source-3','source-4','source-5','source-8','source-9','source-10','source-11','source-12','source-13','source-14','source-15','source-20','source-21','source-24','source-25'];
const adapters=registry.adapters.filter(a=>ids.includes(a.id)&&a.enabled());
const samples=[
 {label:'Fight Club',type:'movie',tmdbId:'550',imdbId:'tt0137523',title:'Fight Club',year:'1999'},
 {label:'Dune Part Two',type:'movie',tmdbId:'693134',imdbId:'tt15239678',title:'Dune: Part Two',year:'2024'},
 {label:'Parasite',type:'movie',tmdbId:'496243',imdbId:'tt6751668',title:'Parasite',year:'2019'},
 {label:'Casablanca',type:'movie',tmdbId:'289',imdbId:'tt0034583',title:'Casablanca',year:'1943'},
 {label:'Game of Thrones E1',type:'tv',tmdbId:'1399',imdbId:'tt0944947',title:'Game of Thrones',year:'2011',season:1,episode:1},
 {label:'Game of Thrones E2',type:'tv',tmdbId:'1399',imdbId:'tt0944947',title:'Game of Thrones',year:'2011',season:1,episode:2},
 {label:'Breaking Bad E1',type:'tv',tmdbId:'1396',imdbId:'tt0903747',title:'Breaking Bad',year:'2008',season:1,episode:1},
 {label:'Breaking Bad E2',type:'tv',tmdbId:'1396',imdbId:'tt0903747',title:'Breaking Bad',year:'2008',season:1,episode:2},
 {label:'Naruto E1',type:'tv',tmdbId:'46260',title:'Naruto',year:'2002',season:1,episode:1,originalLanguage:'ja'},
 {label:'Naruto E2',type:'tv',tmdbId:'46260',title:'Naruto',year:'2002',season:1,episode:2,originalLanguage:'ja'},
];
const summary={};
for(const sample of samples){
 const rows=[];
 for(let i=0;i<adapters.length;i+=8){
  const result=await Promise.all(adapters.slice(i,i+8).map(async adapter=>{
   const start=Date.now(),row={id:adapter.id};
   try{
    const query={...sample,signal:AbortSignal.timeout(14000),resolveMetaFallback:async()=>({rawTitle:sample.title,title:sample.title,year:sample.year,imdbId:sample.imdbId??null,originalLanguage:sample.originalLanguage??'en'})};
    const raw=await adapter.resolve(query);row.raw=raw.candidates.length;
    const checked=await verifyAndFilterCandidatesDetailed(raw.candidates.slice(0,4),AbortSignal.timeout(5000));
    row.probedAlive=checked.verifiedAliveCount;row.probedDead=checked.probedDead.size;
    row.fingerprints=raw.candidates.filter(c=>checked.probedAlive.has(c.url)).slice(0,3).map(c=>createHash('sha256').update(c.url).digest('hex').slice(0,10));
   }catch(e){row.error=e.name;}
   row.ms=Date.now()-start;return row;
  }));rows.push(...result);
 }
 for(const r of rows){const s=summary[r.id]??={raw:0,alive:0,samples:0};s.samples++;if(r.raw>0)s.raw++;if(r.probedAlive>0)s.alive++;}
 console.log('::notice title=Coverage matrix::'+JSON.stringify({sample:sample.label,rows}));
}
console.log('::notice title=Coverage matrix summary::'+JSON.stringify(summary));
