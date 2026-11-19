import {fetchFromBingr} from '../../dist/backend/sources/source4.js';
import {verifyAndFilterCandidatesDetailed,cachedCandidateEvidence} from '../../dist/backend/sources/liveness.js';
for (const [type,tmdbId] of [['movie','872585'],['movie','693134'],['tv','93405']]) {
 const start=Date.now();const candidates=await fetchFromBingr({type,tmdbId,season:1,episode:1,diag:[],signal:AbortSignal.timeout(14000)});
 const {candidates:verified,verifiedAliveCount}=await verifyAndFilterCandidatesDetailed(candidates,AbortSignal.timeout(11000));
 const details=verified.map(c=>({lang:c.audioLang||null,alive:!!cachedCandidateEvidence(c)?.alive,languages:cachedCandidateEvidence(c)?.discoveredAudioLangs||[]}));
 console.log('::notice title=BingrAdapter::'+JSON.stringify({type,tmdbId,ms:Date.now()-start,raw:candidates.length,verifiedAliveCount,details:details.slice(0,25)}));
}
