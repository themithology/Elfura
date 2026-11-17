// ELFURA_REDIRECT_TO moves the whole site to a new domain.
//
// The behaviour that matters, and the ways it can go wrong:
//   * every page moves, not just the home page - the path and query survive
//     (/embed/movie/550 becomes <new>/embed/movie/550);
//   * the API does not move, because a redirected fetch is a failed fetch;
//   * /roxy does not move, so the panel stays reachable on the old host even
//     after a migration went sideways;
//   * the target host never redirects to itself, or the site would be a loop
//     and the owner locked out of their own domain;
//   * with ELFURA_REDIRECT_FROM set, only those hosts redirect.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// fetch() treats Host as a forbidden header and silently sends the real one, so
// this test cannot use it: the whole feature keys off the Host header.
import http from 'node:http';
import { createBackendServer } from '../../dist/backend/index.js';

const secret = crypto.createHash('sha256').update('redirect-test').digest();
const base = {
  secret,
  allowedOrigins: ['*'],
  requireToken: false,
  bindTokenIp: false,
  resolveTimeoutMs: 2000,
  rateLimitPerMin: 1000,
  isProd: false,
};

const withServer = async (redirect, run) => {
  const { server } = createBackendServer({ ...base, host: '127.0.0.1', port: 0, redirect });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const call = (path, host, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          timeout: 20_000,
          headers: { host, 'user-agent': 'Mozilla/5.0 Chrome/137.0.0.0' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location ?? null }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  try {
    await run(call);
  } finally {
    server.close();
  }
};

const on = (to, extra = {}) => ({ to, from: [], status: 301, keep: [], paths: [], ...extra });

// ---- 1. Every page moves, path and query intact ---------------------------
await withServer(on('https://def.com'), async (call) => {
  const home = await call('/', 'abc.com');
  assert.equal(home.status, 301);
  assert.equal(home.location, 'https://def.com/');

  const movie = await call('/embed/movie/550', 'abc.com');
  assert.equal(movie.status, 301, 'an inner page must redirect, not just the home page');
  assert.equal(movie.location, 'https://def.com/embed/movie/550');

  const tv = await call('/embed/tv/1399/1/3', 'abc.com');
  assert.equal(tv.location, 'https://def.com/embed/tv/1399/1/3');

  const player = await call('/player?id=550&type=movie', 'abc.com');
  assert.equal(player.location, 'https://def.com/player?id=550&type=movie', 'the player moves with the site');

  const query = await call('/search?q=dune&page=2', 'abc.com');
  assert.equal(query.location, 'https://def.com/search?q=dune&page=2', 'the query string must survive');

  // Trailing-slash and deep paths are passed through untouched.
  const deep = await call('/a/b/c/d/', 'abc.com');
  assert.equal(deep.location, 'https://def.com/a/b/c/d/');

  // HEAD is answered without a body but still redirected.
  const head = await call('/embed/movie/550', 'abc.com', 'HEAD');
  assert.equal(head.status, 301);
});

// ---- 2. The API and the panel never move ---------------------------------
await withServer(on('https://def.com'), async (call) => {
  for (const path of ['/api/v1/health', '/api/v1/playback?type=movie&tmdb=550', '/api/v1/session']) {
    const res = await call(path, 'abc.com');
    assert.notEqual(res.status, 301, `${path} must never redirect`);
  }
  const roxy = await call('/roxy', 'abc.com');
  assert.equal(roxy.status, 200, '/roxy must stay reachable on the old host');
  const roxyApi = await call('/roxy/api/overview', 'abc.com');
  assert.equal(roxyApi.location, null, '/roxy/api must not redirect');
});

// ---- 3. The target host is never redirected to itself --------------------
await withServer(on('https://def.com'), async (call) => {
  const already = await call('/embed/movie/550', 'def.com');
  assert.equal(already.status, 200, 'the new domain must serve, not loop');
  const withPort = await call('/', 'def.com:443');
  assert.equal(withPort.status, 200, 'a port in the Host header must not defeat the comparison');
});

// ---- 4. ELFURA_REDIRECT_FROM limits who redirects ------------------------
await withServer(on('https://def.com', { from: ['abc.com', 'theogpiratebot.to'] }), async (call) => {
  assert.equal((await call('/embed/movie/550', 'abc.com')).location, 'https://def.com/embed/movie/550');
  assert.equal((await call('/', 'theogpiratebot.to')).status, 301);
  assert.equal((await call('/', 'some-other-host.example')).status, 200, 'unlisted hosts are untouched');
  assert.equal((await call('/', 'def.com')).status, 200);
});

// ---- 5. A target with a base path keeps it, and 302 is reversible --------
await withServer(on('https://def.com/new/home', { status: 302 }), async (call) => {
  const res = await call('/embed/movie/550?x=1', 'abc.com');
  assert.equal(res.status, 302, 'ELFURA_REDIRECT_STATUS=302 must be honoured');
  assert.equal(res.location, 'https://def.com/new/home/embed/movie/550?x=1');
});

// ---- 6. Scoped: only the embed pages move -------------------------------
// The realistic shape of "put the embeds on embed.theogpiratebot.to": the main
// domain keeps serving its own pages, only /embed/* changes hands.
await withServer(
  on('https://embed.theogpiratebot.to', {
    from: ['theogpiratebot.to'],
    paths: ['/embed/', '/player'],
    keep: ['/api/', '/roxy'],
  }),
  async (call) => {
    assert.equal(
      (await call('/embed/movie/550', 'theogpiratebot.to')).location,
      'https://embed.theogpiratebot.to/embed/movie/550',
      'embeds move',
    );
    assert.equal(
      (await call('/embed/tv/1399/1/3', 'theogpiratebot.to')).location,
      'https://embed.theogpiratebot.to/embed/tv/1399/1/3',
    );
    assert.equal((await call('/', 'theogpiratebot.to')).status, 200, 'the main site must not move');
    // Any other page keeps its own answer - whatever it is (this app has no
    // /about, so 404 is correct) - the point is that it is not redirected.
    assert.equal((await call('/about', 'theogpiratebot.to')).location, null, 'non-embed pages must not move');
    assert.equal((await call('/api/v1/health', 'theogpiratebot.to')).status, 200);
    assert.equal((await call('/embed/movie/550', 'theogpiratebot.online')).status, 200, 'other domains untouched');
    assert.equal((await call('/embed/movie/550', 'embed.theogpiratebot.to')).status, 200, 'no self-redirect');
  },
);

// A prefix without a trailing slash is an exact match, not a prefix.
await withServer(on('https://def.com', { paths: ['/embed'] }), async (call) => {
  assert.equal((await call('/embed', 'abc.com')).location, 'https://def.com/embed');
  assert.equal((await call('/embed/movie/550', 'abc.com')).status, 200, '/embed must not swallow /embed/movie/550');
});

// ---- 7. Off by default ---------------------------------------------------
await withServer({ to: '', from: [], status: 301, keep: [], paths: [] }, async (call) => {
  assert.equal((await call('/embed/movie/550', 'abc.com')).status, 200, 'no setting means no redirect');
});

console.log('redirect: ok');
