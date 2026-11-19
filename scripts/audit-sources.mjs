#!/usr/bin/env node
/**
 * Ask every source for the same two titles and report what came back.
 *
 * This is deliberately NOT the boot self-test: it runs each adapter directly so
 * a failure names itself, and it uses a real network (the runner), because the
 * sandbox that edits code has no egress and every source looks dead there.
 *
 * For each source it records: did it produce any candidates, how many survived
 * verification, how long it took, and the network line the adapter logged - which
 * is where "403", "tls-reset" and "dns-fail" appear and tell you WHY.
 */
import crypto from 'node:crypto';
import { createBackendServer } from '../dist/backend/index.js';

const TITLES = [
  // A widely-available film and a long-running series, so a source that handles
  // only one kind is not mistaken for broken.
  { label: 'movie', type: 'movie', tmdbId: '550', imdbId: 'tt0137523' },
  { label: 'tv', type: 'tv', tmdbId: '1399', season: 1, episode: 1, imdbId: 'tt0944947' },
];

const secret = crypto.createHash('sha256').update('source-audit').digest();
const { registry, cfg } = createBackendServer({
  host: '127.0.0.1',
  port: 0,
  isProd: false,
  secret,
  allowedOrigins: ['*'],
  requireToken: false,
  bindTokenIp: false,
  // Generous: a tight budget would report slow-but-working sources as failures.
  resolveTimeoutMs: 20_000,
  rateLimitPerMin: 10_000,
});

const describe = registry.describeSources();
console.log(`[audit] enabled=${describe.enabled.length} disabled=${describe.disabled.length}`);
for (const d of describe.disabled) console.log(`[audit] disabled ${d.id} (${d.flag})`);

const results = [];
for (const title of TITLES) {
  const started = Date.now();
  // selfTestAll runs every enabled adapter directly and returns raw counts plus
  // the adapter's own network note.
  const rows = await registry.selfTestAll({
    type: title.type,
    tmdbId: title.tmdbId,
    season: title.season,
    episode: title.episode,
  });
  const elapsed = Date.now() - started;
  console.log(`[audit] ${title.label} finished in ${elapsed}ms`);
  for (const row of rows) results.push({ title: title.label, ...row });
}

// One line per source, both titles, so the summary is readable at a glance.
const ids = [...new Set(results.map((r) => r.id))].sort((a, b) => {
  const n = (s) => Number(String(s).replace(/\D/g, '')) || 0;
  return n(a) - n(b);
});
console.log('[audit] id\tmovie\ttv\tnote');
for (const id of ids) {
  const m = results.find((r) => r.id === id && r.title === 'movie');
  const t = results.find((r) => r.id === id && r.title === 'tv');
  const ok = (r) => (r ? (r.raw > 0 ? `${r.raw}` : '0') : 'n/a');
  const note = (m?.net || t?.net || '').slice(0, 150);
  console.log(`[audit] ${id}\t${ok(m)}\t${ok(t)}\t${note}`);
}

const working = ids.filter((id) =>
  results.some((r) => r.id === id && r.raw > 0),
);
console.log(`[audit] working=${working.length}/${ids.length}`);
console.log(`[audit] broken=${ids.length - working.length}`);
console.log(`[audit] broken-list=${ids.filter((id) => !working.includes(id)).join(',')}`);
void cfg;
