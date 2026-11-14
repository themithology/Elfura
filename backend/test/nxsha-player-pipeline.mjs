import assert from 'node:assert/strict';
import { createBackendServer } from '../../dist/backend/index.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { nxEncode, nxDecode, NXSHA_SERVER_PRIORITY } from '../../dist/backend/sources/source5.js';
import { openStreamTicket } from '../../dist/backend/security.js';

const originalFetch = globalThis.fetch;
const queryProviders = [];
const config = loadBackendConfig({
  ELFURA_SECRET: 'nxsha-player-pipeline-test-secret',
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  ALLOWED_ORIGINS: 'https://watch.example',
  REQUIRE_PLAYBACK_TOKEN: '0',
  SOURCE1_ENABLED: '0',
  ELFURA_BINGR_ENABLED: '0',
  ELFURA_NXSHA_ENABLED: '1',
  ELFURA_SCREENSCAPE_ENABLED: '1',
  ELFURA_VIDZEE_ENABLED: '0',
  ELFURA_VIXSRC_ENABLED: '0',
  ELFURA_VIDNEST_ENABLED: '0',
  ELFURA_VAPLAYER_ENABLED: '0',
  ELFURA_VIDZEN_ENABLED: '0',
  ELFURA_XPASS_ENABLED: '0',
  ELFURA_RIVE_CITADEL_ENABLED: '0',
  ELFURA_MAPPLE_ENABLED: '0',
  ELFURA_ANIVEXA_ENABLED: '0',
  ELFURA_STREMIO_ADDONS: '[]',
  OPENSUBTITLES_ENABLED: '0',
});

// Exercise the actual production transport, registry, manifest-verification,
// playback response and sealed-stream-ticket path without contacting providers.
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.hostname === 'nxsha.space') {
    const request = nxDecode(url.searchParams.get('q'));
    if (url.pathname.endsWith('/servers')) {
      return Response.json({ _hash: nxEncode({ servers: NXSHA_SERVER_PRIORITY.slice(0, 18).map(scraper => ({ scraper })) }) });
    }
    queryProviders.push(request.provider);
    const candidates = request.provider === 'nitro'
      ? [{ url: 'https://cdn-fixture.example/source5.m3u8', type: 'hls', label: 'Hindi', language: 'Hindi' }]
      : request.provider === 'em-8'
        ? [{ url: 'https://cdn-fixture.example/source7.m3u8', type: 'hls', label: 'English' }]
        : [];
    return Response.json({ _hash: nxEncode({ sources: candidates }) });
  }
  if (url.hostname === 'cdn-fixture.example') {
    if (url.pathname === '/source5.m3u8') {
      // No language metadata: the provider's Hindi hint must not be presented as verified.
      return new Response('#EXTM3U\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST', {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (url.pathname === '/source7.m3u8') {
      return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English",URI="/audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="audio"\n/video.m3u8', {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
    if (url.pathname === '/audio.m3u8' || url.pathname === '/video.m3u8') {
      return new Response('#EXTM3U\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST', {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
  }
  throw new Error(`Unexpected test fetch: ${url.href}`);
};

const { server } = createBackendServer(config, { nxshaTransport: { preferCurl: false } });
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browserHeaders = { Origin: 'https://watch.example', 'User-Agent': 'Mozilla/5.0 Chrome/137.0 Safari/537.36' };

  const health = await originalFetch(`${base}/api/v1/health`).then(response => response.json());
  assert(health.sources.some(source => source.id === 'source-5'));
  assert(health.sources.some(source => source.id === 'source-7'));

  const response = await originalFetch(`${base}/api/v1/playback?type=movie&tmdb=693134`, { headers: browserHeaders });
  assert.equal(response.status, 200);
  const playback = await response.json();
  assert.equal(playback.ok, true);
  assert.equal(playback.media.tmdbId, '693134');
  assert(playback.sourceGroups.includes('source-5'));
  assert(playback.sourceGroups.includes('source-7'));
  assert(playback.sources.some(source => source.sourceId === 'source-5'));
  assert(playback.sources.some(source => source.sourceId === 'source-7'));
  assert.equal(playback.primary.id, playback.sources[0].id);
  assert(playback.sources.every(source => new URL(source.url, base).pathname === '/api/v1/stream'));
  assert(!JSON.stringify(playback).includes('cdn-fixture.example'));
  assert(!JSON.stringify(playback).includes('nxsha.space'));

  const source5 = playback.sources.find(source => source.sourceId === 'source-5');
  const source7 = playback.sources.find(source => source.sourceId === 'source-7');
  assert.equal(source5.audioLang, undefined, 'do not expose a provider label as verified audio language');
  assert.equal(source7.audioLang, 'en', 'expose language only when the inspected manifest proves it');
  const ticketOf = option => openStreamTicket(config.secret, new URL(option.url, base).searchParams.get('t'));
  assert.equal(ticketOf(source5).u, 'https://cdn-fixture.example/source5.m3u8');
  assert.equal(ticketOf(source5).l, undefined);
  assert.equal(ticketOf(source7).u, 'https://cdn-fixture.example/source7.m3u8');
  assert.equal(ticketOf(source7).l, 'en');
  const relayed = await originalFetch(new URL(source5.url, base));
  assert.equal(relayed.status, 200, 'player-facing stream relay must fetch the sealed upstream manifest');
  const relayedManifest = await relayed.text();
  assert.match(relayedManifest, /^#EXTM3U/);
  assert.match(relayedManifest, /\/api\/v1\/stream\?t=/, 'rewrite relative media segments back through the relay');
  assert(queryProviders.includes('nitro'));
  assert(queryProviders.includes('em-8'));
  assert.equal(queryProviders.some(provider => NXSHA_SERVER_PRIORITY.slice(0, 12).includes(provider) && provider === 'em-8'), false);

  console.log('✓ Nxsha/ScreenScape discovery reaches the player only as safe, manifest-verified sealed options');
} finally {
  await new Promise(resolve => server.close(resolve));
  globalThis.fetch = originalFetch;
}
