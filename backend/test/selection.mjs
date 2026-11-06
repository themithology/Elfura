import assert from 'node:assert/strict';
import {verifyAndFilterCandidatesDetailed, diagnoseMultiAudioCandidate} from '../../dist/backend/sources/liveness.js';
import {createSource1Adapter} from '../../dist/backend/sources/source1.js';
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
 const preferred=selectPlaybackCandidates(entries.map(x=>x.candidate.key==='single-b'?{...x,candidate:{...x.candidate,audioLang:'hi'}}:x),'hi');assert(preferred.some(x=>x.candidate.key==='single-b'),'prefer a verified requested-language fallback');
 const unknown=selectPlaybackCandidates([{adapter:one,candidate:cand('e.example','unverified',{multiAudio:true,availableAudioLangs:['hi','en']})}]);assert.equal(unknown.length,1);assert.equal(unknown[0].candidate.multiAudio,false);assert.equal(unknown[0].candidate.availableAudioLangs,undefined);
 const reg=new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'selection-test',OPENSUBTITLES_ENABLED:'0'}));reg.adapters=[one,two,three].map(a=>({...a,resolve:async()=>({candidates:entries.filter(x=>x.adapter===a).map(x=>x.candidate)})}));entries[0].candidate.subtitles=[{lang:'en',label:'provider',url:'https://secret.example/provider.vtt'}];const playback=await reg.resolvePlayback({type:'movie',tmdbId:'424242'});assert.equal(playback.sources.filter(x=>!x.multiAudio).length,2);assert.equal(playback.sources.filter(x=>x.multiAudio).length,2);assert(playback.sources.every(x=>x.subtitles.length===0),'provider subtitles must never leak when OpenSubtitles is disabled');
 const cfg=loadBackendConfig({ELFURA_SECRET:'test'});cfg.source1.riftOrigin='https://rift.example';cfg.source1.vidrockOrigin='';cfg.source1.vidboltOrigin='https://bolt.example';
 let subtitleRequests=0;globalThis.fetch=async input=>{const u=new URL(String(input));if(u.pathname.endsWith('subtitles.json'))subtitleRequests++;if(u.hostname==='rift.example')return Response.json({meta:{playbackToken:'test-token',orionStreams:[{url:'/api/orion/a/master.m3u8',name:'Orion · Hindi'},{url:'/api/orion/b/master.m3u8',name:'Orion · English'},{url:'/api/orion/c/master.m3u8',name:'Orion · Original'}]}});return new Response('',{status:404})};
 const rift=await createSource1Adapter(cfg.source1,2).resolve({type:'tv',tmdbId:'123',season:1,episode:1,diag:[]});assert.deepEqual(rift.candidates.map(c=>c.audioLang),['hi','en',undefined]);assert(rift.candidates.every(c=>!c.multiAudio && !c.subtitles));assert.equal(subtitleRequests,0);
 globalThis.fetch=async input=>{const u=new URL(String(input));if(u.pathname.endsWith('/child.m3u8'))return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="hi",URI="/child.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="en",URI="/child.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/child.m3u8');};
 const deep=await diagnoseMultiAudioCandidate(cand('secret.example','multi',{multiAudio:true}));
 assert.equal(deep.status,'manifest-and-playlists-reachable');assert.deepEqual(deep.manifestLanguages,['hi','en']);assert.deepEqual(new Set(deep.steps.map(s=>s.stage)),new Set(['master','video-playlist','audio-playlist']));assert(!JSON.stringify(deep).includes('secret.example'));
 globalThis.fetch=async input=>String(input).includes('/child.m3u8')?new Response('',{status:403}):new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="hi",URI="/child.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="en",URI="/child.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/child.m3u8');
 const failure=await diagnoseMultiAudioCandidate(cand('secret.example','multi'));assert.equal(failure.status,'incomplete');assert(failure.steps.some(s=>s.stage==='audio-playlist' && s.status==='http-error' && s.httpStatus===403));assert(!JSON.stringify(failure).includes('secret.example'));
 console.log('✓ Genuine multi-audio evidence, capped diverse fallback selection and unverified claims.');
}finally{globalThis.fetch=old}
