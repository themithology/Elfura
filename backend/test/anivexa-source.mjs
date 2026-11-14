import assert from 'node:assert/strict';
import anivexaWorker from '../../dist/backend/vendor/anivexa/index.js';
import {createSource16Adapter} from '../../dist/backend/sources/source16.js';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createBackendServer} from '../../dist/backend/index.js';

const originalFetch = globalThis.fetch;
const originalWorkerFetch = anivexaWorker.fetch;
const requests = [];
const streamManifest = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';

try {
  anivexaWorker.fetch = async request => {
    const url = new URL(request.url);
    requests.push(url.pathname);
    if (url.pathname === '/episodes/16498') {
      return Response.json({
        mappings: { id: 16498 },
        anizone: { episodes: { sub: [{ id: 'watch/anizone/16498/sub/anizone-1', number: 1 }, { id: 'watch/anizone/16498/sub/anizone-3', number: 3 }], dub: [] } },
        reanime: { episodes: { sub: [], dub: [{ id: 'watch/reanime/16498/dub/reanime-1', number: 1 }, { id: 'watch/reanime/16498/dub/reanime-3', number: 3 }] } },
      });
    }
    if (url.pathname === '/watch/anizone/16498/sub/anizone-1' || url.pathname === '/watch/anizone/16498/sub/anizone-3') {
      return Response.json({ streams: [{ url: `https://media.example/${url.pathname.endsWith('-3') ? 'anizone-3' : 'anizone'}.m3u8`, type: 'hls', server: 'AniZone', subtitles: [] }] });
    }
    if (url.pathname === '/watch/reanime/16498/dub/reanime-1' || url.pathname === '/watch/reanime/16498/dub/reanime-3') {
      return Response.json({ streams: [
        { url: `https://media.example/${url.pathname.endsWith('-3') ? 'reanIme-3' : 'reanIme'}.m3u8`, type: 'hls', server: 'ReAnime' },
        { url: 'https://embed.example/player/1', type: 'hls', server: 'Embed fallback' },
      ] });
    }
    return new Response('not found', {status: 404});
  };
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'media.example') return new Response(streamManifest, {headers: {'content-type': 'application/vnd.apple.mpegurl'}});
    throw new Error(`Unexpected upstream request: ${url.hostname}`);
  };

  const query = {type: 'tv', tmdbId: '872585', anilistId: '16498', season: 1, episode: 1};
  const adapter = createSource16Adapter(() => true);
  const result = await adapter.resolve(query);
  assert.equal(result.candidates.length, 2, 'the aggregator returns direct HLS from different providers and drops embed fallbacks');
  assert.deepEqual(result.candidates.map(candidate => candidate.audioLabel), ['Japanese SUB', 'English DUB']);
  assert.deepEqual(result.candidates.map(candidate => candidate.audioVariant), ['sub', 'dub']);
  assert(result.candidates.every(candidate => candidate.type === 'hls' && candidate.audioLang === undefined));
  assert(requests.includes('/episodes/16498'));
  assert(requests.includes('/watch/anizone/16498/sub/anizone-1'));
  assert(requests.includes('/watch/reanime/16498/dub/reanime-1'));

  const regularWorkerFetch = anivexaWorker.fetch;
  anivexaWorker.fetch = async request => {
    const url = new URL(request.url);
    if (url.pathname === '/episodes/999991') return Response.json({
      anizone: { episodes: { sub: [{ id: 'watch/anizone/999991/sub/anizone-1', number: 1 }], dub: [] } },
      reanime: { episodes: { sub: [], dub: [{ id: 'watch/reanime/999991/dub/reanime-1', number: 1 }] } },
    });
    if (url.pathname === '/watch/anizone/999991/sub/anizone-1') {
      return Response.json({ streams: [{ url: 'https://media.example/early.m3u8', type: 'hls' }] });
    }
    if (url.pathname === '/watch/reanime/999991/dub/reanime-1') {
      await new Promise(resolve => setTimeout(resolve, 1200));
      return Response.json({ streams: [{ url: 'https://media.example/late.m3u8', type: 'hls' }] });
    }
    return new Response('not found', {status: 404});
  };
  const lateResults = [];
  const discoveryStarted = Date.now();
  const earlyResult = await adapter.resolve({
    type: 'tv', tmdbId: '999991', anilistId: '999991', anilistEpisode: 1, episode: 1,
    signal: AbortSignal.timeout(5000), onLateResult: result => lateResults.push(result),
  });
  const earlyMs = Date.now() - discoveryStarted;
  assert(earlyMs < 900, `a fast provider should release Anivexa promptly (took ${earlyMs}ms)`);
  assert.equal(earlyResult.candidates.length, 1, 'return the fast provider without waiting for a slow sibling');
  await new Promise(resolve => setTimeout(resolve, 1350));
  assert.equal(lateResults.at(-1)?.candidates.length, 2, 'cache all provider results when the slower lanes finish');
  anivexaWorker.fetch = async request => {
    const url = new URL(request.url);
    if (url.pathname === '/episodes/999992') {
      await new Promise(resolve => setTimeout(resolve, 7300));
      return Response.json({ anizone: { episodes: { sub: [{ id: 'watch/anizone/999992/sub/anizone-1', number: 1 }], dub: [] } } });
    }
    if (url.pathname === '/watch/anizone/999992/sub/anizone-1') {
      return Response.json({ streams: [{ url: 'https://media.example/late-index.m3u8', type: 'hls' }] });
    }
    return new Response('not found', {status: 404});
  };
  const lateIndexResults = [];
  const lateIndexStarted = Date.now();
  const pendingIndexResult = await adapter.resolve({
    type: 'tv', tmdbId: '999992', anilistId: '999992', anilistEpisode: 1, episode: 1,
    signal: AbortSignal.timeout(5000), onLateResult: result => lateIndexResults.push(result),
  });
  const pendingIndexMs = Date.now() - lateIndexStarted;
  assert(pendingIndexMs < 9000, `a slow episode index should not hold the request open (took ${pendingIndexMs}ms)`);
  assert.equal(pendingIndexResult.candidates.length, 0, 'return promptly while the slow episode index continues in the background');
  for (let i = 0; i < 20 && lateIndexResults.length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(lateIndexResults.at(-1)?.candidates.length, 1, 'cache streams discovered after a slow episode index completes');
  anivexaWorker.fetch = regularWorkerFetch;

  const overrideResult = await adapter.resolve({...query, anilistEpisode: 3});
  assert.equal(overrideResult.candidates.length, 2, 'the AniList episode override controls Anivexa lookup independently of the TMDB route episode');
  assert(overrideResult.candidates.every(candidate => candidate.url.includes('-3.m3u8')));
  assert(requests.includes('/watch/anizone/16498/sub/anizone-3'));
  assert(requests.includes('/watch/reanime/16498/dub/reanime-3'));

  const cfg = loadBackendConfig({ELFURA_SECRET: 'anivexa-test-secret', ELFURA_ANIVEXA_ENABLED: '1'});
  const candidate = (sourceId, url) => ({
    key: `${sourceId}:${url}`, type: 'hls', url, quality: 'auto', rank: 1,
  });
  const registry = new SourceRegistry(cfg);
  assert(registry.listPublicSources().some(source => source.id === 'source-16' && source.label === 'Anivexa'));
  assert(!registry.listPublicSources().some(source => source.id === 'source-17'));

  const serverApp = createBackendServer({
    ...loadBackendConfig({
      ELFURA_SECRET: 'anivexa-api-test-secret',
      ELFURA_ANIVEXA_ENABLED: '1',
      SOURCE1_ENABLED: '0',
      ELFURA_NXSHA_ENABLED: '0',
      ELFURA_SCREENSCAPE_ENABLED: '0', ELFURA_VIDZEE_ENABLED: '0', ELFURA_VIXSRC_ENABLED: '0',
      ELFURA_VIDNEST_ENABLED: '0', ELFURA_VAPLAYER_ENABLED: '0', ELFURA_VIDZEN_ENABLED: '0',
      ELFURA_XPASS_ENABLED: '0', ELFURA_RIVE_CITADEL_ENABLED: '0', ELFURA_MAPPLE_ENABLED: '0',
    }),
    requireToken: false,
    isProd: false,
    allowedOrigins: ['*'],
  });
  serverApp.registry.adapters = [
    {id: 'source-1', label: 'Source 1', enabled: () => true, resolve: async () => ({candidates: [candidate('source-1', 'https://media.example/other.m3u8')]})},
    ...serverApp.registry.adapters.filter(source => source.id === 'source-16'),
  ];
  await new Promise(resolve => serverApp.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${serverApp.server.address().port}`;
    const requestCount = requests.length;
    const response = await originalFetch(`${base}/api/v1/playback?type=tv&tmdb=872585&anilist=16498&s=1&e=1&anilistEpisode=3`, {
      headers: {Origin: base, 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36'},
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert(body.sources.some(source => source.sourceId === 'source-1'), `TMDB sources still resolve alongside Anivexa (got ${body.sources.map(source => source.sourceId + ':' + source.label).join(', ')})`);
    assert.equal(body.sources[0].sourceId, 'source-16', 'AniList-backed Anivexa candidates lead the combined response');
    const animeModes = body.sources.filter(source => source.audioVariant);
    assert.deepEqual(animeModes.map(source => source.audioVariant), ['sub', 'dub'], 'Japanese SUB is the default Anivexa mode hierarchy, followed by English DUB');
    assert.deepEqual(animeModes.map(source => source.label), ['Anivexa · Japanese SUB', 'Anivexa · English DUB']);
    assert(animeModes.every(source => source.audioLang === undefined), 'SUB/DUB mode labels are not reported as verified manifest audio languages');
    assert(requests.slice(requestCount).includes('/watch/anizone/16498/sub/anizone-3'), 'backend forwards the independent AniList episode override');
    const englishResponse = await originalFetch(`${base}/api/v1/playback?type=tv&tmdb=872585&anilist=16498&s=1&e=1&anilistEpisode=3&lang=en`, {
      headers: {Origin: base, 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36'},
    });
    const englishBody = await englishResponse.json();
    assert.deepEqual(englishBody.sources.filter(source => source.audioVariant).map(source => source.audioVariant), ['dub', 'sub'], 'English preference puts DUB before SUB without fabricating a verified language track');
    assert.equal((await originalFetch(`${base}/api/v1/playback?type=tv&anilist=16498&s=1&e=1`, {
      headers: {Origin: base, 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36'},
    })).status, 400, 'AniList anime resolution requires the TMDB ID too so standard sources remain available');
    assert.equal((await originalFetch(`${base}/api/v1/playback?type=tv&tmdb=872585&anilist=16498&s=1&e=1&anilistEpisode=0`, {
      headers: {Origin: base, 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36'},
    })).status, 400, 'AniList episode override must be a positive episode number');
    const diagnostic = await originalFetch(`${base}/api/v1/diagnostics?type=tv&tmdb=872585&anilist=16498&anilistEpisode=3&s=1&e=1&fresh=1`, {
      headers: {Origin: base, 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36'},
    });
    assert.equal(diagnostic.status, 200, 'operator diagnostics accept AniList inputs');
    const diagnosticBody = await diagnostic.json();
    assert.equal(diagnosticBody.probe.anilist, '16498');
    assert.equal(diagnosticBody.probe.anilistEpisode, 3);
    assert.equal(diagnosticBody.playback.resolution.adapters.find(source => source.id === 'source-16')?.raw, 2);
  } finally {
    await new Promise(resolve => serverApp.server.close(resolve));
  }

  const prioritized = new SourceRegistry(cfg);
  prioritized.adapters = [
    {id: 'source-1', label: 'Source 1', enabled: () => true, resolve: async () => ({candidates: [candidate('source-1', 'https://media.example/other.m3u8')]})},
    {id: 'source-16', label: 'Anivexa', enabled: () => true, resolve: async () => ({candidates: [candidate('source-16', 'https://media.example/anivexa.m3u8')]})},
  ];
  const combined = await prioritized.resolvePlayback({...query, anilistId: '16498'});
  assert(combined?.sources.length >= 2);
  assert.equal(combined.sources[0].sourceId, 'source-16', 'Anivexa streams are prioritized when an AniList ID is supplied');

  for (const anivexaUrl of [
    'https://media.example/anivexa-delayed-standard.m3u8',
    'https://unreachable.example/anivexa-delayed-standard.m3u8',
  ]) {
    const withSlowStandardSource = new SourceRegistry(cfg);
    withSlowStandardSource.adapters = [
      {
        id: 'source-1', label: 'Source 1', enabled: () => true,
        resolve: async () => {
          await new Promise(resolve => setTimeout(resolve, 2500));
          return {candidates: [candidate('source-1', `https://media.example/standard-${encodeURIComponent(new URL(anivexaUrl).hostname)}.m3u8`)]};
        },
      },
      {
        id: 'source-16', label: 'Anivexa', enabled: () => true,
        resolve: async () => ({candidates: [{...candidate('source-16', anivexaUrl), audioVariant: 'sub'}]}),
      },
    ];
    const resultWithStandard = await withSlowStandardSource.resolvePlayback({...query, anilistId: '16498'});
    assert(resultWithStandard?.sources.some(source => source.sourceId === 'source-1'),
      `a slower regular source must survive AniList resolution even when Anivexa ${anivexaUrl.includes('unreachable') ? 'cannot verify' : 'verifies'} first`);
  }

  console.log('✓ Anivexa uses AniList, preserves normal sources during anime resolution, skips embeds, and ranks first.');
} finally {
  anivexaWorker.fetch = originalWorkerFetch;
  globalThis.fetch = originalFetch;
}
