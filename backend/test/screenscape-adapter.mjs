import assert from 'node:assert/strict';
import { nxEncode, nxDecode } from '../../dist/backend/sources/source5.js';
import { createSource7Adapter } from '../../dist/backend/sources/source7.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';

const old = globalThis.fetch;
const asked = [];
globalThis.fetch = async input => {
  const u = new URL(String(input));
  if (u.hostname === 'nxsha.space') {
    const q = nxDecode(u.searchParams.get('q'));
    if (u.pathname.endsWith('/servers')) return Response.json({ _hash: nxEncode({servers: [
      {scraper:'mbox'}, {scraper:'bdxs'}, {scraper:'vidara'}, {scraper:'nitro'}
    ]}) });
    asked.push(q.provider);
    const file = q.provider === 'mbox' ? 'multi' : 'single';
    return Response.json({ _hash: nxEncode({sources: [
      {url:`https://screen-fixture.example/${file}.m3u8`,type:'hls',label:'Hindi English Multi'},
      {url:'http://127.0.0.1/private.m3u8',type:'hls'},
      {url:'https://vidara.example/file.m3u8',type:'hls'},
      {url:'https://screen-fixture.example/embed',isEmbed:true,type:'hls'},
    ]}) });
  }
  if (u.hostname === 'screen-fixture.example') {
    if (u.pathname === '/child.m3u8') return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');
    const langs = u.pathname === '/multi.m3u8' ? ['hi','en'] : ['en'];
    const tracks = langs.map(l=>`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="${l}",NAME="${l}",URI="/child.m3u8"`).join('\n');
    return new Response(`#EXTM3U\n${tracks}\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="x"\n/child.m3u8`);
  }
  throw new Error(`unexpected request ${u.hostname}`);
};
try {
  const defaultRegistry = new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_SCREENSCAPE_ENABLED:'0'}));
  assert(!defaultRegistry.listPublicSources().some(s=>s.id==='source-7'));
  const cfg = loadBackendConfig({ELFURA_SECRET:'test', ELFURA_SCREENSCAPE_ENABLED:'1'});
  assert(new SourceRegistry(cfg).listPublicSources().some(s=>s.id==='source-7'));
  const diag = [];
  const result = await createSource7Adapter(() => true).resolve({type:'movie',tmdbId:'693134',diag});
  assert.deepEqual(asked.sort(), ['bdxs','mbox']);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[1].audioLang, 'en');
  assert.notEqual(result.candidates[1].multiAudio, true);
  assert.deepEqual(result.candidates[0].availableAudioLangs, ['hi','en']);
  assert.equal(result.candidates[0].multiAudio, true);
  assert.equal(result.candidates[0].diagnosticLane,'S');
  assert.equal(diag[0].ok,true);
  assert.deepEqual((await createSource7Adapter(()=>true).resolve({type:'movie',tmdbId:'bad'})).candidates,[]);
  console.log('✓ ScreenScape toggle, bounded lanes, unsafe/embed rejection and verified manifest audio');
} finally { globalThis.fetch = old; }
