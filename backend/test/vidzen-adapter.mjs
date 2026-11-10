import assert from 'node:assert/strict';
import { extractVidZenToken, fetchFromVidZen, createSource12Adapter } from '../../dist/backend/sources/source12.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

const originalFetch = globalThis.fetch;
const requests = [];
const watchHtml = '<script>self.__next_f.push([1,"{\\"apiToken\\":\\"fixture-token-123456\\"}"])</script>';
const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
  if (url.pathname === '/movie/693134' || url.pathname === '/tv/1396/1/2') {
    return new Response(watchHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  if (url.pathname === '/api/sources') {
    assert.equal(url.searchParams.get('token'), 'fixture-token-123456');
    if (url.searchParams.get('type') === 'tv') {
      assert.equal(url.searchParams.get('season'), '1');
      assert.equal(url.searchParams.get('episode'), '2');
    }
    return Response.json({ sources: [
      { type: 'hls', url: 'https://vidzen.fun/api/stream/shared/master.m3u8' },
      { type: 'mp4', url: 'https://vidzen.fun/api/stream/movie.mp4' },
      { type: 'hls', url: 'https://evil.example/api/stream/master.m3u8' },
      { type: 'hls', url: 'https://vidzen.fun/embed/123' },
    ] });
  }
  if (url.pathname === '/api/stream/shared/master.m3u8') {
    return new Response(hls, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  throw new Error(`Unexpected VidZen request: ${url.pathname}`);
};

try {
  assert.equal(extractVidZenToken('"apiToken":"abc12345"'), 'abc12345');
  assert.equal(extractVidZenToken('\\"apiToken\\":\\"escaped-token-123\\"'), 'escaped-token-123');
  assert.equal(extractVidZenToken('<html>no token</html>'), null);

  const raw = await fetchFromVidZen({ type: 'movie', tmdbId: '693134' });
  assert.equal(raw.length, 1, 'only same-origin provider HLS stream URLs should survive');
  assert.equal(raw[0].type, 'hls');
  assert.equal(raw[0].audioLang, undefined, 'server names must not be guessed as audio languages');
  assert.equal(raw[0].headers.Referer, 'https://vidzen.fun/');
  assert(requests.filter(req => req.url.pathname === '/api/sources').length <= 11);
  assert(requests.filter(req => req.url.pathname === '/api/sources').every(req => req.redirect === 'error'));
  assert(!JSON.stringify(raw).includes('fixture-token-123456'), 'page/API tokens must not escape candidate data');

  requests.length = 0;
  const adapter = createSource12Adapter(() => true);
  const resolved = await adapter.resolve({ type: 'tv', tmdbId: '1396', season: 1, episode: 2, diag: [] });
  assert.equal(resolved.candidates.length, 1, 'adapter should retain a manifest-reachable HLS candidate');
  assert.equal(resolved.candidates[0].diagnosticLane, 'VZ');
  assert(requests.some(req => req.url.pathname === '/tv/1396/1/2'), 'TV requests must target the requested season/episode page');

  const enabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'vidzen-test-secret', ELFURA_VIDZEN_ENABLED: '1' }));
  const disabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'vidzen-test-secret', ELFURA_VIDZEN_ENABLED: '0' }));
  assert(enabled.listPublicSources().some(source => source.id === 'source-12'));
  assert(!disabled.listPublicSources().some(source => source.id === 'source-12'));
  console.log('✓ VidZen bounded token extraction, same-origin HLS filtering, TV episode path, manifest verification, and feature toggle');
} finally {
  globalThis.fetch = originalFetch;
}
