import assert from 'node:assert/strict';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

const keepAlive = setInterval(() => {}, 1000);
const original = globalThis.fetch;
const never = () => new Promise(() => {});
const fast = { key: 'fast', url: 'https://cdn.example.org/fast.mp4', type: 'mp4', quality: 'auto', rank: 0 };
const slow = { key: 'slow', url: 'https://cdn.example.org/slow.mp4', type: 'mp4', quality: 'auto', rank: 0 };
const adapter = (id, fn) => ({ id, label: id, enabled: () => true, resolve: fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (url) =>
  String(url).startsWith('https://cdn.example.org/')
    ? new Response(new Uint8Array(2048), { status: 206, headers: { 'content-type': 'video/mp4' } })
    : never();

try {
  const cfg = loadBackendConfig({
    ELFURA_SECRET: 'late-join-secret',
    TMDB_API_BASE: 'https://tmdb-hang.example',
    TMDB_API_KEY: 'x',
    OPENSUBTITLES_ENABLED: '0',
  });
  const registry = new SourceRegistry(cfg);
  registry.adapters = [
    adapter('source-1', async () => ({ candidates: [fast] })),
    adapter('source-20', async () => ({ candidates: [] })),
    // Finishes well after the first response is sealed.
    adapter('source-14', async () => { await sleep(6000); return { candidates: [slow] }; }),
  ];

  const started = Date.now();
  let backgroundSettled=false;
  const first = await registry.resolvePlayback({ type: 'movie', tmdbId: '424242', onDiscoverySettled: work => { void work.then(()=>backgroundSettled=true); } });
  const firstMs = Date.now() - started;
  assert.equal(backgroundSettled,false,'admission must be able to see still-running discovery after the first response');
  assert(first, 'first pass must return a playable source');
  const firstIds = first.sources.map((s) => s.sourceId);
  assert(firstIds.includes('source-1'), `fast lane missing: ${firstIds.join(',')}`);
  assert(!firstIds.includes('source-14'), 'slow lane cannot be in the first response');
  assert(first.pendingSources?.includes('source-14'), 'slow lane must be reported as pending');
  assert(firstMs < 4000, `first pass too slow: ${firstMs}ms`);

  // The player's source-specific background recovery must not wipe the
  // original request's late-join stash while slower adapters are still running.
  await registry.resolvePlayback({ type: 'movie', tmdbId: '424242', sourceId: 'source-20' });
  const afterRecovery = await registry.resolvePlayback({ type: 'movie', tmdbId: '424242', late: true });
  assert(afterRecovery?.sources.some(s => s.sourceId === 'source-1'), 'recovery erased the original late stash');

  // While the slow lane is still working, a late pass must never block.
  const earlyStarted = Date.now();
  const early = await registry.resolvePlayback({ type: 'movie', tmdbId: '424242', late: true });
  const earlyMs = Date.now() - earlyStarted;
  assert(earlyMs < 1500, `late pass must not wait for unfinished sources: ${earlyMs}ms`);
  assert(early === null || !early.sources.some((s) => s.sourceId === 'source-14'));

  // After it finishes, the same late pass returns it from RAM cache.
  await sleep(4200);
  const lateStarted = Date.now();
  const late = await registry.resolvePlayback({ type: 'movie', tmdbId: '424242', late: true });
  const lateMs = Date.now() - lateStarted;
  assert(late, 'late pass must return the sources that finished');
  const lateIds = late.sources.map((s) => s.sourceId);
  assert(lateIds.includes('source-14'), `late lane missing: ${lateIds.join(',')}`);
  assert(!late.pendingSources?.includes('source-1'), 'fast lane can no longer be pending');
  assert(lateMs < 2500, `late pass too slow: ${lateMs}ms`);

  // A lane that never finishes is merely reported pending, never returned.
  const hung = new SourceRegistry(cfg);
  hung.adapters = [adapter('source-1', async () => ({ candidates: [fast] })), adapter('source-20', never)];
  const hungFirst = await hung.resolvePlayback({ type: 'movie', tmdbId: '424243' });
  assert(hungFirst?.pendingSources?.includes('source-20'));
  const hungLate = await hung.resolvePlayback({ type: 'movie', tmdbId: '424243', late: true });
  assert(!hungLate || !hungLate.sources.some((s) => s.sourceId === 'source-20'));

  console.log(`✓ Late-join: first ${firstMs}ms (pending source-14), late passes ${earlyMs}ms / ${lateMs}ms, hung lane never surfaces.`);
} finally {
  globalThis.fetch = original;
  clearInterval(keepAlive);
}
