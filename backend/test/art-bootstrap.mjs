import assert from 'node:assert/strict';

/**
 * Artwork bootstrap endpoint.
 *
 * The startup screen needs backdrop + logo in a few hundred milliseconds. Asking
 * for them through /api/v1/playback means waiting for twenty adapters to race
 * (~4 s), which is why the screen stayed black. /api/v1/art answers from TMDB
 * alone, shares the resolve cache, and warms it for the request that follows.
 */
const env = {
  ELFURA_SECRET: 'art-test-secret',
  ALLOWED_ORIGINS: '*',
  OPENSUBTITLES_ENABLED: '0',
  ELFURA_SELF_TEST: '0',
  TMDB_API_BASE: 'https://tmdb.fake',
  TMDB_API_KEY: 'x',
};
Object.assign(process.env, env);

const realFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = async (input, init) => {
  const target = String(input);
  if (!target.includes('tmdb.fake')) return realFetch(input, init);
  upstreamCalls += 1;
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (target.includes('/images')) {
    return json({ logos: [{ file_path: '/l.svg', iso_639_1: 'en', vote_average: 5 }] });
  }
  if (target.includes('/movie/550')) {
    return json({
      id: 550,
      title: 'Fight Club',
      release_date: '1999-10-15',
      runtime: 139,
      poster_path: '/p.jpg',
      backdrop_path: '/b.jpg',
    });
  }
  return json({});
};

const { createBackendServer } = await import('../../dist/backend/index.js');
const { server } = createBackendServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const origin = { Origin: 'https://player.example' };

try {
  const started = Date.now();
  const first = await realFetch(`http://127.0.0.1:${port}/api/v1/art?type=movie&tmdb=550`, { headers: origin });
  const firstMs = Date.now() - started;
  const body = await first.json();

  assert.equal(first.status, 200);
  assert.equal(body.ok, true, 'art must be returned');
  assert.ok(body.media.backdrop, 'backdrop url is required by the startup screen');
  assert.ok(body.media.logo, 'logo url is required by the splash animation');
  assert.equal(body.media.title, 'Fight Club');
  assert.ok(firstMs < 1500, `art bootstrap took ${firstMs}ms`);

  // Second call must come from cache, not TMDB.
  const before = upstreamCalls;
  const again = await realFetch(`http://127.0.0.1:${port}/api/v1/art?type=movie&tmdb=550`, { headers: origin });
  await again.json();
  assert.equal(upstreamCalls, before, 'repeat artwork requests must be RAM cached');

  // An id that is not a bare TMDB id must never reach TMDB.
  const bad = await realFetch(`http://127.0.0.1:${port}/api/v1/art?type=movie&tmdb=../etc`, { headers: origin });
  assert.equal(bad.status, 400);

  // tv accepts season/episode and still answers (empty media is fine when TMDB
  // has nothing; the playback response fills it in later).
  const tv = await realFetch(`http://127.0.0.1:${port}/api/v1/art?type=tv&tmdb=1396&s=1&e=1`, { headers: origin });
  assert.equal(tv.status, 200);

  console.log(`✓ artwork bootstrap answers in ${firstMs}ms, is cached, and rejects junk ids`);
} finally {
  globalThis.fetch = realFetch;
  server.close();
}
