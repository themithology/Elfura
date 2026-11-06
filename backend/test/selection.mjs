import assert from 'node:assert/strict';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {selectPlaybackCandidates} from '../../dist/backend/sources/selection.js';
const old=globalThis.fetch;const adapter=(id)=>({id,label:id,enabled:()=>true});
const one=adapter('source-1'),two=adapter('source-2'),three=adapter('source-3');
const cand=(host,name,extra={})=>({key:name,url:`https://${host}/${name}.m3u8`,type:'hls',quality:'auto',rank:0,...extra});
const entries=[
 {adapter:one,candidate:cand('a.example','single-a')},
 {adapter:one,candidate:cand('a.example','single-a-copy')},
 {adapter:two,candidate:cand('b.example','single-b',{multiAudio:true,availableAudioLangs:['hi','en']})},
 {adapter:two,candidate:cand('c.example','multi',{multiAudio:true,availableAudioLangs:['hi','en','fr']})},
 {adapter:three,candidate:cand('d.example','other-multi')},
];
globalThis.fetch=async input=>{const u=new URL(String(input));if(u.pathname.endsWith('/child.m3u8'))return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');
 const language=u.pathname.includes('other-multi')?['it','en']:u.pathname.includes('/multi')?['hi','en']:u.pathname.includes('single-b')?['en']:[];
 const tracks=language.map(l=>`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="${l}",NAME="${l}",URI="/child.m3u8"`).join('\n');return new Response(`#EXTM3U\n${tracks}\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="x"\n/child.m3u8`);};
try {
 const results=await verifyAndFilterCandidatesDetailed(entries.map(x=>x.candidate));assert.equal(results.verifiedAliveCount,5);
 const selected=selectPlaybackCandidates(entries);const multi=selected.filter(x=>x.candidate.multiAudio),single=selected.filter(x=>!x.candidate.multiAudio);
 assert.equal(multi.length,2);assert.equal(single.length,2);assert.deepEqual(multi[0].candidate.availableAudioLangs,['hi','en'],'unverified metadata must not create a fake third language');
 assert(!multi.some(x=>x.candidate.key==='single-b'),'single-track source must not be called multi-audio');
 assert.equal(new Set(single.map(x=>new URL(x.candidate.url).hostname)).size,2,'fallbacks should use different hosts');
 const unknown=selectPlaybackCandidates([{adapter:one,candidate:cand('e.example','unverified',{multiAudio:true,availableAudioLangs:['hi','en']})}]);assert.equal(unknown.length,1);assert.equal(unknown[0].candidate.multiAudio,false);assert.equal(unknown[0].candidate.availableAudioLangs,undefined);
 const reg=new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'selection-test',OPENSUBTITLES_ENABLED:'0'}));reg.adapters=[one,two,three].map(a=>({...a,resolve:async()=>({candidates:entries.filter(x=>x.adapter===a).map(x=>x.candidate)})}));const playback=await reg.resolvePlayback({type:'movie',tmdbId:'424242'});assert.equal(playback.sources.filter(x=>!x.multiAudio).length,2);assert.equal(playback.sources.filter(x=>x.multiAudio).length,2);
 console.log('✓ Genuine multi-audio evidence, capped diverse fallback selection and unverified claims.');
}finally{globalThis.fetch=old}
