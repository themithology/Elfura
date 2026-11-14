import assert from 'node:assert/strict';
import { nxEncode, nxDecode, NXSHA_SERVER_PRIORITY } from '../../dist/backend/sources/source5.js';
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
      ...NXSHA_SERVER_PRIORITY.slice(0, 18).map(scraper => ({scraper})),
      {scraper:'ophim'}, {scraper:'vidara'},
    ]}) });
    asked.push(q.provider);
    const file = q.provider === 'vixolity' ? 'multi' : 'single';
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
  const implicitDefaults = new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test'})).listPublicSources();
  assert(implicitDefaults.some(s=>s.id==='source-5'), 'Nxsha is enabled unless explicitly disabled');
  assert(implicitDefaults.some(s=>s.id==='source-7'), 'ScreenScape is enabled unless explicitly disabled');
  const defaultRegistry = new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',ELFURA_NXSHA_ENABLED:'0',ELFURA_SCREENSCAPE_ENABLED:'0'}));
  assert(!defaultRegistry.listPublicSources().some(s=>s.id==='source-5'));
  assert(!defaultRegistry.listPublicSources().some(s=>s.id==='source-7'));
  const cfg = loadBackendConfig({ELFURA_SECRET:'test', ELFURA_SCREENSCAPE_ENABLED:'1'});
  assert(new SourceRegistry(cfg).listPublicSources().some(s=>s.id==='source-7'));
  const diag = [];
  const result = await createSource7Adapter(() => true, {preferCurl:false}).resolve({type:'movie',tmdbId:'693134',diag});
  assert.deepEqual(asked.sort(), NXSHA_SERVER_PRIORITY.slice(12, 18).slice().sort());
  assert.equal(asked.some(provider => NXSHA_SERVER_PRIORITY.slice(0, 12).includes(provider)), false,
    'ScreenScape only calls the next six available Nxsha lanes after Source 5');
  assert.equal(asked.includes('ophim'), false, 'skip the provider the upstream ScreenScape plugin excludes');
  assert.equal(result.candidates.length, 2);
  const english = result.candidates.find(candidate => candidate.audioLang === 'en');
  const multi = result.candidates.find(candidate => candidate.multiAudio === true);
  assert(english, 'retain a reachable English single-audio stream');
  assert(multi, 'retain manifest-verified multi-audio');
  assert.deepEqual(multi.availableAudioLangs, ['hi','en']);
  assert.equal(result.candidates[0].diagnosticLane,'S');
  assert.equal(diag[0].ok,true);
  assert.deepEqual((await createSource7Adapter(()=>true).resolve({type:'movie',tmdbId:'bad'})).candidates,[]);
  console.log('✓ ScreenScape toggle, bounded lanes, unsafe/embed rejection and verified manifest audio');
} finally { globalThis.fetch = old; }
