// Research only. Redacted statuses/fingerprints, no URLs, tokens or response bodies.
// Liveness is not evidence of content identity or browser playback.
import {createHash} from 'node:crypto';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
const headers={Origin:'https://atlantic.bz',Referer:'https://atlantic.bz/',Accept:'application/json','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'};
const samples=[
 {name:'Fight Club',type:'movie',id:'550'}, {name:'Dune Part Two',type:'movie',id:'693134'}, {name:'Casablanca',type:'movie',id:'289'}, {name:'Parasite',type:'movie',id:'496243'},
 {name:'Game of Thrones E1',type:'tv',id:'1399',s:1,e:1}, {name:'Game of Thrones E2',type:'tv',id:'1399',s:1,e:2}, {name:'Breaking Bad E1',type:'tv',id:'1396',s:1,e:1},{name:'Breaking Bad E2',type:'tv',id:'1396',s:1,e:2},
 {name:'Naruto E1',type:'tv',id:'46260',s:1,e:1},{name:'Naruto E2',type:'tv',id:'46260',s:1,e:2},
 {name:'Nonexistent movie',type:'movie',id:'999999999999'}, {name:'Nonexistent episode',type:'tv',id:'1396',s:999,e:999}];
const rows=[];
for(const sample of samples){
 const q=new URLSearchParams({tmdbId:sample.id,type:sample.type,...(sample.type==='tv'?{seasonId:String(sample.s),episodeId:String(sample.e)}:{})});
 const providers=await Promise.all(['vidbox','q62'].map(async lane=>{
  const row={lane};try{
   const res=await fetch(`https://stream.hls.lol/${lane}?${q}`,{headers,redirect:'error',signal:AbortSignal.timeout(12000)});row.status=res.status;
   const raw=await readBoundedText(res,256000);let payload;try{payload=JSON.parse(raw??'null')}catch{}
   const url=lane==='vidbox'?(payload?.sources?.Vidbox?.type==='hls'?payload.sources.Vidbox.url:null):payload?.releases?.[0]?.master;
   if(res.ok&&typeof url==='string'&&isSafeUpstreamUrl(url)&&new URL(url).protocol==='https:'){
    row.candidates=1;
    const parsed=new URL(url),nested=[];
    for(const value of parsed.searchParams.values()){for(const str of [value, (()=>{try{return Buffer.from(value,'base64url').toString('utf8')}catch{return ''}})()]){try{const n=new URL(str);if(['http:','https:'].includes(n.protocol))nested.push(n.hostname)}catch{}}}
    row.shape={hostLooksRelay:/proxy|relay|transcode|worker/i.test(parsed.hostname),pathLooksRelay:/proxy|relay|transcode/i.test(parsed.pathname),nestedHostHashes:[...new Set(nested)].map(x=>createHash('sha256').update(x).digest('hex').slice(0,10))};
    row.hostFingerprint=createHash('sha256').update(new URL(url).hostname).digest('hex').slice(0,10);
    const c={key:url,url,type:'hls',quality:'auto',headers};const v=await verifyAndFilterCandidatesDetailed([c],AbortSignal.timeout(6000));row.alive=v.verifiedAliveCount;row.fingerprint=createHash('sha256').update(url).digest('hex').slice(0,10);
   }else row.candidates=0;
  }catch(e){row.error=e?.cause?.code??e.name;}return row;
 }));
 rows.push({sample:sample.name,providers});
}
console.log('::notice title=Atlantic API research::'+JSON.stringify(rows));
