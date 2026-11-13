import assert from 'node:assert/strict';
import { fetchFromVAPlayer,createSource11Adapter } from '../../dist/backend/sources/source11.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
const old=globalThis.fetch;let episode='2';
globalThis.fetch=async(input,opts)=>{
 const u=new URL(String(input));
 if(u.hostname==='streamdata.vaplayer.ru') {
  assert.equal(opts.redirect,'error');assert.equal(u.searchParams.get('tmdb'),'1396');assert.equal(u.searchParams.get('type'),'tv');assert.equal(u.searchParams.get('season'),'1');assert.equal(u.searchParams.get('episode'),'2');
  return Response.json({status_code:'200',data:{season:'1',episode,stream_urls:['https://va-fixture.example/multi.m3u8','https://va-fixture.example/single.m3u8','https://va-fixture.example/multi.m3u8','http://127.0.0.1/evil.m3u8','https://vidara.example/stream.m3u8','https://va-fixture.example/embed']}});
 }
 if(u.hostname==='va-fixture.example'){
  if(u.pathname==='/child.m3u8') return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');
  const langs=u.pathname==='/multi.m3u8'?['en','hi']:['en'];
  return new Response('#EXTM3U\n'+langs.map(l=>`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="${l}",URI="/child.m3u8"`).join('\n')+'\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="x"\n/child.m3u8');
 }
 throw new Error('unexpected host');
};
try{
 const q={type:'tv',tmdbId:'1396',season:1,episode:2},raw=await fetchFromVAPlayer(q);
 assert.equal(raw.length,2);assert(!raw[0].audioLang);assert(!raw[0].multiAudio);
 const diag=[],res=await createSource11Adapter(()=>true).resolve({...q,diag});assert.equal(res.candidates.length,2);assert.deepEqual(res.candidates[0].availableAudioLangs,['en','hi']);assert.equal(res.candidates[0].multiAudio,true);assert.equal(res.candidates[1].multiAudio,false);assert.equal(res.candidates[1].audioLang,'en');assert.equal(res.candidates[0].diagnosticLane,'A');
 episode='3';assert.deepEqual(await fetchFromVAPlayer(q),[]);assert.deepEqual(await fetchFromVAPlayer({...q,tmdbId:'x'}),[]);assert.deepEqual(await fetchFromVAPlayer({...q,episode:0}),[]);
 assert(!new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test'})).listPublicSources().some(s=>s.id==='source-11'));
 assert(new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_VAPLAYER_ENABLED:'1'})).listPublicSources().some(s=>s.id==='source-11'));
 assert(!new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_VAPLAYER_ENABLED:'0'})).listPublicSources().some(s=>s.id==='source-11'));
 console.log('✓ VAPlayer bounded API, episode matching and manifest-only multi-audio');
}finally{globalThis.fetch=old}
