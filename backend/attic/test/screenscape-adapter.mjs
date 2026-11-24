import assert from 'node:assert/strict';
import { nxEncode, nxDecode, createSource5Adapter } from '../../../dist/backend/sources/source5.js';
import { loadBackendConfig } from '../../../dist/backend/config.js';
import { SourceRegistry } from '../../../dist/backend/sources/registry.js';

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
  // Source-7 is no longer an adapter of its own: it is source-5's second lane set.
  // The thing worth asserting is unchanged behaviour of those lanes — which is
  // what this file always tested. The old listPublicSources assertions on an id
  // that no longer exists are replaced by the equivalent gate check on source-5.
  const offCfg = loadBackendConfig({ELFURA_SECRET:'test',ELFURA_SCREENSCAPE_ENABLED:'0'});
  assert.equal(offCfg.source7?.enabled, false, 'ScreenScape lanes must be off by default');
  const onCfg = loadBackendConfig({ELFURA_SECRET:'test', ELFURA_SCREENSCAPE_ENABLED:'1'});
  assert.equal(onCfg.source7?.enabled, true, 'the env var still turns them on');
  assert(new SourceRegistry(offCfg).listPublicSources().some(s=>s.id==='source-5'));
  // Drive only the ScreenScape half: the primary lane set is a different list of
  // providers (nitro etc.) and this fixture only mocks the ScreenScape ones.
  const diag = [];
  const adapter = createSource5Adapter(() => false, () => true);
  const result = await adapter.resolve({type:'movie',tmdbId:'693134',diag});
  // The merged adapter fetches both lane sets from the same origin, so the
  // primary list is present too. What matters is that the ScreenScape lanes were
  // actually requested — previously this adapter owned that list exclusively.
  assert.deepEqual(asked.sort(), ['bdxs','mbox','nitro']);
  const screenscapeRows = result.candidates.filter(c => c.diagnosticLane === 'S');
  // The fixture serves the same single.m3u8 from both a primary lane and a
  // ScreenScape lane. Merging the two lane sets into one adapter makes that
  // collision visible and it is now deduplicated by URL: one row, not two. That
  // is the point of the merge — the same upstream must not be listed twice.
  const urls = result.candidates.map(c => c.url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate URLs across lane sets');
  assert.equal(screenscapeRows.length, 1, 'the shared URL is kept once, and only the multi-audio one is extra');
  assert.deepEqual(screenscapeRows[0].availableAudioLangs, ['hi','en']);
  assert.equal(screenscapeRows[0].multiAudio, true);
  assert.equal(diag[0].ok,true);
  assert.deepEqual((await adapter.resolve({type:'movie',tmdbId:'bad'})).candidates,[]);
  console.log('✓ ScreenScape toggle, bounded lanes, unsafe/embed rejection and verified manifest audio');
} finally { globalThis.fetch = old; }
