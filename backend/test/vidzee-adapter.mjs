import assert from 'node:assert/strict';
import { fetchFromVidZee, createSource8Adapter } from '../../dist/backend/sources/source8.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
const original = globalThis.fetch, requests = [];
globalThis.fetch = async (input, options) => {
  const u = new URL(String(input)); requests.push(u);
  if (u.hostname === 'core.vidzee.wtf') {
    assert.equal(options.redirect, 'error');
    assert.equal(u.pathname, '/streams/tv/1396/1/2'); assert.equal(u.searchParams.get('e'), '0');
    const s = u.searchParams.get('s');
    if (s === 'dcloud') return Response.json({url:'https://vz-fixture.example/multi.m3u8', language:'Hindi', headers:{Referer:'https://valid.example/',Authorization:'secret',Origin:'http://127.0.0.1'}});
    if (s === 'v6:Hindi') return Response.json({url:'https://vz-fixture.example/single.m3u8', language:'Hindi'});
    if (s === 'ipcloud') return Response.json({url:'http://127.0.0.1/private.m3u8'});
    return Response.json({url:'https://vidara.example/stream.m3u8'});
  }
  if (u.hostname === 'vz-fixture.example') {
    if (u.pathname === '/child.m3u8') return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');
    const langs = u.pathname === '/multi.m3u8' ? ['hi','en'] : ['hi'];
    return new Response('#EXTM3U\n' + langs.map(l=>`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="${l}",NAME="${l}",URI="/child.m3u8"`).join('\n') + '\n#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="x"\n/child.m3u8');
  }
  throw new Error('unexpected host');
};
try {
  const q = {type:'tv',tmdbId:'1396',season:1,episode:2};
  const raw = await fetchFromVidZee(q);
  assert.equal(raw.length,2); assert.equal(raw[0].headers.Referer,'https://valid.example/');
  assert(!('Authorization' in raw[0].headers)); assert(!('Origin' in raw[0].headers));
  assert.deepEqual(await fetchFromVidZee({...q,tmdbId:'bad'}),[]);
  assert.deepEqual(await fetchFromVidZee({...q,episode:0}),[]);
  const diag = [], result = await createSource8Adapter(()=>true).resolve({...q,diag});
  assert.equal(result.candidates.length,2); assert.deepEqual(result.candidates[0].availableAudioLangs,['hi','en']);
  assert.equal(result.candidates[1].audioLang,'hi'); assert.notEqual(result.candidates[1].multiAudio,true);
  assert.equal(result.candidates[0].multiAudio,true); assert.equal(result.candidates[0].diagnosticLane,'Z');
  assert(!new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test'})).listPublicSources().some(s=>s.id==='source-8'));
  assert(new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_VIDZEE_ENABLED:'1'})).listPublicSources().some(s=>s.id==='source-8'));
  console.log('✓ VidZee opt-in, validated input, bounded server list, safe headers and separate audio dubs');
} finally {globalThis.fetch=original;}
