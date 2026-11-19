/**
 * Provider flakiness regression test.
 *
 * The reported symptom was "the same title works sometimes and not other times".
 * A probe used to treat every HTTP error as proof that a stream was gone, so a
 * single 403 or 503 during a burst of provider traffic deleted the lane for that
 * request. Providers throttle constantly, which made results depend on luck.
 *
 * Three properties have to hold:
 *   1. a temporary refusal never removes a lane;
 *   2. a genuinely missing stream still does get removed;
 *   3. a lane that only ever refuses is never ranked as verified-playable.
 *
 * The third one matters as much as the first: the fix for flakiness must not
 * turn into "every blocked stream is advertised as working".
 */
import assert from 'node:assert/strict';

import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { verifyAndFilterCandidatesDetailed } from '../../dist/backend/sources/liveness.js';

const keepAlive = setInterval(() => {}, 1000);
const originalFetch = globalThis.fetch;
const cfg = loadBackendConfig({ ELFURA_SECRET: 'flaky-test', OPENSUBTITLES_ENABLED: '0' });
const lane = (url) => ({ key: url, url, type: 'hls', quality: 'auto', rank: 0 });
const MANIFEST = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/child.m3u8';
const CHILD = '#EXTM3U\n#EXTINF:5,\nseg.ts\n#EXT-X-ENDLIST';

try {
  /* ------------------------------------------------------------------ */
  /* 1. Temporary refusals are not verdicts                             */
  /* ------------------------------------------------------------------ */
  for (const status of [403, 408, 429, 500, 502, 503, 504]) {
    let calls = 0;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/never/')) {
        calls += 1;
        return new Response('busy', { status });
      }
      if (url.includes('/child.m3u8')) return new Response(CHILD);
      return new Response('nope', { status: 404 });
    };
    const result = await verifyAndFilterCandidatesDetailed([
      lane('https://flaky.example/never/master.m3u8'),
    ]);
    assert.equal(
      result.probedDead.size,
      0,
      `HTTP ${status} must not be recorded as a dead lane`,
    );
    assert.equal(
      result.candidates.length,
      1,
      `HTTP ${status} must leave the lane available (unverified) rather than deleting it`,
    );
    assert.ok(
      calls >= 2,
      `HTTP ${status} should be retried once before being believed (saw ${calls} request(s))`,
    );
  }

  /* ------------------------------------------------------------------ */
  /* 2. A definitive answer still removes the lane                      */
  /* ------------------------------------------------------------------ */
  for (const status of [404, 410, 451]) {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/gone/')) return new Response('gone', { status });
      return new Response(CHILD);
    };
    const result = await verifyAndFilterCandidatesDetailed([
      lane('https://flaky.example/gone/master.m3u8'),
    ]);
    assert.equal(result.candidates.length, 0, `HTTP ${status} must remove the lane`);
    assert.ok(
      result.probedDead.has('https://flaky.example/gone/master.m3u8'),
      `HTTP ${status} must be reported as a dead lane`,
    );
  }

  /* ------------------------------------------------------------------ */
  /* 3. Throttling one moment must not cost the other moment            */
  /* ------------------------------------------------------------------ */
  // Same title, asked twice: the first probe is refused, the second succeeds.
  // Both resolves must offer the source.
  let attempt = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/mood/')) {
      attempt += 1;
      // Refuse the first two requests (initial + its retry), then allow.
      if (attempt <= 2) return new Response('denied', { status: 403 });
      return new Response(MANIFEST);
    }
    if (url.includes('/child.m3u8')) return new Response(CHILD);
    return new Promise(() => {});
  };

  const offered = [];
  for (let run = 0; run < 2; run += 1) {
    const registry = new SourceRegistry(cfg);
    registry.adapters = [
      {
        id: 'source-1',
        label: 'mood',
        enabled: () => true,
        resolve: async () => ({ candidates: [lane('https://flaky.example/mood/master.m3u8')] }),
      },
    ];
    const playback = await registry.resolvePlayback({ type: 'movie', tmdbId: '90210' });
    offered.push(playback?.sources.length ?? 0);
  }
  assert.deepEqual(offered, [1, 1], 'a throttled first attempt must not empty the second resolve');

  /* ------------------------------------------------------------------ */
  /* 4. A lane that only ever refuses is offered, but never as verified   */
  /* ------------------------------------------------------------------ */
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/blocked/')) return new Response('denied', { status: 403 });
    return new Promise(() => {});
  };
  const registry = new SourceRegistry(cfg);
  registry.adapters = [
    {
      id: 'source-1',
      label: 'blocked',
      enabled: () => true,
      resolve: async () => ({ candidates: [lane('https://flaky.example/blocked/master.m3u8')] }),
    },
  ];
  const blocked = await registry.resolvePlayback({ type: 'movie', tmdbId: '90211' });
  assert.equal(blocked?.sources.length, 1, 'the lane is still offered as a last resort');
  assert.equal(
    blocked?.primary?.displayLabel ?? null,
    null,
    'a permanently refusing lane must not be ranked as the verified primary',
  );

  console.log(
    '✓ Flakiness: temporary refusals are retried and never delete a lane, definitive errors still do, ' +
      'and a permanently blocked lane is never ranked as verified',
  );
} finally {
  globalThis.fetch = originalFetch;
  clearInterval(keepAlive);
}
