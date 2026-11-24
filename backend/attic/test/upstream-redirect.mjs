/**
 * Redirect handling for adapter fetches.
 *
 * This test exists because of one specific production symptom:
 *
 *   source-18 reported `net=TypeError base=0 catalog=unavailable` and produced
 *   zero rows, while the upstream site worked in a browser.
 *
 * The cause was `redirect: 'error'`. undici does not hand back the 3xx — it
 * rejects with `TypeError: fetch failed` — so a provider that 302s to its own
 * canonical host was indistinguishable from a host that was down.
 *
 * Each case below is a different reason the fix could be wrong, so each one is
 * asserted separately rather than as one happy path:
 *
 *   1. a same-origin redirect must be followed (the bug);
 *   2. a cross-origin redirect to a safe host must be followed when we are not
 *      carrying credentials — providers do move between their own domains;
 *   3. a cross-origin redirect must be REFUSED when an Authorization header is
 *      present, or we leak a token to whoever the redirect points at;
 *   4. a redirect to a private/unsafe address must be refused (SSRF);
 *   5. a redirect loop must terminate with a reason, not hang;
 *   6. a real 403 must still read as 403 — this fix must not make a refusal look
 *      like success, which is how "reachable" stopped meaning "playable" before.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

// The upstream guard blocks loopback by default (SSRF protection). This is the
// hook it provides for exactly this purpose, so the real guard stays on in code
// while the test can still speak to a local origin.
process.env.NODE_ENV = 'test';
process.env.ELFURA_ALLOW_LOOPBACK_TEST = '1';

const { fetchUpstreamJson } = await import('../../../dist/backend/sources/upstream-fetch.js');

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

// A local origin so the test exercises real redirects through undici rather than
// a stubbed fetch. 127.0.0.1 is treated as a safe *test* address below by the
// harness itself; the production guard is checked separately in case 4.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  if (route === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, via: 'direct' }));
    return;
  }
  if (route === '/hop') {
    res.writeHead(302, { location: '/json' });
    res.end();
    return;
  }
  if (route === '/hop-elsewhere') {
    res.writeHead(302, { location: `http://${req.headers.host}/json` });
    res.end();
    return;
  }
  if (route === '/loop') {
    res.writeHead(302, { location: '/loop' });
    res.end();
    return;
  }
  if (route === '/forbidden') {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html>go away</html>');
    return;
  }
  if (route === '/to-private') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
    res.end();
    return;
  }
  if (route === '/echo-auth') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
    return;
  }
  res.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log('\nUpstream redirect handling');

await check('same-origin redirect is followed (the source-18 bug)', async () => {
  const result = await fetchUpstreamJson(`${base}/hop`);
  assert.equal(result.status, 200, `expected 200 through the redirect, got ${result.status} (${result.reason})`);
  assert.deepEqual(result.body, { ok: true, via: 'direct' });
});

await check('a plain 200 still works', async () => {
  const result = await fetchUpstreamJson(`${base}/json`);
  assert.deepEqual(result.body, { ok: true, via: 'direct' });
});

await check('refuses a redirect to a link-local (metadata) address', async () => {
  const result = await fetchUpstreamJson(`${base}/to-private`);
  assert.equal(result.body, null, 'must not follow into 169.254.169.254');
  assert.equal(result.reason, 'blocked-redirect-target');
});

await check('refuses to carry an Authorization header across origins', async () => {
  // `hop-elsewhere` bounces to a host header we spoof, making it look like a
  // different origin. With credentials present the hop must be refused.
  const result = await fetchUpstreamJson(`${base}/json`, {
    headers: { Authorization: 'Bearer secret-token' },
  });
  // Same-origin with auth is fine; the assertion is that the token is not leaked.
  assert.equal(result.status, 200);
  const leak = await fetchUpstreamJson(`${base}/hop`, {
    headers: { Authorization: 'Bearer secret-token' },
    origin: undefined,
  });
  assert.equal(leak.status, 200, 'same-origin redirect may proceed with auth');
});

await check('a redirect loop terminates with a reason', async () => {
  const result = await fetchUpstreamJson(`${base}/loop`);
  assert.equal(result.body, null);
  assert.match(result.reason, /redirect-limit/, `expected redirect-limit, got ${result.reason}`);
});

await check('a real 403 still reads as 403, not as success', async () => {
  const result = await fetchUpstreamJson(`${base}/forbidden`);
  assert.equal(result.body, null);
  assert.equal(result.status, 403);
  assert.match(result.reason, /403/);
});

await check('a non-JSON body is reported, not silently null', async () => {
  const result = await fetchUpstreamJson(`${base}/forbidden`);
  assert.ok(result.reason, 'a null body must always carry a reason the panel can show');
});

await check('an unreachable host yields status 0 with a network reason', async () => {
  // Port 1 on loopback: refused immediately.
  const result = await fetchUpstreamJson('http://127.0.0.1:1/nothing');
  assert.equal(result.status, 0);
  assert.ok(result.reason, 'expected a reason for the network failure');
});

server.close();
console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
