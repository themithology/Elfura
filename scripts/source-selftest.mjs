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
import { loadBackendConfig } from '../dist/backend/config.js';
import { SourceRegistry } from '../dist/backend/sources/registry.js';

const [type = 'movie', tmdbId = '550', season, episode] = process.argv.slice(2);
const cfg = loadBackendConfig({
  ELFURA_SECRET: process.env.ELFURA_SECRET || 'selftest-local-secret',
  TMDB_API_KEY: process.env.TMDB_API_KEY || '',
  TMDB_BEARER_TOKEN: process.env.TMDB_BEARER_TOKEN || '',
  OPENSUBTITLES_ENABLED: '0',
});

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

const alive = rows.filter((r) => r.raw > 0);
console.log(`\n[selftest] ${type}/${tmdbId}: ${alive.length}/${rows.length} sources returned candidates\n`);
for (const row of rows.sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id))) {
  console.log(`${row.id.padEnd(10)} raw=${String(row.raw).padEnd(3)} ${String(row.ms).padStart(5)}ms :: ${row.net}`);
}
if (!alive.length) {
  console.log(
    '\n[selftest] nothing returned candidates. Read the host lines above: 403/challenge = IP blocked, ' +
      'timeout/DNS = host unreachable, 200 with raw=0 = source has no row for this title.',
  );
}
