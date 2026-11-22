/**
 * The deployed Cloudflare Worker, executed for real
 * =================================================
 * `cloudflare-worker/worker.js` runs on Cloudflare, not here, so nothing else in
 * this repo would ever execute it. It shipped once with three bugs that only
 * appear at runtime, and every one of them would have looked like "the relay is
 * broken" to an operator with no way to see why:
 *
 *   1. ANY value of ALLOWED_HOSTS silently disabled the SSRF guard, so a request
 *      for http://169.254.169.254/latest/meta-data/ was fetched and answered with
 *      a 401 from the cloud metadata service. A relay that can be aimed at
 *      link-local addresses is a weapon, not a proxy.
 *   2. `fail()` copied its message into the x-elfura-error header verbatim. Header
 *      values are ByteStrings, so the em-dash/arrow in "Settings → Variables"
 *      made the Worker throw instead of reporting the problem.
 *   3. A browser visit answered 403 "Bad or missing x-elfura-token", which reads
 *      like a broken deploy when the Worker is in fact fine.
 *
 * The module is imported as a data: URL so the real file is what runs, and a
 * fetch shim maps public-looking hostnames onto local servers, because the guard
 * under test is precisely "is this a real hostname" and 127.0.0.1 must stay a
 * refusal.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

const provider = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/final' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      path: req.url,
      ua: req.headers['user-agent'] || '',
      sec: req.headers['sec-ch-ua'] || '',
      accept: req.headers.accept || '',
    }),
  );
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerPort = provider.address().port;

const echo = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('198.51.100.9\n');
});
await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
const echoPort = echo.address().port;

// Hostnames the Worker is allowed to reach, pointed at local servers.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return realFetch(input, init);
  }
  if (url.hostname === 'provider.test' || url.hostname === 'greyboxtv.duckdns.org') return realFetch(`http://127.0.0.1:${providerPort}${url.pathname}${url.search}`, init);
  if (url.hostname === 'ip.test') return realFetch(`http://127.0.0.1:${echoPort}/`, init);
  return realFetch(input, init);
};

const source = fs.readFileSync(new URL('../../cloudflare-worker/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const TOKEN_ENV = { TOKEN: 'good-token', ALLOWED_HOSTS: 'provider.test,ip.test' };

async function call(headers, env = TOKEN_ENV, method = 'GET') {
  const response = await worker.fetch(new Request('https://relay.example/', { method, headers }), env);
  return { status: response.status, headers: response.headers, body: await response.text() };
}
const asJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 80) };
  }
};

try {
  // ---- identity ------------------------------------------------------------
  const landing = await call({ accept: 'text/html' });
  assert.equal(landing.status, 200, 'opening the Worker URL in a browser must show a help page, not a 403');
  assert.match(landing.body, /Elfura egress relay/);

  // ---- the gate ------------------------------------------------------------
  const noToken = await call({ 'x-elfura-target': 'https://provider.test/x' });
  assert.equal(noToken.status, 403);
  assert.match(asJson(noToken.body).error, /x-elfura-token/);

  const wrongToken = await call({ 'x-elfura-target': 'https://provider.test/x', 'x-elfura-token': 'nope' });
  assert.equal(wrongToken.status, 403);

  const bare = await call({ 'x-elfura-target': 'https://provider.test/x', 'x-elfura-token': 'good-token' }, {});
  assert.equal(bare.status, 500, 'a Worker with no TOKEN secret refuses to act as an open relay');
  assert.match(asJson(bare.body).error, /TOKEN/, 'and says so in a header-safe message');

  // ---- a real relay --------------------------------------------------------
  const relayed = await call({
    'x-elfura-target': 'https://provider.test/api?q=1',
    'x-elfura-token': 'good-token',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="124"',
    accept: 'application/json',
  });
  assert.equal(relayed.status, 200);
  const seen = asJson(relayed.body);
  assert.match(seen.ua, /Chrome\/124/, 'the browser fingerprint the provider sees is the one Elfura sent');
  assert.equal(seen.sec, '"Chromium";v="124"', 'client hints survive the hop');
  assert.match(seen.accept, /application\/json/, 'accept survives the hop');
  assert.equal(seen.path, '/api?q=1', 'the query string survives verbatim');

  // ---- redirects -----------------------------------------------------------
  const redirected = await call({
    'x-elfura-target': 'https://provider.test/redirect',
    'x-elfura-token': 'good-token',
    'user-agent': 'Chrome/124',
  });
  assert.equal(redirected.status, 200);
  assert.equal(asJson(redirected.body).path, '/final');
  // The header is URI-encoded and reports whatever URL the upstream settled on:
  // here the fetch shim rewrites provider.test to a local port, so assert on the
  // path rather than the hostname.
  const settled = decodeURIComponent(redirected.headers.get('x-elfura-url') || '');
  assert.match(settled, /\/final$/, 'the settled URL is reported so the adapters can read res.url');

  // Source 25 works with a default Worker, without opening all of DuckDNS.
  const greybox = await call({
    'x-elfura-target': 'https://greyboxtv.duckdns.org/api/player/sources?media=tv&id=71446&season=1&episode=1',
    'x-elfura-token': 'good-token',
  }, { TOKEN: 'good-token' });
  assert.equal(greybox.status, 200, 'the default relay allows the Source 25 API');
  assert.match(asJson(greybox.body).path, /^\/api\/player\/sources\?/);
  for (const hostname of ['other.duckdns.org', 'greyboxtv.duckdns.org.evil.example']) {
    const denied = await call({ 'x-elfura-target': `https://${hostname}/`, 'x-elfura-token': 'good-token' }, { TOKEN: 'good-token' });
    assert.equal(denied.status, 403, 'the Greybox exception must not allow other hosts');
  }

  // ---- the address guard, whatever ALLOWED_HOSTS says ----------------------
  const blocked = await call({ 'x-elfura-target': 'https://evil.example/x', 'x-elfura-token': 'good-token' });
  assert.equal(blocked.status, 403, 'a host outside the allowlist is refused');

  for (const [label, target] of [
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1/'],
    ['private range', 'http://10.0.0.5/'],
    ['ipv6 loopback', 'http://[::1]/'],
    ['internal suffix', 'http://metadata.google.internal/'],
    ['cloudflare worker', 'http://other.workers.dev/'],
  ]) {
    for (const env of [TOKEN_ENV, { TOKEN: 'good-token', ALLOWED_HOSTS: '*' }]) {
      const refused = await call({ 'x-elfura-target': target, 'x-elfura-token': 'good-token' }, env);
      assert.equal(refused.status, 403, `${label} must be refused even with ALLOWED_HOSTS=${env.ALLOWED_HOSTS}`);
      assert.match(asJson(refused.body).error, /Refusing/, `${label} must say why`);
    }
  }

  // ---- the IP echo reports the Worker's address ----------------------------
  const probe = await call({ 'x-elfura-target': 'https://ip.test/', 'x-elfura-token': 'good-token' });
  assert.equal(probe.status, 200);
  assert.match(probe.body, /198\.51\.100\.9/, 'the probe body is an address the panel can display');

  // ---- unsupported protocol -------------------------------------------------
  const badScheme = await call({ 'x-elfura-target': 'ftp://provider.test/x', 'x-elfura-token': 'good-token' });
  assert.equal(badScheme.status, 400);

  // ---- CORS preflight -------------------------------------------------------
  const preflight = await call({}, TOKEN_ENV, 'OPTIONS');
  assert.equal(preflight.status, 204, 'a preflight needs no token');

  console.log('✓ Worker: token gate, browser fingerprint survives the hop, redirects reported, SSRF guard holds under ALLOWED_HOSTS=*');
} finally {
  await Promise.all([
    new Promise((resolve) => provider.close(resolve)),
    new Promise((resolve) => echo.close(resolve)),
  ]);
}
