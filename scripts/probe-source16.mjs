// Source 16 through the real registry: TMDB id only, exactly as a viewer's
// embed URL provides it. Proves the server-side conversion works end to end.
import crypto from 'node:crypto';
const { registry } = (await import('../dist/backend/index.js')).createBackendServer({
  host: '127.0.0.1', port: 0, isProd: false,
  secret: crypto.createHash('sha256').update('s16').digest(),
  allowedOrigins: ['*'], requireToken: false, bindTokenIp: false,
  resolveTimeoutMs: 25_000, rateLimitPerMin: 10_000,
});
const titles = [
  { label: 'Naruto S1E1', tmdbId: '46260', season: 1, episode: 1 },
  { label: 'Demon Slayer S1E1', tmdbId: '85937', season: 1, episode: 1 },
  { label: 'JJK S1E1', tmdbId: '95479', season: 1, episode: 1 },
  { label: 'One Piece S1E1', tmdbId: '37854', season: 1, episode: 1 },
  { label: 'AoT S1E1', tmdbId: '1429', season: 1, episode: 1 },
  { label: 'Fight Club (not anime)', tmdbId: '550', season: 1, episode: 1 },
];
let hit = 0;
for (const t of titles) {
  const rows = await registry.selfTestAll({ type: 'tv', ...t });
  const row = rows.find((r) => r.id === 'source-16');
  if (row?.raw > 0) hit += 1;
  console.log(`[s16] ${t.label.padEnd(24)} raw=${String(row?.raw ?? 'n/a').padStart(2)} ${row?.ms ?? 0}ms :: ${String(row?.net ?? '').slice(0, 100)}`);
}
console.log(`[s16] source-16 returned results for ${hit}/${titles.length} (Fight Club must be 0)`);

// touched to re-trigger CI on the simplified conversion
