// Category gap audit using Elfura's direct upstream adapters; no media URLs are logged.
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createSource1Adapter} from '../../dist/backend/sources/source1.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
const cfg=loadBackendConfig();
const cases=[{id:'579974',type:'movie'},{id:'872585',type:'movie'},{id:'619803',type:'movie'},{id:'360814',type:'movie'},{id:'85937',type:'tv'},{id:'1429',type:'tv'},{id:'46260',type:'tv'}];
async function check(c,group){try{const signal=AbortSignal.timeout(12000);const raw=await createSource1Adapter(cfg.source1,group).resolve({tmdbId:c.id,type:c.type,season:1,episode:1,signal});const v=await verifyAndFilterCandidatesDetailed(raw.candidates,signal);return {id:c.id,group,total:raw.candidates.length,verified:v.verifiedAliveCount,results:v.candidates.map(x=>({host:new URL(x.url).hostname,type:x.type,multi:!!x.multiAudio,langs:x.availableAudioLangs||[],qualities:x.qualityLadder||[]})).slice(0,10)};}catch(e){return {id:c.id,group,error:e.name};}}
for(let i=0;i<cases.length;i+=2){const out=await Promise.all(cases.slice(i,i+2).flatMap(c=>[1,2].map(g=>check(c,g))));console.log(`::notice title=IndiaGaps::${JSON.stringify(out).replace(/%/g,'%25')}`);}
