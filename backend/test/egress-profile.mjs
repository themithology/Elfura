/**
 * Automatic egress profile: no configuration, no proxy to buy.
 *
 * Production showed the pattern: with DNS finally working, several providers
 * answered 403 to this server while the same URL and headers answered 200 from a
 * different address. Cloudflare judges the request shape as well as the IP, and a
 * bare Node fetch is not what a player sends. So discovery requests leave with a
 * browser's header set over HTTP/1.1, and one silent retry with a plainer
 * fingerprint when the first attempt is refused. HTTP/2 is disabled because
 * Undici's GOAWAY recovery path is unstable under concurrent provider requests.
 *
 * This test proves: HTTP/1.1 browser-profile requests add headers, a 403 is
 * retried exactly once, and ranged media requests are left completely alone.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

const seen = [];
let refused = 0;

const server = http.createServer((req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url === '/refuse') {
    refused += 1;
    if (refused === 1) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('blocked');
      return;
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

process.env.ELFURA_EGRESS_PROFILE = 'browser';
const lines = [];
// Production constructs the registry (and its tap) before async egress setup.
const { installNetTap, tapRequests } = await import('../../dist/backend/sources/net-tap.js');
installNetTap();
const { installEgressProfile } = await import('../../dist/backend/egress.js');
const installed = await installEgressProfile((line) => lines.push(line));
assert.equal(installed, true, `the profile installs automatically (log: ${lines.join(' | ')})`);
assert.ok(lines.some((line) => line.includes('(HTTP/1.1, Chrome headers')), 'the deployed profile keeps unstable HTTP/2 disabled');

try {
  const tapped = await tapRequests(() => fetch(`http://127.0.0.1:${port}/plain`, { headers: { accept: 'application/json' } }));
  const ok = tapped.value;
  assert.equal(ok.status, 200);
  assert.equal(tapped.net.length, 1, 'tap sees discovery after the profile replaces global fetch');
  assert.equal(tapped.net[0].status, 200);
  const plain = seen.at(-1).headers;
  assert.ok(/Chrome\//.test(plain['user-agent'] ?? ''), 'a browser user-agent is present');
  assert.ok(plain['accept-language'], 'accept-language is present');
  assert.ok(plain['sec-fetch-mode'], 'browser fetch hints are present');
  assert.equal(plain.accept, 'application/json', 'an adapter\'s own accept header is never overwritten');

  const retried = await fetch(`http://127.0.0.1:${port}/refuse`);
  assert.equal(retried.status, 200, 'a 403 is retried instead of being handed to the adapter');
  assert.equal(refused, 2, 'exactly one retry was made');
  const second = seen.at(-1).headers;
  // undici adds its own sec-fetch-* headers; what must be gone are our hints.
  assert.equal(second['sec-ch-ua'], undefined, 'the retry drops the client hints');
  assert.ok(/Chrome\/131/.test(second['user-agent'] ?? ''), 'and a different browser version');

  // Media: ranged traffic must bypass the profile entirely.
  const before = seen.length;
  const tappedMedia = await tapRequests(() => fetch(`http://127.0.0.1:${port}/segment.ts`, { headers: { range: 'bytes=0-1023' } }));
  const media = tappedMedia.value;
  assert.equal(media.status, 200);
  assert.equal(tappedMedia.net.length, 1, 'nested old tap does not double count delegated media');
  assert.equal(seen.length, before + 1);
  const mediaHeaders = seen.at(-1).headers;
  assert.equal(mediaHeaders.range, 'bytes=0-1023', 'the range header survives');
  assert.equal(mediaHeaders['sec-ch-ua'], undefined, 'and media requests are not restyled');
  assert.ok(!/Chrome\//.test(mediaHeaders['user-agent'] ?? ''), 'nor given a browser agent');

  console.log('✓ egress profile: browser headers, one retry on 403, media untouched — no configuration');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
