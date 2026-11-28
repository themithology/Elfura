#!/usr/bin/env node
/**
 * Diagnose, but on the CI runner instead of your server.
 * =====================================================
 * `/diagnose?type=movie&tmdb=550` reports what ONE host saw at ONE moment. When
 * that host is refused by a provider, the report is indistinguishable from "the
 * adapter is broken" — which is why operators end up rewriting working adapters.
 *
 * This runs the same registry, the same adapters and the same verification as the
 * server's `/diagnose`, on a GitHub runner, and prints a table shaped like the
 * `/diagnose` JSON so the two can be compared row for row:
 *
 *   node scripts/diagnose-compare.mjs movie 550
 *
 * Exit code is 0 even when nothing resolves: this is a comparison, not a gate.
 * A non-zero exit means the script itself failed, not that a source did.
 */
import dns from 'node:dns';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* older runtimes */
}

const { loadBackendConfig } = await import('../dist/backend/config.js');
const { SourceRegistry } = await import('../dist/backend/sources/registry.js');

const [type = 'movie', tmdbId = '550', season, episode] = process.argv.slice(2);

const cfg = loadBackendConfig({
  ELFURA_SECRET: process.env.ELFURA_SECRET || 'diagnose-compare-secret',
  TMDB_API_KEY: process.env.TMDB_API_KEY || '',
  TMDB_BEARER_TOKEN: process.env.TMDB_BEARER_TOKEN || '',
  OPENSUBTITLES_ENABLED: '0',
});

const registry = new SourceRegistry(cfg);
const startedAt = Date.now();
const diag = await registry.diagnosePlayback({
  type,
  tmdbId,
  season: season ? Number(season) : undefined,
  episode: episode ? Number(episode) : undefined,
});
const totalMs = Date.now() - startedAt;

// The server's /diagnose groups verification into "retained" (kept after
// verification) and "manifestReachable" (proved to answer). Mirror the naming so
// a reader can put the two outputs side by side without translating.
const rows = (diag.adapters ?? []).map((a) => ({
  id: a.id,
  raw: a.raw ?? 0,
  retained: a.retained ?? 0,
  reachable: a.manifestReachable ?? 0,
  ms: a.ms ?? 0,
  error: a.error ?? null,
}));

const lanes = new Map((diag.lanes ?? []).map((l) => [l.adapter, l]));
const hostLines = new Map();
for (const lane of diag.lanes ?? []) {
  if (lane.detail) hostLines.set(lane.adapter, lane.detail);
}

const produced = rows.filter((r) => r.raw > 0);
const reachable = rows.filter((r) => r.reachable > 0);

console.log(`\n[diagnose-compare] ${type}/${tmdbId} · ${totalMs}ms · ran on the CI runner\n`);

console.log('source      raw  kept  reach      ms  detail');
console.log('---------  ----  ----  -----  ------  ------');
for (const r of rows.sort((a, b) => b.raw - a.raw || a.id.localeCompare(b.id))) {
  const detail = (hostLines.get(r.id) ?? '').replace(/\s+/g, ' ').slice(0, 96);
  console.log(
    `${r.id.padEnd(9)}  ${String(r.raw).padStart(4)}  ${String(r.retained).padStart(4)}  ` +
      `${String(r.reachable).padStart(5)}  ${String(r.ms).padStart(6)}  ${detail}`,
  );
}

// ── The comparison that matters ──────────────────────────────────────────────
// These two numbers are printed separately on purpose. "raw" is "the provider
// answered our request"; "reachable" is "the stream it named actually serves
// bytes". A source can be 6/6 raw and 0 reachable, and that is a different
// problem from being 0/6 raw.
const answered = produced.length;
const served = reachable.length;
const empty = rows.filter((r) => r.raw === 0);

console.log(
  `\n[diagnose-compare] ${answered}/${rows.length} sources answered with candidates, ` +
    `${served}/${rows.length} had a reachable stream`,
);
if (empty.length) {
  console.log(`[diagnose-compare] answered nothing: ${empty.map((r) => r.id).join(', ')}`);
}

// Host-level evidence, copied from the lane details so a refusal (403/challenge)
// is never confused with a timeout (unreachable) or a 200-with-no-rows.
const refusals = [...hostLines.entries()].filter(([, d]) => /\b(403|429|challenge|captcha)\b/i.test(d));
if (refusals.length) {
  console.log('\n[diagnose-compare] hosts that refused this runner:');
  for (const [id, detail] of refusals) console.log(`  ${id}: ${detail.slice(0, 140)}`);
}

const timeouts = [...hostLines.entries()].filter(([, d]) => /timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(d));
if (timeouts.length) {
  console.log('\n[diagnose-compare] hosts that did not answer this runner:');
  for (const [id, detail] of timeouts) console.log(`  ${id}: ${detail.slice(0, 140)}`);
}

// A machine-readable tail, so a workflow summary can be diffed without parsing
// the table by eye.
console.log('\n[diagnose-compare:json]');
console.log(
  JSON.stringify({
    kind: 'diagnose-compare',
    runner: process.env.GITHUB_RUN_ID ? `github-actions:${process.env.GITHUB_RUN_ID}` : 'local',
    type,
    tmdbId,
    totalMs,
    answered,
    served,
    total: rows.length,
    rows,
    lanes: [...lanes.values()].map((l) => ({ adapter: l.adapter, lane: l.lane, ok: l.ok, detail: l.detail })),
  }),
);

process.exit(0);
