import assert from 'node:assert/strict';
import { extractMappleRequestToken, solveMapplePow, fetchFromMapple, createSource15Adapter } from '../../dist/backend/sources/source15.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

const originalFetch = globalThis.fetch;
const requests = [];
let streamUrl = 'https://cdn.example.org/mapple/master.m3u8?sig=signed';
const watchHtml = '<script>window.__REQUEST_TOKEN__ = "mapple+request/token==123";</script>';
const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';
const animeMaster = '#EXTM3U\n' +
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Hindi",LANGUAGE="hi",DEFAULT=YES,AUTOSELECT=YES,URI="hindi.m3u8"\n' +
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese",LANGUAGE="ja",DEFAULT=NO,AUTOSELECT=YES,URI="japanese.m3u8"\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,AUDIO="audio"\nvideo.m3u8\n';

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method || 'GET';
  requests.push({ url, method, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : null, redirect: init.redirect });
  if (url.pathname.startsWith('/watch/')) return new Response(watchHtml, { status: 200, headers: { 'set-cookie': '_mapple_site=fixture-cookie; Path=/; Secure' } });
  if (url.pathname === '/api/playback-init') return Response.json({ token: 'fixture-stream-token-123' });
  if (url.pathname === '/api/encrypt') return Response.json({ encrypted: 'fixture-encrypted-value' });
  if (url.pathname === '/api/stream-encrypted') return Response.json({ success: true, data: { stream_url: streamUrl } });
  if (url.hostname === 'cdn.example.org') return new Response(streamUrl.includes('anime') ? animeMaster : hls, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  throw new Error(`Unexpected Mapple request: ${url.href}`);
};

try {
  assert.equal(extractMappleRequestToken(watchHtml), 'mapple+request/token==123');
  assert.equal(extractMappleRequestToken('<html>no token</html>'), null);
  assert.equal(await solveMapplePow('fixture', 0, 1), '0');
  assert.equal(await solveMapplePow('fixture', 19), null, 'reject PoW difficulty above the CPU cap');
  assert.equal(await solveMapplePow('fixture', 18, 1), null, 'respect the bounded nonce-attempt budget');

  const movie = await fetchFromMapple({ type: 'movie', tmdbId: '693134' });
  assert.equal(movie.length, 1, 'deduplicate identical streams returned by several servers');
  assert.equal(movie[0].type, 'hls');
  assert.equal(movie[0].audioLang, undefined, 'server names must never be inferred as audio languages');
  assert(requests.some(request => request.url.pathname === '/watch/movie/693134'));
  assert(requests.some(request => request.url.pathname === '/api/encrypt' && request.body.data.source === 's10'));
  assert(requests.filter(request => request.url.pathname === '/api/stream-encrypted').every(request => request.redirect === 'error'));
  assert(requests.some(request => request.url.pathname === '/api/playback-init' && request.headers.get('cookie') === '_mapple_site=fixture-cookie' && request.body.requestToken === 'mapple+request/token==123'));
  assert(!JSON.stringify(movie).includes('fixture-stream-token-123'), 'Mapple auth tokens must not escape to stream candidates');

  requests.length = 0;
  await fetchFromMapple({ type: 'tv', tmdbId: '1396', season: 2, episode: 3 });
  assert(requests.some(request => request.url.pathname === '/watch/tv/1396-2-3'), 'use documented current TV URL shape');
  assert(requests.some(request => request.url.pathname === '/api/encrypt' && request.body.data.tv_slug === '2-3'));

  streamUrl = 'http://127.0.0.1/private.m3u8';
  assert.equal((await fetchFromMapple({ type: 'movie', tmdbId: '693134' })).length, 0, 'reject private stream targets');

  streamUrl = 'https://cdn.example.org/mapple/master.m3u8?sig=signed';
  requests.length = 0;
  const adapter = createSource15Adapter(() => true);
  const resolved = await adapter.resolve({ type: 'movie', tmdbId: '693134', diag: [] });
  assert.equal(resolved.candidates.length, 1, 'retain a manifest-reachable HLS result');
  assert.equal(resolved.candidates[0].diagnosticLane, 'M');

  // Anime capability check: Mapple's TMDB TV route accepts an anime ID, and
  // independently observed HLS audio rendition metadata is surfaced as true
  // multi-audio. This fixture is not evidence of live-site availability.
  streamUrl = 'https://cdn.example.org/anime/master.m3u8?sig=signed';
  const animeAdapter = await adapter.resolve({ type: 'tv', tmdbId: '635302', season: 1, episode: 1, diag: [] });
  assert.equal(animeAdapter.candidates.length, 1);
  assert.equal(animeAdapter.candidates[0].multiAudio, true);
  assert.deepEqual(new Set(animeAdapter.candidates[0].availableAudioLangs), new Set(['hi', 'ja']));

  const enabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'mapple-test-secret', ELFURA_MAPPLE_ENABLED: '1' }));
  const disabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'mapple-test-secret', ELFURA_MAPPLE_ENABLED: '0' }));
  assert(enabled.listPublicSources().some(source => source.id === 'source-15'));
  assert(!disabled.listPublicSources().some(source => source.id === 'source-15'));
  console.log('✓ Mapple token, bounded PoW, cookie-bound API flow, movie/TV matching parameters, HLS/SSRF filtering, manifest check, and toggle');
} finally {
  globalThis.fetch = originalFetch;
}
