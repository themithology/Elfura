// A crash must not be permanent.
//
// Two independent guarantees, both of which the panel depends on:
//
//   1. one bad request cannot kill the process - the HTTP handler is wrapped,
//      so an unexpected throw answers 500 and the server keeps serving;
//   2. kept as the last resort, an unhandled rejection or uncaught exception in
//      background work (an adapter's fire-and-forget timer, a socket callback)
//      is logged instead of terminating Node.
//
// Both were broken before: the handler was async with no try/catch, and Node
// treats an unhandled rejection as fatal, so a single unexpected throw took the
// whole service down and the panel showed it as offline until a human noticed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createBackendServer, installProcessGuards } from '../../dist/backend/index.js';

const secret = crypto.createHash('sha256').update('crash-resilience').digest();
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
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const headers = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/137.0.0.0 Safari/537.36' };

const status = async (path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
  await res.text().catch(() => {});
  return res.status;
};

assert.equal(await status('/api/v1/health'), 200, 'server is up before the abuse starts');

// Inputs chosen to reach deep code paths with wrong types: none may 5xx the
// process, and every one must produce some status.
const abusive = [
  '/api/v1/playback?type=tv&tmdb=abc&s=x&e=y',
  '/api/v1/playback?type=movie&tmdb=' + '9'.repeat(400),
  '/api/v1/episodes?tmdb=%',
  '/api/v1/episodes?tmdb=..%2F..%2Fetc',
  '/api/v1/stream?t=%%%',
  '/api/v1/stream',
  '/api/v1/art?tmdb=' + '9'.repeat(300),
  '/api/v1/segments?tmdb=1&s=-1&e=0',
  '/embed/tv/1/0/0',
  '/embed/movie/%00',
];
for (const path of abusive) {
  const code = await status(path);
  assert(code > 0 && code < 600, `${path} must answer with a status, got ${code}`);
}

// The process is still alive and serving: this is the whole point.
assert.equal(await status('/api/v1/health'), 200, 'the process survived a burst of malformed requests');

// Guards are idempotent - registering twice must not double-handle or throw.
installProcessGuards();
installProcessGuards();

// An unhandled rejection in background work must not be fatal. If this were
// still fatal the process would exit here and the assertion below would never
// run, which is exactly the failure being prevented.
void Promise.reject(new Error('simulated background rejection'));
await new Promise((resolve) => setTimeout(resolve, 250));
assert.equal(await status('/api/v1/health'), 200, 'an unhandled rejection did not kill the server');

// And a thrown exception from a timer, the shape an adapter's fire-and-forget
// work takes.
setTimeout(() => {
  throw new Error('simulated background exception');
}, 10);
await new Promise((resolve) => setTimeout(resolve, 250));
assert.equal(await status('/api/v1/health'), 200, 'an uncaught exception did not kill the server');

server.close();
console.log('crash resilience: ok');
