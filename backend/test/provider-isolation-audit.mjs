// Independent live corroboration of each Source 1 and Source 2 lane.
// Runs outside the production host; no URLs, headers, credentials or tickets logged.
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createSource1Adapter} from '../../dist/backend/sources/source1.js';
import {verifyAndFilterCandidatesDetailed,cachedCandidateEvidence} from '../../dist/backend/sources/liveness.js';
const cfg=loadBackendConfig();
const samples=[['movie','533535'],['movie','872585'],['movie','693134'],['movie','157336'],['movie','299536'],['tv','95479'],['tv','93405'],['tv','289517'],['tv','1396'],['tv','1399']];
const disabled='http://127.0.0.1:9';
const providers={
  VidRift:()=>createSource1Adapter({...cfg.source1,vidboltOrigin:disabled,vidrockOrigin:''},2),
  VidBolt:()=>createSource1Adapter({...cfg.source1,riftOrigin:'',vidrockOrigin:''},2),
  VidRock:()=>createSource1Adapter({...cfg.source1,riftOrigin:'',vidboltOrigin:disabled},2),
};
for(const [type,id] of samples){
 const results=await Promise.all(Object.entries(providers).map(async([name,make])=>{
  const t=Date.now(),diag=[];
  try {const raw=(await make().resolve({type,tmdbId:id,season:1,episode:1,diag,signal:AbortSignal.timeout(12000)})).candidates;
   await verifyAndFilterCandidatesDetailed(raw);
   const evidence=raw.map(c=>cachedCandidateEvidence(c));
   return {name,ms:Date.now()-t,raw:raw.length,alive:evidence.filter(e=>e?.alive).length,dead:evidence.filter(e=>e?.confirmedDead).length,unknown:evidence.filter(e=>!e||(!e.alive&&!e.confirmedDead)).length,multi:evidence.filter(e=>e?.alive&&new Set(e.discoveredAudioLangs||[]).size>1).length,hindi:evidence.filter(e=>e?.alive&&e.discoveredAudioLangs?.includes('hi')&&new Set(e.discoveredAudioLangs).size>1).length,lanes:diag.map(d=>({lane:d.lane,ms:d.ms}))};
  }catch(e){return{name,error:e.name,ms:Date.now()-t};}
 }));
 console.log('::notice title=ProviderIsolation::'+JSON.stringify({type,id,results}));
}
