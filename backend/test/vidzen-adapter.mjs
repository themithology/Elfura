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
      // Same-origin player path. Kept as a candidate (ranked last) because it is
      // what the provider hands us, but it cannot verify: see below.
      { type: 'hls', url: 'https://vidzen.fun/api/stream/shared/master.m3u8' },
      { type: 'mp4', url: 'https://vidzen.fun/api/stream/movie.mp4' },
      // A real provider host is what actually works.
      { type: 'hls', directUrl: 'https://cdn.provider.example/master.m3u8' },
      { type: 'hls', url: 'http://127.0.0.1/private.m3u8' },
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
  // The player-locked /api/stream rows are still returned (the provider gave them
  // to us) but they are ranked below a real provider URL, and the loopback and
  // /embed/ rows are refused outright.
  assert.equal(raw.length, 3, 'two player-locked rows plus one real provider URL');
  // Rank order is the contract: the working URL must come first.
  assert.equal(raw[0].url, 'https://cdn.provider.example/master.m3u8');
  assert.deepEqual(new Set(raw.map(candidate => candidate.type)), new Set(['hls', 'mp4']));
  // A real provider URL must outrank the player-locked ones: the locked path
  // answers any request with "Direct Stream Access Prohibited" HTML, so it can
  // never verify, and ranking it first meant the adapter reported 16 candidates
  // and 0 reachable on CI.
  assert.equal(raw[0].url, 'https://cdn.provider.example/master.m3u8', 'the provider URL must rank first');
  for (const candidate of raw) {
    assert.ok(!candidate.url.includes('127.0.0.1'), 'loopback must be refused');
    assert.ok(!candidate.url.includes('/embed/'), 'embed pages are not streams');
  }
  assert.equal(raw[0].headers.Referer, 'https://vidzen.fun/');
  assert(requests.filter(req => req.url.pathname === '/api/sources').length <= 11);
  assert(requests.filter(req => req.url.pathname === '/api/sources').every(req => req.redirect === 'manual'));
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
  /* ── pool ordering, relay ranking and token refresh ─────────────────── */

  const lateHls = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';
  let tokenGeneration = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/movie/693134') {
      tokenGeneration += 1;
      return new Response(`{\\"apiToken\\":\\"token-gen-${tokenGeneration}0123\\"}`, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url.pathname === '/api/sources') {
      const server = url.searchParams.get('server');
      const token = url.searchParams.get('token');
      // Servers that only have dead lanes keep the pool full of unverified rows.
      if (server !== 'helios' && server !== 'uranus') {
        return Response.json({ sources: [
          { type: 'hls', url: `https://vidzen.fun/api/stream/dead-${server}/a.m3u8` },
          { type: 'hls', url: `https://vidzen.fun/api/stream/dead-${server}/b.m3u8` },
        ] });
      }
      if (server === 'uranus') {
        // A relay-fronted lane that really is alive.
        return Response.json({ sources: [
          { type: 'hls', url: 'https://alive-sun.workers.dev/relay/live.m3u8' },
        ] });
      }
      // The last server in the list owns the only provider-hosted live lane.
      return Response.json({ sources: [
        { type: 'hls', url: 'https://vidzen.fun/api/stream/dead-helios/a.m3u8' },
        { type: 'hls', url: 'https://vidzen.fun/api/stream/late/master.m3u8' },
      ] });
    }
    if (url.pathname === '/api/stream/late/master.m3u8' || url.pathname === '/relay/live.m3u8') {
      return new Response(lateHls, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (url.pathname.startsWith('/api/stream/dead-')) return new Response('gone', { status: 404 });
    if (url.pathname === '/api/stream/late/master.m3u8') return new Response(lateHls, { status: 200 });
    throw new Error(`Unexpected VidZen request: ${url.pathname}`);
  };
  const poolAdapter = createSource12Adapter(() => true);
  const rawPool = await fetchFromVidZen({ type: 'movie', tmdbId: '693134' });
  assert(rawPool.length > 8, 'the raw pool is collected beyond the old cap of 8 before filtering');
  // A worker relay is a genuine lane, not something to hide. It is ranked below
  // provider-hosted URLs, and both survive when both are alive.
  assert(rawPool.some(candidate => candidate.url.includes('workers.dev')),
    'a relay-fronted lane is a real source and must not be dropped for its hostname');
  const pooled = await poolAdapter.resolve({ type: 'movie', tmdbId: '693134', diag: [] });
  assert.equal(pooled.candidates.length, 2, 'the relay lane and the provider lane both play');
  // The relay outranks the site's own /api/stream/ path, and that is correct: the
  // relay is fetchable and the /api/stream/ path answers any non-player request
  // with "Direct Stream Access Prohibited" HTML. A playable relay beats a
  // player-locked URL, however much we would prefer the provider's own host.
  assert.equal(pooled.candidates[0].url, 'https://alive-sun.workers.dev/relay/live.m3u8');
  const locked = pooled.candidates.find((candidate) => candidate.url.includes('/api/stream/'));
  assert.ok(locked.rank > pooled.candidates[0].rank, 'the player-locked URL must rank last');

  // Loopback and embed pages are still refused outright.
  for (const candidate of rawPool) {
    assert.ok(!candidate.url.includes('127.0.0.1'), 'loopback must never become a candidate');
    assert.ok(!/\/embed(?:\/|$)/.test(new URL(candidate.url).pathname), 'embed pages are not streams');
  }

  // 403 from every server once, then a fresh token makes them work.
  let rejectedOnce = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/movie/693134') {
      return new Response('{"apiToken":"refreshed-token-9876"}', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.pathname === '/api/sources') {
      if (!rejectedOnce && url.searchParams.get('token') === 'refreshed-token-9876') rejectedOnce = true;
      if (url.searchParams.get('server') !== 'mars') return Response.json({ sources: [] });
      return Response.json({ sources: [{ type: 'hls', url: 'https://vidzen.fun/api/stream/after-refresh/master.m3u8' }] });
    }
    throw new Error(`Unexpected VidZen request: ${url.pathname}`);
  };
  const refreshed = await fetchFromVidZen({ type: 'movie', tmdbId: '693134' });
  assert(refreshed.some(candidate => candidate.url.includes('after-refresh')),
    'a rejected server list is retried with a freshly minted token');

  // A draw that yields only dead ids is retried once with a fresh token.
  let draw = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/movie/693134') {
      draw += 1;
      return new Response(`{"apiToken":"draw-token-${draw}-abcd"}`, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.pathname === '/api/sources') {
      const token = url.searchParams.get('token');
      const server = url.searchParams.get('server');
      if (server !== 'mars') return Response.json({ sources: [] });
      if (token.startsWith('draw-token-1')) {
        return Response.json({ sources: [{ type: 'hls', url: 'https://vidzen.fun/api/stream/stale/master.m3u8' }] });
      }
      return Response.json({ sources: [{ type: 'hls', url: 'https://vidzen.fun/api/stream/second-draw/master.m3u8' }] });
    }
    if (url.pathname === '/api/stream/stale/master.m3u8') return new Response('gone', { status: 404 });
    if (url.pathname === '/api/stream/second-draw/master.m3u8') {
      return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST', { status: 200 });
    }
    throw new Error(`Unexpected VidZen request: ${url.pathname}`);
  };
  const retryAdapter = createSource12Adapter(() => true);
  const retriedResult = await retryAdapter.resolve({ type: 'movie', tmdbId: '693134', diag: [] });
  assert.equal(retriedResult.candidates.length, 1, 'a second draw rescues a title whose first draw was dead');
  assert(retriedResult.candidates[0].url.includes('second-draw'));
  assert.equal(draw, 2, 'exactly one extra token mint is spent on the retry');

  console.log('✓ VidZen token extraction/refresh, same-origin filtering, TV episode path, post-verification capping, empty-draw retry, relay ranking, and toggle');
} finally {
  globalThis.fetch = originalFetch;
}
