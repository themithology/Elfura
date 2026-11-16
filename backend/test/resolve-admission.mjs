/**
 * The memory bound: resolves run a few at a time, the rest wait, none are refused.
 *
 * Resolves are the only request that costs the process real memory — twenty
 * adapters, their lanes and their probes are alive for the whole budget. When the
 * ceiling was removed, footprint became (however many arrived at once x that),
 * which is why RAM climbed with traffic. The bound is back, but as a queue: the
 * outage was a ceiling that answered 503, so nothing here is ever refused and
 * every caller still receives a full response.
 */
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('.m3u8')) {
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
  const cfg = loadBackendConfig({ ELFURA_SECRET: 'admission-test-secret', TMDB_API_KEY: 'x' });
  const registry = new SourceRegistry(cfg);
  registry.setResolveParallelism(3);

  let running = 0;
  let peak = 0;
  let calls = 0;
  registry.adapters = [
    {
      id: 'source-1',
      label: 'Source 1',
      enabled: () => true,
      async resolve() {
        calls += 1;
        running += 1;
        if (running > peak) peak = running;
        await new Promise((resolve) => setTimeout(resolve, 40));
        running -= 1;
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

  // Twelve different titles at once against a ceiling of three.
  const titles = Array.from({ length: 12 }, (_, i) => String(1000 + i));
  const answers = await Promise.all(
    titles.map((tmdbId) => registry.resolvePlayback({ type: 'movie', tmdbId })),
  );

  assert.equal(calls, 12, `every title still resolves (got ${calls} adapter calls)`);
  assert.ok(peak <= 3, `never more than three resolves run at once (peak ${peak})`);
  assert.equal(peak, 3, 'and the ceiling is actually used, not left idle');
  assert.ok(
    answers.every((a) => a && Array.isArray(a.sources) && a.sources.length > 0),
    'every one of the twelve callers is answered with a full response',
  );

  const drained = registry.admissionStats();
  assert.equal(drained.queued, 0, 'the queue drains to empty');
  assert.equal(drained.active, 0, 'and no slot is left held');

  // A duplicate does not take a second place in the queue: it rides the run.
  const before = calls;
  const duplicates = await Promise.all(
    Array.from({ length: 6 }, () => registry.resolvePlayback({ type: 'movie', tmdbId: '2000' })),
  );
  assert.equal(calls, before + 1, 'six identical requests run one resolve');
  assert.ok(
    duplicates.every((d) => d === duplicates[0]),
    'and all six receive that one response',
  );

  // The shared run ends when it ends: a later request is a new response, not a
  // replay of the one six callers just received.
  const later = await registry.resolvePlayback({ type: 'movie', tmdbId: '2000' });
  assert.notEqual(later, duplicates[0], 'the bound is a queue, not a response cache');

  console.log(
    '✓ resolve admission: resolves run three at a time, the rest wait, all twelve are answered in full',
  );
} finally {
  globalThis.fetch = realFetch;
}
