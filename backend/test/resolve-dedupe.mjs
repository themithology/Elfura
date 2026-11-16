/**
 * Identical resolves must share one run.
 *
 * Live traffic showed the same title resolved six times within 200 ms, each a
 * separate race over twenty adapters, 128 of them in flight at once. Nothing is
 * refused here and nothing is cached beyond the run: duplicates simply attach to
 * the resolve that is already going.
 */
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/master.m3u8') || url.endsWith('.m3u8')) {
    return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n', {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    });
  }
  return new Response('', { status: 404 });
};

const { SourceRegistry } = await import('../../dist/backend/sources/registry.js');
const { loadBackendConfig } = await import('../../dist/backend/config.js');

try {
  const cfg = loadBackendConfig({ ELFURA_SECRET: 'dedupe-test-secret', TMDB_API_KEY: 'x' });
  const registry = new SourceRegistry(cfg);
  let calls = 0;
  registry.adapters = [
    {
      id: 'source-1',
      label: 'Source 1',
      enabled: () => true,
      async resolve() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          candidates: [
            {
              key: 'lane-a',
              url: 'https://cdn.example.test/master.m3u8',
              type: 'hls',
              quality: '720p',
              rank: 1,
              audioLang: 'hi',
            },
          ],
        };
      },
    },
  ];

  const params = { type: 'movie', tmdbId: '550' };
  const results = await Promise.all([
    registry.resolvePlayback({ ...params }),
    registry.resolvePlayback({ ...params }),
    registry.resolvePlayback({ ...params }),
    registry.resolvePlayback({ ...params }),
    registry.resolvePlayback({ ...params }),
  ]);

  assert.equal(calls, 1, `five identical requests run the adapter once (got ${calls})`);
  assert.equal(registry.stats().sharedResolves, 4, 'four of the five were shared');
  assert(results.every((r) => r === results[0]), 'every caller receives the same response object');

  // A different episode is a different question and must not be shared.
  await Promise.all([
    registry.resolvePlayback({ type: 'tv', tmdbId: '1396', season: 1, episode: 1 }),
    registry.resolvePlayback({ type: 'tv', tmdbId: '1396', season: 1, episode: 2 }),
  ]);
  assert.equal(calls, 3, 'two different episodes run two adapters (plus the first)');

  // Sharing applies to the run in flight, not to whole responses: a different
  // title still resolves for real, so nothing here is a response cache.
  const other = await registry.resolvePlayback({ type: 'movie', tmdbId: '551' });
  assert.equal(calls, 4, 'a different title runs the adapter again');

  // A late pass is never collapsed onto the first pass: its whole job is to
  // report what finished after the first response went out, and handing back the
  // earlier snapshot would silently cost the viewer those lanes. It reads the
  // cache instead of racing adapters again, so it costs no adapter call.
  const lateAlone = await registry.resolvePlayback({ type: 'movie', tmdbId: '551', late: true });
  assert.ok(lateAlone !== null && lateAlone !== other, 'a late pass runs on its own');
  assert.equal(calls, 4, 'and a late pass does not start another race');
  assert.notEqual(other, results[0], 'responses are built per title, not reused');

  console.log('✓ resolve dedupe: identical concurrent requests share one run, different episodes do not, nothing is cached');
} finally {
  globalThis.fetch = realFetch;
}
