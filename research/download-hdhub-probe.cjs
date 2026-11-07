// Isolated upstream research only: never used by the application.
const originalLog=console.log;console.log=()=>{};console.error=()=>{};console.warn=()=>{};
process.env.DISABLE_CACHE='true';
const {getHDHub4uStreams}=require('/tmp/nuvio-research/providers/hdhub4u.js');
const title=process.env.TITLE||'Godzilla Minus One',year=process.env.YEAR||'2023';
const start=Date.now();
(async()=>{try{const list=await Promise.race([getHDHub4uStreams('940721','movie',title,year),new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),45000))]);const results=(list||[]).slice(0,8).map(s=>({name:s.name,title:s.title,quality:s.quality,urlType:s.url?new URL(s.url).hostname:null}));originalLog('::notice title=NuvioDownloadResearch::'+JSON.stringify({title,ms:Date.now()-start,count:list?.length||0,results}));}catch(e){originalLog('::notice title=NuvioDownloadResearch::'+JSON.stringify({title,ms:Date.now()-start,error:e.message}));}process.exit();})();
