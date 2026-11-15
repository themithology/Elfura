import assert from 'node:assert/strict';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

/**
 * Slow-but-working adapters must be recoverable.
 *
 * A `?source=source-N` call is background completeness, not first paint, so it
 * is allowed to wait longer than the shared 3.6 s adapter race. Before this a
 * two-step adapter (catalogue fetch + lane fetch, ~5 s total) could never be
 * added: the first response cut it, and every recovery call cut it in the same
 * place. That is how a source "disappears" while it is working fine.
 */
const keepAlive = setInterval(() => {}, 1000);
const original = globalThis.fetch;

const cfg = loadBackendConfig({
  ELFURA_SECRET: 'recovery-test-secret',
  TMDB_API_BASE: 'https://tmdb-timeout.example',
  TMDB_API_KEY: 'x',
  OPENSUBTITLES_ENABLED: '0',
});
const fake = (id, fn) => ({ id, label: id, enabled: () => true, resolve: fn });
const cand = { key: 'slow-lane', url: 'https://slow-cdn.example.org/show/master.m3u8', type: 'hls', quality: 'auto', rank: 0 };

globalThis.fetch = async (input) =>
  String(input).includes('.m3u8')
    ? new Response('#EXTM3U\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST')
    : new Response('', { status: 404 });

try {
  const reg = new SourceRegistry(cfg);
  reg.adapters = [
    fake('source-1', async () => ({ candidates: [{ ...cand, key: 'fast', url: 'https://fast-cdn.example.org/show/master.m3u8' }] })),
    // Two-step discovery, ~5 s — just over the old race cap.
    fake('source-2', async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return { candidates: [cand] };
    }),
    fake('source-3', async () => ({ candidates: [] })),
  ];

  const first = await reg.resolvePlayback({ type: 'movie', tmdbId: '999301' });
  assert.ok(first, 'first response still succeeds');
  assert.ok(
    first.sourceGroups.includes('source-3'),
    'sourceGroups must name adapters that returned nothing, so the player can ask again',
  );

  const started = Date.now();
  const recovered = await reg.resolvePlayback({ type: 'movie', tmdbId: '999301', sourceId: 'source-2' });
  const ms = Date.now() - started;
  assert.ok(recovered, 'a slow adapter must answer its own recovery call');
  assert.ok(
    recovered.sources.some((s) => s.sourceId === 'source-2' || String(s.url || '').length > 0),
    'recovery call must return the slow adapter lanes',
  );
  assert.ok(ms < 9500, `recovery window took ${ms}ms`);
  console.log('✓ single-source recovery waits long enough for slow two-step adapters');
} finally {
  globalThis.fetch = original;
  clearInterval(keepAlive);
}
