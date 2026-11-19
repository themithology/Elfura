/**
 * Maximum-sources policy regression test.
 *
 * The guiding rule for this deployment: get the largest number of playable
 * sources in front of the viewer. Filters may decide *order*, but only proof
 * that a stream is gone may remove it.
 *
 * Every assertion here corresponds to a real way a working source used to
 * disappear from the list:
 *   - dropped because it was slow to verify while a faster lane succeeded;
 *   - dropped because its measured runtime did not match;
 *   - dropped by a response ceiling that was too low;
 *   - never probed because the shared probe budget ran out.
 */
import assert from 'node:assert/strict';

import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { MAX_LISTED_SOURCES } from '../../dist/backend/sources/selection.js';

const keepAlive = setInterval(() => {}, 1000);
const originalFetch = globalThis.fetch;
const cfg = loadBackendConfig({ ELFURA_SECRET: 'max-sources-test', OPENSUBTITLES_ENABLED: '0' });
const lane = (host) => ({
  key: host,
  url: `https://${host}.example/v/master.m3u8`,
  type: 'hls',
  quality: 'auto',
  rank: 0,
});
const adapterUsing = (id, hosts) => ({
  id,
  label: id,
  enabled: () => true,
  resolve: async () => ({ candidates: hosts.map((host) => lane(host)) }),
});
const MANIFEST = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n/x/c.m3u8';
const CHILD = '#EXTM3U\n#EXTINF:5,\nseg.ts\n#EXT-X-ENDLIST';

try {
  /* ------------------------------------------------------------------ */
  /* 1. A slow-but-working lane survives a fast sibling                 */
  /* ------------------------------------------------------------------ */
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/fast.')) return new Response(MANIFEST);
    if (url.includes('/slow.')) {
      // Answers well outside the probe window, but answers.
      await new Promise((r) => setTimeout(r, 4000));
      return new Response(MANIFEST);
    }
    if (url.includes('/x/c.m3u8')) return new Response(CHILD);
    return new Promise(() => {});
  };
  const slowRegistry = new SourceRegistry(cfg);
  slowRegistry.adapters = [adapterUsing('source-1', ['fast']), adapterUsing('source-2', ['slow'])];
  const slow = await slowRegistry.resolvePlayback({ type: 'movie', tmdbId: '60001' });
  const slowIds = (slow?.sources ?? []).map((s) => s.sourceId);
  assert.ok(slowIds.includes('source-1'), 'the fast lane is listed');
  assert.ok(slowIds.includes('source-2'), 'a slow-but-working lane must not be hidden');
  assert.equal(slowIds[0], 'source-1', 'the verified lane is ranked ahead of the unverified one');

  /* ------------------------------------------------------------------ */
  /* 2. Only proof of absence removes a lane                            */
  /* ------------------------------------------------------------------ */
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/gone.')) return new Response('missing', { status: 404 });
    if (url.includes('/moody.')) return new Response('denied', { status: 403 });
    if (url.includes('/valid.')) return new Response(MANIFEST);
    if (url.includes('/x/c.m3u8')) return new Response(CHILD);
    return new Promise(() => {});
  };
  const mixed = new SourceRegistry(cfg);
  mixed.adapters = [
    adapterUsing('source-1', ['valid']),
    adapterUsing('source-2', ['gone']),
    adapterUsing('source-3', ['moody']),
  ];
  const mixedResult = await mixed.resolvePlayback({ type: 'movie', tmdbId: '60002' });
  const mixedIds = (mixedResult?.sources ?? []).map((s) => s.sourceId);
  assert.ok(mixedIds.includes('source-1'), 'the valid lane is listed');
  assert.ok(mixedIds.includes('source-3'), 'a throttled lane is listed, not deleted');
  assert.ok(!mixedIds.includes('source-2'), 'a 404 lane is genuinely gone and is removed');

  /* ------------------------------------------------------------------ */
  /* 3. The list ceiling does not cut working sources off               */
  /* ------------------------------------------------------------------ */
  assert.ok(
    MAX_LISTED_SOURCES >= 100,
    `the response ceiling must not cap a realistic list (currently ${MAX_LISTED_SOURCES})`,
  );

  let probed = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/master.m3u8')) {
      probed += 1;
      return new Response(MANIFEST);
    }
    if (url.includes('/x/c.m3u8')) return new Response(CHILD);
    return new Promise(() => {});
  };
  const wide = new SourceRegistry(cfg);
  wide.adapters = Array.from({ length: 20 }, (_, n) =>
    adapterUsing(`source-${n + 1}`, Array.from({ length: 5 }, (_, i) => `cdn${n}-${i}`)),
  );
  const wideResult = await wide.resolvePlayback({ type: 'movie', tmdbId: '60003' });
  assert.equal(
    wideResult?.sources.length,
    100,
    `all 100 working lanes must be listed (got ${wideResult?.sources.length ?? 0}, ${probed} probed)`,
  );
  assert.equal(
    new Set(wideResult.sources.map((s) => s.sourceId)).size,
    20,
    'every responding source must be represented',
  );

  console.log(
    `✓ Maximum sources: slow lanes kept, only 404s removed, all 100 lanes from 20 sources listed ` +
      `(probe budget spent on ${probed})`,
  );
} finally {
  globalThis.fetch = originalFetch;
  clearInterval(keepAlive);
}
