#!/usr/bin/env node
/**
 * Source health probe (CI / operator use)
 * =======================================
 * Asks every adapter for one title and prints what each one actually did:
 * how many candidates it returned and which hosts answered, with status codes.
 *
 *   node scripts/source-selftest.mjs                       # movie 550 (Fight Club)
 *   node scripts/source-selftest.mjs tv 1396 1 1           # S1E1
 *
 * Needs TMDB_API_KEY for adapters that fall back to title/year lookups; without
 * it the probe still runs and says so. Always exits 0 — it is a report, not a gate.
 */
import { hydrateProcessEnvFromDotEnv, loadBackendConfig } from '../dist/backend/config.js';
import { SourceRegistry } from '../dist/backend/sources/registry.js';

const [type = 'movie', tmdbId = '550', season, episode] = process.argv.slice(2);
if (!['movie', 'tv'].includes(type)) throw new Error('type must be movie or tv');
hydrateProcessEnvFromDotEnv();
const cfg = loadBackendConfig();

if (!cfg.tmdb.apiKey && !cfg.tmdb.bearerToken && !cfg.tmdb.apiBase) {
  console.log('[selftest] TMDB_API_KEY is not set: adapters that need title/year fallback will report 0.');
}

const registry = new SourceRegistry(cfg);
const rows = await registry.selfTestAll({
  type,
  tmdbId,
  season: season ? Number(season) : undefined,
  episode: episode ? Number(episode) : undefined,
});

const tested = rows.filter((r) => !r.skipped);
const alive = tested.filter((r) => r.raw > 0);
console.log(`\n[selftest] ${type}/${tmdbId}: ${alive.length}/${tested.length} tested sources returned candidates; ${rows.length - tested.length} skipped. Candidates are not playback verification.\n`);
for (const row of rows.sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id))) {
  console.log(row.skipped ? `${row.id.padEnd(10)} skipped: ${row.skipped}` : `${row.id.padEnd(10)} raw=${String(row.raw).padEnd(3)} ${String(row.ms).padStart(5)}ms :: ${row.net}`);
}
if (!alive.length) {
  console.log(
    '\n[selftest] no tested source returned candidates. A refusal, timeout, missing metadata, ' +
      'identity mismatch or unavailable title can all cause this; raw counts do not verify playback.',
  );
}
