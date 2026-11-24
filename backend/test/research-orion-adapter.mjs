// Live test with public client values loaded ephemerally; do not print them.
import {fetchFromDirectOrion} from '../../dist/backend/sources/source1.js';
import {verifyAndFilterCandidatesDetailed,diagnoseCandidatePlayback} from '../../dist/backend/sources/liveness.js';
const r=await fetch('https://github.com/FmcStore/streamex-api/raw/refs/heads/main/players/p5_vidbolt.py',{signal:AbortSignal.timeout(12000)});
const text=await r.text();
const cfg={enabled:true,riftOrigin:'https://embed.vidrift.in',riftRelay:'',syncOrigin:'https://vidsync.pro',vidboltOrigin:'https://vidbolt.xyz',orionMovieKey:text.match(/key = "([a-f0-9]{40,})"/)?.[1]||'',orionTvKey:text.match(/"(streamrip_secret_[0-9]+)"/)?.[1]||''};
if(!cfg.orionMovieKey || !cfg.orionTvKey)throw new Error('No public protocol values found');
for(const q of [{type:'movie',tmdbId:'693134'},{type:'tv',tmdbId:'93405',season:1,episode:1},{type:'tv',tmdbId:'289517',season:1,episode:1}]){
 const c=await fetchFromDirectOrion(cfg,q);
 const verified=await verifyAndFilterCandidatesDetailed(c,AbortSignal.timeout(9000));
 let media='not-tested';
 if(c[0]){try{const d=await diagnoseCandidatePlayback(c[0]);media=JSON.stringify(d,(_,v)=>typeof v==='string'&&/^https?:/.test(v)?'[url]':v);}catch(e){media=e.name;}}
 console.log(`::notice title=Orion adapter::${JSON.stringify({type:q.type,id:q.tmdbId,candidates:c.length,alive:verified.verifiedAliveCount,dead:verified.probedDead.size,media}).replace(/%/g,'%25').replace(/\n/g,'%0A')}`);
}
