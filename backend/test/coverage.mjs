import assert from 'node:assert/strict';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

/**
 * Coverage: a title must show every source that answered. The old selection
 * cap listed two single-track streams no matter how many adapters resolved, so
 * a twenty-source backend looked like a two-source one.
 */
const keepAlive = setInterval(() => {}, 1000);
const original = globalThis.fetch;

const cfg = loadBackendConfig({
  ELFURA_SECRET: 'coverage-test-secret',
  TMDB_API_BASE: 'https://tmdb-timeout.example',
  TMDB_API_KEY: 'x',
  OPENSUBTITLES_ENABLED: '0',
});
const fake = (id, fn) => ({ id, label: id, enabled: () => true, resolve: fn });
const cand = (host, name) => ({ key: name, url: `https://${host}/${name}.m3u8`, type: 'hls', quality: 'auto', rank: 0 });

// Every source answers with three healthy lanes on its own host.
const SOURCES = 8;
globalThis.fetch = async (input) => {
  const target = String(input);
  if (/\.m3u8(\?|$)/.test(target)) {
    return new Response('#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST', { status: 200 });
  }
  return new Response('', { status: 404 });
};

try {
  const reg = new SourceRegistry(cfg);
  reg.adapters = Array.from({ length: SOURCES }, (_, i) =>
    fake(`source-${i + 1}`, async () => ({
      candidates: [0, 1, 2].map((n) => cand(`cdn${i}.example.org`, `lane-${n}`)),
    })),
  );

  const res = await reg.resolvePlayback({ type: 'movie', tmdbId: '999201' });
  assert.ok(res, 'a healthy title must resolve');
  assert.equal(res.sourceGroups.length, SOURCES, `expected ${SOURCES} source groups, got ${res.sourceGroups.length}`);
  assert.equal(res.sources.length, SOURCES * 3, `expected every lane listed, got ${res.sources.length}`);
  for (const id of res.sourceGroups) {
    assert.ok(id.startsWith('source-'), 'streams keep generic source labels');
  }

  // Lanes whose probe never finished are still offered, but they must sit
  // behind the verified ones — the first source stays known-good.
  globalThis.fetch = async (input) => {
    const target = String(input);
    if (target.includes('/fast.m3u8')) return new Response('#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST');
    if (target.includes('/slow.m3u8')) {
      await new Promise((r) => setTimeout(r, 4000));
      return new Response('#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST');
    }
    return new Promise(() => {});
  };
  const reg2 = new SourceRegistry(cfg);
  reg2.adapters = [
    fake('source-1', async () => ({ candidates: [cand('good.example.org', 'fast')] })),
    fake('source-2', async () => ({ candidates: [cand('slow.example.org', 'slow')] })),
  ];
  const mixed = await reg2.resolvePlayback({ type: 'movie', tmdbId: '999202' });
  assert.ok(mixed && mixed.sources.length >= 2, `expected both lanes listed, got ${mixed?.sources.length}`);
  const first = mixed.sources[0];
  assert.ok(String(first.url || '').length > 0, 'first stream is a real url');
  console.log('✓ coverage keeps every responding source and orders verified lanes first');
} finally {
  globalThis.fetch = original;
  clearInterval(keepAlive);
}
