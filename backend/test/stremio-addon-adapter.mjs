import assert from 'node:assert/strict';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { createStremioAddonAdapter, fetchFromStremioAddons } from '../../dist/backend/sources/source17.js';

const parsed = loadBackendConfig({ ELFURA_SECRET: 'stremio-addon-test', ELFURA_STREMIO_ADDONS: '["https://one.example/manifest.json","https://one.example/manifest.json", "http://insecure.example/manifest.json", 4]' });
assert.deepEqual(parsed.stremioAddons, ['https://one.example/manifest.json', 'http://insecure.example/manifest.json']);
const registry = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'empty-addon-test', ELFURA_STREMIO_ADDONS: '[]' }));
assert(!registry.listPublicSources().some(source => source.id === 'source-17'), 'bridge is off until configured');
assert.equal(createStremioAddonAdapter([]).enabled(), false);

const original = globalThis.fetch;
const requested = [];
try {
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    requested.push(url.pathname);
    return Response.json({ streams: [
      { name: '1080p English', url: 'https://cdn.example/video/master.m3u8', behaviorHints: { proxyHeaders: { request: { Referer: `https://player.${url.hostname}/`, Cookie: 'must-not-forward', Authorization: 'Bearer configured' } } } },
      { title: 'Direct file', url: 'https://cdn.example/video.mp4' },
      { title: 'Unsupported browser media', url: 'https://cdn.example/video.webm' },
      { name: 'Torrent', infoHash: '0123456789abcdef0123456789abcdef01234567', fileIdx: 1 },
      { name: 'Not a direct media URL', url: 'https://cdn.example/watch?id=3' },
      { name: 'Unsafe', url: 'http://127.0.0.1/secret.m3u8' },
      { name: 'Credential-bearing URL', url: 'https://user:pass@cdn.example/private.m3u8' },
      { name: 'DRM stream', url: 'https://cdn.example/encrypted.mpd', drmKeyId: 'kid', drmKey: 'key' },
    ] });
  };
  const rows = await fetchFromStremioAddons(['https://one.example/tenant/manifest.json', 'https://two.example/manifest.json'], {
    type: 'tv', tmdbId: '123', season: 2, episode: 4,
    resolveMetaFallback: async () => ({ imdbId: 'tt1234567' }),
  });
  assert.deepEqual(requested, ['/tenant/stream/series/tt1234567:2:4.json', '/stream/series/tt1234567:2:4.json']);
  assert.equal(rows.length, 3, 'direct media is retained; duplicates collapse only when request headers also match');
  assert.equal(rows[0].type, 'hls');
  assert.equal(rows[0].quality, '1080p');
  assert.equal(rows[0].headers.Referer, 'https://player.one.example/');
  assert.equal(rows[0].headers.Authorization, 'Bearer configured');
  assert.equal(rows[0].headers.Cookie, undefined);
  const hlsRows = rows.filter(row => row.type === 'hls');
  assert.equal(hlsRows.length, 2, 'same media URL with distinct required Referers must remain available');
  assert.equal(hlsRows[1].url, hlsRows[0].url);
  assert.equal(hlsRows[1].headers.Referer, 'https://player.two.example/');
  assert.equal(hlsRows[0].audioLabel, undefined, 'addon stream names are not audio-language evidence');
  assert.equal(rows.some(row => row.url.endsWith('.webm')), false, 'unsupported WebM is not mislabeled as MP4');
  const beforeInvalidEpisode = requested.length;
  assert.deepEqual(await fetchFromStremioAddons(['https://one.example/manifest.json'], {
    type: 'tv', tmdbId: '123', season: -1, episode: 4, imdbId: 'tt1234567',
  }), [], 'invalid season must not silently resolve to season one');
  assert.equal(requested.length, beforeInvalidEpisode, 'invalid episode is rejected before network requests');
  const specials = await fetchFromStremioAddons(['https://one.example/manifest.json'], {
    type: 'tv', tmdbId: '123', season: 0, episode: 1, imdbId: 'tt1234567',
  });
  assert.equal(specials.length, 2);
  assert.equal(requested.at(-1), '/stream/series/tt1234567:0:1.json', 'season zero specials are preserved');
  const enabled = createStremioAddonAdapter(['https://one.example/manifest.json']);
  assert(enabled.enabled());
  console.log('✓ Stremio bridge validates episode IDs, filters DRM/unsafe media, preserves required header variants, and caps direct streams.');
} finally {
  globalThis.fetch = original;
}
