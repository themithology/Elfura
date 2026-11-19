#!/usr/bin/env node
/**
 * Hindi-dub anime sources, tested with anime.
 *
 * The first audit asked sources 18 and 19 for Fight Club and Game of Thrones and
 * recorded "0 candidates". That was the harness being wrong: both sources read an
 * anime-only catalogue, so a live-action title cannot match and returning nothing
 * is correct. This probe asks for real anime, and prints each source's own trace
 * so a failure says WHICH gate failed instead of just "0".
 *
 * Titles chosen for Hindi-dub availability, not popularity: Naruto, One Piece,
 * Dragon Ball Z and Jujutsu Kaisen all have Hindi dubs; Attack on Titan has one
 * too but is the usual control because its TMDB id is well known.
 */
import crypto from 'node:crypto';

const TMDB = {
  naruto: '46260',        // Naruto (tv)
  narutoS: '1',
  jjk: '95479',           // Jujutsu Kaisen (tv)
  dbz: '12971',           // Dragon Ball Z (tv)
  onepiece: '37854',      // One Piece (tv)
  aot: '1429',            // Attack on Titan (tv)
};

const titles = [
  { label: 'Naruto S1E1', tmdbId: TMDB.naruto, season: 1, episode: 1 },
  { label: 'Naruto S1E5', tmdbId: TMDB.naruto, season: 1, episode: 5 },
  { label: 'JJK S1E1', tmdbId: TMDB.jjk, season: 1, episode: 1 },
  { label: 'DBZ S1E1', tmdbId: TMDB.dbz, season: 1, episode: 1 },
  { label: 'One Piece S1E1', tmdbId: TMDB.onepiece, season: 1, episode: 1 },
  { label: 'AoT S1E1', tmdbId: TMDB.aot, season: 1, episode: 1 },
];

const secret = crypto.createHash('sha256').update('anime-audit').digest();
const { registry } = (await import('../dist/backend/index.js')).createBackendServer({
  host: '127.0.0.1',
  port: 0,
  isProd: false,
  secret,
  allowedOrigins: ['*'],
  requireToken: false,
  bindTokenIp: false,
  resolveTimeoutMs: 25_000,
  rateLimitPerMin: 10_000,
});

const ANIME_SOURCES = new Set(['source-16', 'source-17', 'source-18', 'source-19']);

for (const title of titles) {
  const rows = await registry.selfTestAll({ type: 'tv', ...title });
  for (const row of rows.filter((r) => ANIME_SOURCES.has(r.id))) {
    console.log(
      `[anime] ${title.label.padEnd(14)} ${row.id.padEnd(10)} raw=${String(row.raw).padStart(2)} ${row.ms}ms :: ${String(row.net || '').slice(0, 110)}`,
    );
  }
}

// A per-source verdict, so a single title's miss is not mistaken for a dead source.
const totals = new Map();
for (const title of titles) {
  const rows = await registry.selfTestAll({ type: 'tv', ...title });
  for (const row of rows.filter((r) => ANIME_SOURCES.has(r.id))) {
    const t = totals.get(row.id) ?? { hit: 0, n: 0 };
    t.n += 1;
    if (row.raw > 0) t.hit += 1;
    totals.set(row.id, t);
  }
}
console.log('');
for (const [id, t] of [...totals.entries()].sort()) {
  console.log(`[anime] ${id}: ${t.hit}/${t.n} titles with results`);
}
