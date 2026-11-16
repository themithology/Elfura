/**
 * A viewer must never be rate-limited out of their own sources.
 *
 * The player reads any non-200 from /api/v1/playback as "this title has no
 * sources" and shows "not available in all sources". Artwork and playback used to
 * spend the same 120/min per-IP abuse bucket as everything else, and a catalogue
 * page asks for artwork once per card — so ordinary browsing could exhaust the
 * bucket and then every title in the catalogue looked dead until the minute
 * rolled over.
 *
 * This test browses hard, then asks for playback, and asserts the viewer is still
 * answered. Artwork and playback now have their own windows (unlimited by
 * default); the abuse-sensitive routes keep the base limit.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
const { createBackendServer } = await import('../../dist/backend/index.js');

const ORIGIN = 'https://watch.elfura.example';
const IP = '203.0.113.77';

const call = (port, path, init = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method || 'GET',
        headers: {
          origin: ORIGIN,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          'x-forwarded-for': IP,
          ...(init.headers || {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });

const { server } = createBackendServer({
  host: '127.0.0.1',
  port: 0,
  isProd: true,
  secret: Buffer.alloc(32, 7),
  allowedOrigins: [ORIGIN],
  requireToken: false,
  bindTokenIp: undefined,
  rateLimitPerMin: 120,
  resolveTimeoutMs: 1200,
  tmdb: { apiKey: '', apiBase: 'https://api.themoviedb.org', language: 'en-US' },
  relayMode: 'hybrid',
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

try {
  // Browse a catalogue the way a real page does: one artwork request per card.
  let artworkOk = 0;
  for (let i = 0; i < 200; i += 1) {
    const res = await call(port, `/api/v1/art?type=movie&tmdb=${1000 + i}`);
    if (res.status === 200) artworkOk += 1;
  }
  assert.ok(artworkOk > 0, 'artwork is served at all');

  // Now play. The viewer must not be told their sources vanished.
  const playback = await call(port, '/api/v1/playback?type=movie&tmdb=550');
  assert.notEqual(playback.status, 429, 'a viewer is never 429ed out of playback after browsing');
  assert.notEqual(playback.status, 403, 'and the player origin is not forbidden');

  // The abuse-sensitive routes keep their own limit, so this protection is not a
  // blanket removal of rate limiting.
  let loginRefusals = 0;
  for (let i = 0; i < 12; i += 1) {
    const res = await call(port, '/roxy/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-host': '127.0.0.1', origin: 'http://127.0.0.1' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    if (res.status === 429) loginRefusals += 1;
  }
  assert.ok(loginRefusals > 0, 'login still rate-limits (5/min)');

  console.log(
    `✓ player budget: ${artworkOk} artwork requests then playback=${playback.status}, login still capped`,
  );
} finally {
  await new Promise((r) => server.close(r));
}
