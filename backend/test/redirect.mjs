// ELFURA_REDIRECT_TO: one setting, replace the domain, keep everything after it.
//
// What must hold:
//   * every page moves, not just the home page;
//   * the path and query survive untouched;
//   * /api keeps answering (a redirected fetch is a failed fetch, so playback
//     would break for anyone still on the old domain);
//   * /roxy keeps answering (otherwise a bad migration locks you out of the
//     panel on the old host);
//   * the new domain does not redirect to itself.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createBackendServer } from '../../dist/backend/index.js';
import { parseRedirectTo } from '../../dist/backend/config.js';

// ---- the setting itself ---------------------------------------------------
assert.equal(parseRedirectTo(undefined), '', 'unset means off');
assert.equal(parseRedirectTo('   '), '', 'blank means off');
assert.equal(parseRedirectTo('def.com'), 'https://def.com', 'a bare domain gets https');
assert.equal(parseRedirectTo('def.com/'), 'https://def.com', 'a trailing slash is dropped');
assert.equal(parseRedirectTo('https://def.com/'), 'https://def.com');
assert.equal(parseRedirectTo('http://def.com:8080'), 'http://def.com:8080', 'a port is kept');
assert.equal(parseRedirectTo('def.com/some/path'), 'https://def.com', 'only the host is used');
assert.equal(parseRedirectTo('not a domain'), '', 'garbage does nothing rather than making a broken Location');
assert.equal(parseRedirectTo('javascript:alert(1)'), '', 'only http(s) is allowed');

// ---- the requests ---------------------------------------------------------
const secret = crypto.createHash('sha256').update('redirect-test').digest();
const withServer = async (redirectTo, run) => {
  const { server } = createBackendServer({
    host: '127.0.0.1',
    port: 0,
    isProd: false,
    secret,
    allowedOrigins: ['*'],
    requireToken: false,
    bindTokenIp: false,
    resolveTimeoutMs: 2000,
    rateLimitPerMin: 1000,
    redirectTo,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // fetch() refuses to set Host, and this feature keys off Host entirely.
  const call = (path, host, method = 'GET', extraHeaders = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method, timeout: 20_000, headers: { host, 'user-agent': 'Mozilla/5.0 Chrome/137.0.0.0', ...extraHeaders } },
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

await withServer('https://def.com', async (call) => {
  const cases = [
    ['/', 'https://def.com/'],
    ['/embed/movie/550', 'https://def.com/embed/movie/550'],
    ['/embed/tv/1399/1/3', 'https://def.com/embed/tv/1399/1/3'],
    ['/player?id=550&type=movie', 'https://def.com/player?id=550&type=movie'],
    ['/search?q=dune&page=2', 'https://def.com/search?q=dune&page=2'],
    ['/a/b/c/d/', 'https://def.com/a/b/c/d/'],
  ];
  for (const [path, expected] of cases) {
    const res = await call(path, 'abc.com');
    assert.equal(res.status, 301, `${path} must redirect`);
    assert.equal(res.location, expected, `${path} must keep its path and query`);
  }

  // HEAD is redirected too, with no body.
  assert.equal((await call('/embed/movie/550', 'abc.com', 'HEAD')).status, 301);

  // Exemptions.
  assert.equal((await call('/api/v1/health', 'abc.com')).status, 200, '/api must keep working');
  assert.equal((await call('/api/v1/playback?type=movie&tmdb=550', 'abc.com')).location, null);
  assert.equal((await call('/roxy', 'abc.com')).status, 200, '/roxy must stay reachable on the old host');

  // The new domain serves instead of redirecting to itself.
  assert.equal((await call('/embed/movie/550', 'def.com')).status, 200, 'the new domain must not loop');
  assert.equal((await call('/embed/movie/550', 'def.com:443')).status, 200, 'a port in Host must not defeat the comparison');
});

// A port in the target is compared correctly too.
await withServer('http://def.com:8080', async (call) => {
  assert.equal((await call('/', 'abc.com')).location, 'http://def.com:8080/');
  assert.equal((await call('/', 'def.com:8080')).status, 200, 'the target with its port must not loop');
});

// ---- Framed navigations are never redirected ------------------------------
// Measured in Chromium: an iframe navigated through a cross-origin 301 reports
// document.fullscreenEnabled === false and refuses requestFullscreen with
// "Disallowed by permissions policy". The same iframe loaded directly reports
// true. So redirecting a framed request silently costs every embed its
// fullscreen button - which is exactly the bug operators reported. The player
// has to be served in place when it is framed.
await withServer('https://def.com', async (call) => {
  // Same URL, same host - only the fetch destination differs.
  const framed = await call('/embed/movie/550', 'abc.com', 'GET', { 'sec-fetch-dest': 'iframe' });
  assert.equal(framed.status, 200, 'a framed navigation must be served, not redirected');
  assert.equal(framed.location, null);

  const topLevel = await call('/embed/movie/550', 'abc.com', 'GET', { 'sec-fetch-dest': 'document' });
  assert.equal(topLevel.status, 301, 'a top-level navigation still moves to the new domain');
  assert.equal(topLevel.location, 'https://def.com/embed/movie/550');

  // A browser too old to send Sec-Fetch-Dest still gets redirected; there is no
  // honest way to tell it apart from a top-level load.
  const legacy = await call('/embed/movie/550', 'abc.com');
  assert.equal(legacy.status, 301);
});

// Off by default.
await withServer('', async (call) => {
  assert.equal((await call('/embed/movie/550', 'abc.com')).status, 200, 'no setting means no redirect');
});

console.log('redirect: ok');
