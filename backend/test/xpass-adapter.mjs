import assert from 'node:assert/strict';
import { fetchFromXpass, xpassCandidates, createSource13Adapter } from '../../dist/backend/sources/source13.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

const originalFetch = globalThis.fetch;
const requests = [];
const player = 'https://player-4aq.pages.dev/';
const makeProxy = (target, signature = 'a'.repeat(64), provider = 'xpass') => {
  const url = new URL('https://freakyniki.elaxo.lol/proxyv2');
  url.searchParams.set('url', target);
  url.searchParams.set('provider', provider);
  url.searchParams.set('sig', signature);
  return url.href;
};
const response = {
  type: 'Movie',
  itemMatched: 'Unknown',
  streams: [
    { format: 'HLS', url: makeProxy('https://vip.1x2.space/playlist/opaque/master.m3u8') },
    { format: 'HLS', url: makeProxy('https://suprox.xpass.top/proxy2/opaque/2/master.m3u8') },
    { format: 'MP4', url: makeProxy('https://vip.1x2.space/playlist/opaque/movie.mp4') },
    { format: 'HLS', url: makeProxy('https://evil.example/playlist/opaque/master.m3u8') },
    { format: 'HLS', url: 'https://evil.example/proxyv2?url=https%3A%2F%2Fvip.1x2.space%2Fx.m3u8' },
  ],
};
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
  if (url.hostname === 'freakyniki.elaxo.lol' && url.pathname === '/') {
    const tv = url.searchParams.has('season');
    return Response.json(tv ? { ...response, type: 'TV', season: url.searchParams.get('season'), episode: url.searchParams.get('episode') } : response);
  }
  if (url.hostname === 'freakyniki.elaxo.lol' && url.pathname === '/proxyv2') {
    return new Response(media, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  throw new Error(`Unexpected Xpass request: ${url.href}`);
};

try {
  const parsed = xpassCandidates(response);
  assert.equal(parsed.length, 2, 'only signed HLS proxy URLs to approved hosts should survive');
  assert(parsed.every(candidate => candidate.type === 'hls'));
  assert(parsed.every(candidate => candidate.audioLang === undefined), 'server names must not be treated as audio-language evidence');
  assert(parsed.every(candidate => candidate.headers.Referer === player));
  assert.equal(xpassCandidates({ streams: [{ format: 'HLS', url: makeProxy('https://vip.1x2.space/a.m3u8', 'bad') }] }).length, 0);

  const movie = await fetchFromXpass({ type: 'movie', tmdbId: '693134' });
  assert.equal(movie.length, 2);
  assert.equal(requests.at(-1).url.searchParams.get('tmdb_id'), '693134');
  assert.equal(requests.at(-1).headers.get('referer'), player);
  assert.equal(requests.at(-1).redirect, 'error');
  const beforeInvalid = requests.length;
  assert.equal((await fetchFromXpass({ type: 'movie', tmdbId: 'https://invalid.example' })).length, 0);
  assert.equal(requests.length, beforeInvalid, 'invalid IDs must be rejected before upstream requests');

  requests.length = 0;
  const adapter = createSource13Adapter(() => true);
  const resolved = await adapter.resolve({ type: 'tv', tmdbId: '1396', season: 2, episode: 3, diag: [] });
  assert.equal(resolved.candidates.length, 2, 'manifest-reachable candidates should pass server-side liveness checks');
  assert(resolved.candidates.every(candidate => candidate.diagnosticLane === 'X'));
  assert.equal(requests[0].url.searchParams.get('season'), '2');
  assert.equal(requests[0].url.searchParams.get('episode'), '3');

  const enabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'xpass-test-secret', ELFURA_XPASS_ENABLED: '1' }));
  const disabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'xpass-test-secret', ELFURA_XPASS_ENABLED: '0' }));
  assert(enabled.listPublicSources().some(source => source.id === 'source-13'));
  assert(!disabled.listPublicSources().some(source => source.id === 'source-13'));
  console.log('✓ Xpass bounded discovery, signed proxy and target validation, TV episode params, manifest check, and feature toggle');
} finally {
  globalThis.fetch = originalFetch;
}
