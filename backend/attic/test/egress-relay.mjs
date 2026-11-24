/**
 * The Cloudflare Worker relay path
 * ================================
 * A relay exists to make a provider see a browser-shaped request from Cloudflare's
 * address instead of a bare Node request from the container's address. So this
 * test asserts the two things that make it work and are easy to lose:
 *
 *   1. the token and the browser profile both reach the Worker (the bug found
 *      while writing this: only x-elfura-* headers were sent, so undici filled in
 *      `user-agent: undici` and the provider was told it was a bot)
 *   2. `res.url` still reports the URL a redirect settled on, because six adapter
 *      call sites depend on `res.url || fallback`
 *
 * Plus the failure behaviour, which is what an operator actually hits: a wrong
 * token must not be retried forever, and a dead relay must not add a timeout to
 * every source probe.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'relay-test-token';
const seen = [];
// The real Worker is a separate process and does not share Elfura's global fetch.
const workerFetch = globalThis.fetch;

// The "provider": answers, redirects once, and reports what it was told.
const provider = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { location: '/final' });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ path: req.url, ua: req.headers['user-agent'] || '', accept: req.headers.accept || '' }));
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerPort = provider.address().port;

// The "Worker": mirrors worker.js — token check, then fetch the target.
const worker = http.createServer(async (req, res) => {
  const target = req.headers['x-elfura-target'];
  seen.push({
    target,
    token: req.headers['x-elfura-token'] || '',
    ua: req.headers['user-agent'] || '',
    accept: req.headers.accept || '',
  });
  if (req.headers['x-elfura-token'] !== TOKEN) {
    res.writeHead(403, { 'x-elfura-error': 'Bad or missing x-elfura-token' });
    res.end('{}');
    return;
  }
  if (!target) {
    res.writeHead(400, { 'x-elfura-error': 'Missing x-elfura-target header' });
    res.end('{}');
    return;
  }
  try {
    // Model a Greybox API reachable only through this separate Worker.
    if (new URL(target).hostname === 'greyboxtv.duckdns.org') {
      await new Promise((resolve) => setTimeout(resolve, 30));
      res.writeHead(200, { 'content-type': 'application/json', 'x-elfura-url': encodeURIComponent(target) });
      res.end(JSON.stringify({ sources: [{ url: 'https://cdn.example.com/episode.m3u8', type: 'hls', language: 'en' }] }));
      return;
    }
    const upstream = await workerFetch(target, {
      method: req.headers['x-elfura-method'] || 'GET',
      headers: { 'user-agent': req.headers['user-agent'] || 'relay', accept: req.headers.accept || '*/*' },
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = {};
    for (const [name, value] of upstream.headers) {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name)) headers[name] = value;
    }
    headers['x-elfura-url'] = encodeURIComponent(upstream.url);
    res.writeHead(upstream.status, headers);
    res.end(body);
  } catch (error) {
    res.writeHead(502, { 'x-elfura-error': String(error.message) });
    res.end('{}');
  }
});
await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve));
const workerUrl = `http://127.0.0.1:${worker.address().port}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elfura-relay-'));
process.env.ROXY_DATA_DIR = dataDir;
delete process.env.ELFURA_UPSTREAM_RELAY;
delete process.env.ELFURA_RELAY_TOKEN;
delete process.env.ELFURA_UPSTREAM_PROXY;
delete process.env.ELFURA_EGRESS_PROFILE;

const { currentRelayUrl, readRelayToken, saveRelayUrl, relayConfigPath } = await import('../../../dist/backend/relay-config.js');
const { installEgressProfile, relayStatus, reportRelayProbe } = await import('../../../dist/backend/egress.js');

try {
  // ---- storage -------------------------------------------------------------
  assert.equal(currentRelayUrl(), '', 'no relay configured until one is saved');
  assert.equal(saveRelayUrl(workerUrl, TOKEN), true);
  assert.equal(currentRelayUrl(), workerUrl, 'the saved URL is the one in force');
  assert.equal(readRelayToken(), TOKEN);
  const mode = fs.statSync(relayConfigPath()).mode & 0o777;
  assert.equal(mode, 0o600, 'a file holding the Worker token is private');

  // Re-saving only the URL must not wipe the token.
  assert.equal(saveRelayUrl(workerUrl + '/'), true);
  assert.equal(readRelayToken(), TOKEN, 'fixing the URL keeps the existing token');
  assert.equal(currentRelayUrl(), workerUrl, 'a trailing slash is removed');

  // ---- the relay path ------------------------------------------------------
  const lines = [];
  await installEgressProfile((line) => lines.push(line));
  assert.match(lines.join(' | '), /via relay/, 'the boot line names the relay');

  const first = await fetch(`http://127.0.0.1:${providerPort}/hello`);
  const firstBody = JSON.parse(await first.text());
  assert.equal(first.status, 200);
  assert.equal(seen.length, 1, 'a clean request goes through the Worker, not around it');
  assert.equal(seen[0].token, TOKEN, 'the Worker receives the token');
  assert.match(seen[0].ua, /Chrome\/124/, 'the browser profile reaches the Worker, not undici');
  assert.doesNotMatch(seen[0].ua, /undici/, 'Node is not the fingerprint the provider sees');
  assert.match(seen[0].accept, /application\/json/, 'accept is the browser one');
  assert.match(firstBody.ua, /Chrome\/124/, 'and the provider sees it too');
  assert.equal(relayStatus().successes, 1, 'one request, one relayed fetch');

  // ---- redirects ----------------------------------------------------------
  const redirected = await fetch(`http://127.0.0.1:${providerPort}/redirect`);
  const redirectedBody = JSON.parse(await redirected.text());
  assert.equal(redirectedBody.path, '/final', 'the redirect was followed');
  assert.equal(
    redirected.url,
    `http://127.0.0.1:${providerPort}/final`,
    'res.url reports the settled URL, which the adapters read',
  );

  // ---- a wrong token is reported, not retried forever ----------------------
  saveRelayUrl(workerUrl, 'wrong-token');
  const before = relayStatus().attempts;
  await fetch(`http://127.0.0.1:${providerPort}/hello`).catch(() => {});
  assert.ok(relayStatus().attempts > before, 'the relay was attempted');
  assert.equal(relayStatus().successes, 2, 'a rejected token is not counted as a success (only the two good requests are)');

  saveRelayUrl(workerUrl, TOKEN);

  // All concurrent provider requests must go through the relay, including a
  // Source 25 lookup started while other providers' relay requests are pending.
  const beforeConcurrent = seen.length;
  const parallel = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    fetch(`http://127.0.0.1:${providerPort}/parallel-${i}`).then(async (res) => {
      assert.equal(res.status, 200);
      return res.json();
    }),
  ));
  assert.equal(parallel.length, 12);
  const targets = seen.slice(beforeConcurrent).map((entry) => new URL(entry.target).pathname);
  assert.equal(targets.length, 12, 'no simultaneous discovery request bypasses the relay');
  for (let i = 0; i < 12; i += 1) assert.ok(targets.includes(`/parallel-${i}`));

  const { createSource25Adapter } = await import('../../../dist/backend/sources/source25.js');
  const greybox = createSource25Adapter({ enabled: true, origin: 'https://greyboxtv.duckdns.org', timeoutMs: 5000, rank: 50 });
  const greyboxStart = seen.length;
  const [firstGreybox, secondGreybox] = await Promise.all([
    greybox.resolve({ type: 'tv', tmdbId: '71446', season: 1, episode: 1 }),
    greybox.resolve({ type: 'tv', tmdbId: '71446', season: 1, episode: 1 }),
  ]);
  assert.equal(firstGreybox.candidates.length, 1);
  assert.equal(secondGreybox.candidates.length, 1);
  assert.equal(seen.slice(greyboxStart).filter(({ target }) => new URL(target).hostname === 'greyboxtv.duckdns.org').length, 2,
    'both simultaneous Greybox lookups are actually relayed');

  // ---- a manual probe never pauses ----------------------------------------
  for (let i = 0; i < 5; i += 1) reportRelayProbe(false, '', 0, 'Bad or missing x-elfura-token');
  assert.equal(relayStatus().pausedUntil, 0, 'pressing Test relay with a wrong token must not disable the relay');
  assert.match(relayStatus().lastError, /token/, 'but the reason is remembered for the panel');

  // ---- real traffic failing three times does pause -------------------------
  saveRelayUrl('http://127.0.0.1:1', TOKEN); // nothing listens there
  for (let i = 0; i < 3; i += 1) await fetch(`http://127.0.0.1:${providerPort}/hello`).catch(() => {});
  assert.ok(relayStatus().pausedUntil > Date.now(), 'a dead relay rests instead of adding a timeout to every probe');
  // Check the pause BEFORE restoring the working URL: saving a new URL is the
  // operator saying "I fixed it", which deliberately clears the pause.
  const pausedAt = relayStatus().attempts;
  const direct = await fetch(`http://127.0.0.1:${providerPort}/hello`);
  await direct.text();
  assert.equal(direct.status, 200, 'the request still succeeds by going direct');
  assert.equal(relayStatus().attempts, pausedAt, 'and does not dial the paused relay');

  saveRelayUrl(workerUrl, TOKEN);
  assert.equal(relayStatus().pausedUntil, 0, 'saving the URL again clears the pause');

  console.log('✓ relay: browser profile and token reach the Worker, res.url survives redirects, failures pause instead of stalling');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  await Promise.all([
    new Promise((resolve) => provider.close(resolve)),
    new Promise((resolve) => worker.close(resolve)),
  ]);
}
