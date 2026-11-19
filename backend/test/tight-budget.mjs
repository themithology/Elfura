import assert from 'node:assert/strict';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

/**
 * A short response budget must never be the reason a working title shows no
 * sources. This reproduces the real break: the budget ran out while the only
 * live candidate was still being probed, the probe window collapsed to a few
 * milliseconds, and the player got an empty list for a title that was fine.
 *
 * Timeline below (budget forced to the 3 s floor):
 *   ~0.0 s  source-1 answers with a dead candidate, source-2 is still working
 *   ~1.4 s  fairness window closes, first verification finds nothing alive
 *   ~2.2 s  second window opens; source-2 delivers its live candidate
 *   ~2.4 s  probe starts with < 1 s of budget left; the probe itself needs ~1 s
 * The probe floor (>= 1.2 s) is what keeps this title playable.
 */
process.env.ELFURA_RESOLVE_BUDGET_MS = '3000';
const keepAlive = setInterval(() => {}, 1000);
const never = () => new Promise(() => {});
const original = globalThis.fetch;

const cfg = loadBackendConfig({
  ELFURA_SECRET: 'tight-budget-test-secret',
  TMDB_API_BASE: 'https://tmdb-timeout.example',
  TMDB_API_KEY: 'x',
  OPENSUBTITLES_ENABLED: '0',
});
const fake = (id, fn) => ({ id, label: id, enabled: () => true, resolve: fn });

const dead = { key: 'dead', url: 'https://cdn.example.org/dead.mp4', type: 'mp4', quality: 'auto', rank: 0 };
const live = { key: 'live', url: 'https://cdn.example.org/slow-live.mp4', type: 'mp4', quality: 'auto', rank: 0 };

// Dead lane fails fast; the healthy lane answers after ~2.2 s and its probe
// needs ~1 s on top. Both are ordinary CDN timings, not a pathological case.
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes('/dead.mp4')) return new Response('nope', { status: 404 });
  if (target.includes('/slow-live.mp4')) {
    await new Promise((r) => setTimeout(r, 1000));
    return new Response(new Uint8Array(2048), { status: 206, headers: { 'content-type': 'video/mp4' } });
  }
  return never();
};

try {
  const reg = new SourceRegistry(cfg);
  reg.adapters = [
    fake('source-1', async () => ({ candidates: [dead] })),
    fake('source-2', async () => {
      await new Promise((r) => setTimeout(r, 2200));
      return { candidates: [live] };
    }),
  ];

  const started = Date.now();
  const res = await reg.resolvePlayback({ type: 'movie', tmdbId: '999101' });
  const ms = Date.now() - started;

  assert.ok(res, 'a working title must not resolve to null because of the clock');
  assert.equal(res.sources.length, 1, `expected the slow-but-live lane, got ${res.sources.length} source(s)`);
  assert.ok(ms < 6800, `tight-budget resolve took ${ms}ms`);

  // And the same title, when *everything* is genuinely dead, must still report
  // nothing rather than inventing a source.
  globalThis.fetch = async (url) =>
    String(url).includes('/live-but-gone.mp4')
      ? new Response('gone', { status: 410 })
      : never();
  const reg2 = new SourceRegistry(cfg);
  reg2.adapters = [
    fake('source-1', async () => ({
      candidates: [{ ...live, key: 'gone', url: 'https://cdn.example.org/live-but-gone.mp4' }],
    })),
  ];
  // Candidates that arrive right before the deadline cannot be probed at all.
  // That used to mean an empty player; the final rail must still list them.
  const lateCfg = { ...cfg };
  const reg3 = new SourceRegistry(lateCfg);
  reg3.adapters = [
    fake('source-1', async () => {
      await new Promise((r) => setTimeout(r, 2900));
      return { candidates: [{ ...live, key: 'very-late', url: 'https://cdn.example.org/very-late.mp4' }] };
    }),
  ];
  const late = await reg3.resolvePlayback({ type: 'movie', tmdbId: '999103' });
  assert.ok(late, 'candidates that miss the probe window must still be offered, not hidden');
  assert.ok(late.sources.length >= 1, 'expected an unverified fallback lane');

  const none = await reg2.resolvePlayback({ type: 'movie', tmdbId: '999102' });
  assert.equal(none, null, 'a title with no live source still resolves to null');
  console.log('✓ tight budget keeps slow-but-live lanes and never invents sources');
} finally {
  globalThis.fetch = original;
  clearInterval(keepAlive);
}
