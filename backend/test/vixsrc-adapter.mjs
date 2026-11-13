import assert from 'node:assert/strict';
import { fetchFromVixSrc, createSource9Adapter } from '../../dist/backend/sources/source9.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
const old = globalThis.fetch;
let apiResult = {src:'/embed/221474?token=page-token'}, playlist = 'https://vix-fixture.example/master.m3u8?b=1', audioLanguages = ['it','en'];
globalThis.fetch = async (input, options) => {
  const u = new URL(String(input));
  if (u.hostname === 'vixsrc.to') {
    assert.equal(options.redirect,'error');
    if (u.pathname === '/api/movie/693134') return Response.json(apiResult);
    if (u.pathname === '/embed/221474') return new Response(`window.masterPlaylist={url: '${playlist}', 'token': 'secret+token', 'expires': '${Math.floor(Date.now()/1000)+3600}'};`);
  }
  if (u.hostname === 'vix-fixture.example') {
    if (u.pathname === '/child.m3u8') return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');
    assert.equal(u.searchParams.get('token'),'secret+token'); assert(['1','2'].includes(u.searchParams.get('b')));
    return new Response('#EXTM3U\n' + audioLanguages.map(lang=>`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="${lang}",URI="/child.m3u8"`).join('\n') + '\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="x"\n/child.m3u8');
  }
  throw new Error('unexpected host');
};
try {
  const q = {type:'movie',tmdbId:'693134'};
  const raw = await fetchFromVixSrc(q); assert.equal(raw.length,1); assert.equal(new URL(raw[0].url).searchParams.get('token'),'secret+token');
  const diag = []; const res = await createSource9Adapter(()=>true).resolve({...q,diag});
  assert.equal(res.candidates.length,1); assert.deepEqual(res.candidates[0].availableAudioLangs,['it','en']);
  assert.equal(res.candidates[0].diagnosticLane,'V');
  audioLanguages=['en'];playlist='https://vix-fixture.example/master-single.m3u8?b=2';
  const single=await createSource9Adapter(()=>true).resolve({...q,diag:[]});
  assert.equal(single.candidates.length,1);assert.equal(single.candidates[0].audioLang,'en');
  audioLanguages=['it','en'];playlist='https://vix-fixture.example/master.m3u8?b=1';
  apiResult={src:'//evil.example/embed/1'}; assert.deepEqual(await fetchFromVixSrc(q),[]);
  apiResult={src:'/embed/221474'}; playlist='http://127.0.0.1/master.m3u8'; assert.deepEqual(await fetchFromVixSrc(q),[]);
  assert.deepEqual(await fetchFromVixSrc({...q,tmdbId:'bad'}),[]);
  assert(!new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_VIXSRC_ENABLED:'0'})).listPublicSources().some(s=>s.id==='source-9'));
  assert(new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_VIXSRC_ENABLED:'1'})).listPublicSources().some(s=>s.id==='source-9'));
  console.log('✓ VixSrc bounded discovery, URL validation, signature and verified multi-audio');
} finally { globalThis.fetch=old; }
