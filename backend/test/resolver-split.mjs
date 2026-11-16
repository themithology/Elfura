/**
 * Provider isolation regression test.
 *
 * The operator's request, in their words: "make the backend different than the
 * main player ... so that we never faced sources and streaming related issues."
 *
 * Provider scraping can be moved into a second process. That only helps if the
 * media server behaves correctly when that process is unhealthy, so this test
 * pins the four behaviours that matter:
 *
 *   1. A resolver that is not reachable is reported as an OUTAGE (503), never as
 *      "this title has no sources" (404). Telling a viewer their title has
 *      nothing, when the truth is that our scraper is down, sends them looking
 *      for a different title and hides a fault we need to see.
 *   2. Media serving never depends on the resolver. Health, the catalogue and
 *      the control panel keep answering while the resolver is dead.
 *   3. The control panel reports `unavailable: true` with `sources: null`, not an
 *      empty array — an empty list would read "you have no sources", the exact
 *      opposite of the truth.
 *   4. A resolver that answers "no streams" is an ANSWER, not an outage. Only
 *      transport errors and 5xx are outages; 4xx means the resolver is alive.
 *
 * The last point is the subtle one: it is easy to write a client that treats
 * every non-200 as "resolver down", and then every title that legitimately has
 * no streams looks like an outage.
 */
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const secret = 'resolver-split-test-secret';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elfura-split-test-'));
const resolverPort = 8901;
const mediaPort = 8902;
const cwd = path.resolve(import.meta.dirname, '../..');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a URL answers at all (any status). */
async function waitFor(url, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return true;
    } catch {
      await wait(200);
    }
  }
  return false;
}

/**
 * index.js supervises a memory-flagged child, so killing the supervisor alone
 * leaves the server running. A real operator stopping a service kills the tree,
 * and a test that only kills the parent would silently measure nothing.
 */
function killTree(pid) {
  try {
    execSync(`pkill -9 -P ${pid}`, { stdio: 'ignore' });
  } catch {
    /* no children */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

const baseEnv = {
  ...process.env,
  HOST: '127.0.0.1',
  ELFURA_SECRET: secret,
  ELFURA_SELF_TEST: '0',
  ROXY_DATA_DIR: tmp,
  ALLOWED_ORIGINS: '*',
  NODE_ENV: 'test',
};

const children = [];
function spawnElfura(args, extraEnv) {
  const child = spawn(process.execPath, ['index.js', ...args], {
    cwd,
    env: { ...baseEnv, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.log = '';
  child.stdout.on('data', (d) => (child.log += d));
  child.stderr.on('data', (d) => (child.log += d));
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children) killTree(child.pid);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Wait until nothing answers on a port, so a stale listener cannot fail a later boot. */
async function waitForPortClosed(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(300) });
      await wait(250); // something answered; give it time to go away
    } catch {
      return; // refused: the port is clear
    }
  }
}

const failures = [];
// Async on purpose: several checks await a fetch, and a sync helper would report
// "ok" for a promise that had not settled yet — a test that cannot fail.
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

let resolver = spawnElfura(['--resolver'], { ELFURA_RESOLVER_PORT: String(resolverPort) });
const resolverUp = await waitFor(`http://127.0.0.1:${resolverPort}/resolver/api/health`);
if (!resolverUp) {
  console.error('resolver did not start:\n' + resolver.log);
  cleanup();
  process.exit(1);
}

const media = spawnElfura([], {
  SERVER_PORT: String(mediaPort),
  ELFURA_RESOLVER_URL: `http://127.0.0.1:${resolverPort}`,
});
const mediaUp = await waitFor(`http://127.0.0.1:${mediaPort}/api/v1/health`);
if (!mediaUp) {
  console.error('media server did not start:\n' + media.log);
  cleanup();
  process.exit(1);
}

const mediaBase = `http://127.0.0.1:${mediaPort}`;
const resolverBase = `http://127.0.0.1:${resolverPort}`;
const tokenHeader = { 'x-elfura-resolver-token': secret };

console.log('\nProvider isolation');

// ---- The resolver is a real service with a real contract --------------------
const health = await (await fetch(`${resolverBase}/resolver/api/health`)).json();
await check('resolver reports itself by name', () => {
  assert.equal(health.ok, true);
  assert.equal(health.service, 'elfura-resolver');
  assert.ok(Array.isArray(health.sources) && health.sources.length >= 20, `expected >=20 sources, got ${health.sources?.length}`);
});

await check('resolver refuses untrusted callers', async () => {
  const r = await fetch(`${resolverBase}/resolver/api/sources`);
  assert.equal(r.status, 401, `unauthenticated /sources must be 401, got ${r.status}`);
});

const listed = await (await fetch(`${resolverBase}/resolver/api/sources`, { headers: tokenHeader })).json();
await check('resolver lists every source with health', () => {
  assert.ok(Array.isArray(listed.sources) && listed.sources.length >= 20);
  for (const source of listed.sources) {
    assert.equal(typeof source.id, 'string');
    assert.equal(typeof source.paused, 'boolean');
    assert.equal(typeof source.disabledByOperator, 'boolean');
  }
});

// ---- Sign in to the control panel -----------------------------------------
const login = await fetch(`${mediaBase}/roxy/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: mediaBase },
  body: JSON.stringify({ password: secret }),
});
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const panelHeaders = { cookie, origin: mediaBase };

const panelAlive = await (await fetch(`${mediaBase}/roxy/api/sources`, { headers: panelHeaders })).json();
await check('control panel shows per-source health', () => {
  assert.equal(panelAlive.unavailable, false);
  assert.ok(Array.isArray(panelAlive.sources) && panelAlive.sources.length >= 20);
  assert.equal(panelAlive.resolver.kind, 'remote', 'media server must be using the out-of-process resolver');
});

await check('control panel kill switch works', async () => {
  const off = await fetch(`${mediaBase}/roxy/api/sources`, {
    method: 'POST',
    headers: { ...panelHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'source-1', enabled: false }),
  });
  assert.equal(off.status, 200);
  const body = await off.json();
  const one = body.sources.find((s) => s.id === 'source-1');
  assert.equal(one.disabledByOperator, true);
  // and the resolver itself agrees
  const direct = await (await fetch(`${resolverBase}/resolver/api/sources`, { headers: tokenHeader })).json();
  assert.equal(direct.sources.find((s) => s.id === 'source-1').disabledByOperator, true);
});

// ---- A playback token, minted the way the player mints one ----------------
const embed = await fetch(`${mediaBase}/embed/movie/550`, { headers: { 'Sec-Fetch-Site': 'none' } });
const boot = JSON.parse(/window\.__ELFURA_BOOT__=(\{[^<]+\});/.exec(await embed.text())[1]);
const askPlayback = () =>
  fetch(`${mediaBase}/api/v1/playback?type=movie&tmdb=550&nonce=${boot.nonce}`, {
    headers: { origin: mediaBase, 'X-Playback-Token': boot.pltoken },
  });

const alive = await askPlayback();
await check('resolver alive: playback answers without an outage', () => {
  assert.ok([200, 404].includes(alive.status), `expected 200/404, got ${alive.status}`);
});

// ---- Kill the resolver -----------------------------------------------------
killTree(resolver.pid);
await wait(900);
const deadHealth = await fetch(`${resolverBase}/resolver/api/health`).then(
  (r) => `HTTP ${r.status}`,
  () => 'refused',
);
await check('resolver is really down', () => assert.equal(deadHealth, 'refused'));

const outage = await askPlayback();
const outageBody = await outage.json().catch(() => ({}));
await check('resolver down: playback is 503, not 404', () => {
  assert.equal(outage.status, 503, `a dead resolver must not look like "no streams" (got ${outage.status}: ${outageBody.error})`);
  assert.match(String(outageBody.error), /resolver/i);
});

await check('resolver down: media server keeps serving', async () => {
  const healthRes = await fetch(`${mediaBase}/api/v1/health`);
  assert.equal(healthRes.status, 200, 'health must not depend on the resolver');
  const page = await fetch(`${mediaBase}/roxy`);
  assert.equal(page.status, 200, 'the control panel is served by the media server and must stay up');
});

const panelDead = await (await fetch(`${mediaBase}/roxy/api/sources`, { headers: panelHeaders })).json();
await check('resolver down: panel says unavailable, not "no sources"', () => {
  assert.equal(panelDead.unavailable, true);
  assert.equal(panelDead.sources, null, 'an empty array would read as "you have no sources"');
  assert.equal(panelDead.resolver.reachable, false);
});

// ---- Bring it back: recovery must not need a media restart -----------------
resolver = spawnElfura(['--resolver'], { ELFURA_RESOLVER_PORT: String(resolverPort) });
await waitFor(`${resolverBase}/resolver/api/health`);

const panelBack = await (await fetch(`${mediaBase}/roxy/api/sources`, { headers: panelHeaders })).json();
await check('resolver back: panel recovers with no media restart', () => {
  assert.equal(panelBack.unavailable, false);
  assert.ok(panelBack.sources.length >= 20);
});

// source-1 has no health file after the restart, so the switch is fresh state.
const recovered = await askPlayback();
await check('resolver back: playback answers again', () => {
  assert.ok([200, 404].includes(recovered.status), `expected 200/404, got ${recovered.status}`);
});

// ---- Autostart: one command must give an operator both processes -----------
// Pterodactyl has a single startup command, so an isolation mode that needs two
// terminals is not usable there. ELFURA_RESOLVER_AUTOSTART must start the second
// process itself, and the media server must actually be using it.
cleanup();
await wait(400);
const autoPort = 8903;
// A socket left in TIME_WAIT from an earlier test would fail this for a reason
// unrelated to what it checks, so confirm the port is clear first.
await waitForPortClosed(autoPort);
const auto = spawnElfura([], {
  SERVER_PORT: String(autoPort),
  ELFURA_RESOLVER_AUTOSTART: '1',
  // deliberately no ELFURA_RESOLVER_URL: that is the point of autostart
});
const autoUp = await waitFor(`http://127.0.0.1:${autoPort}/api/v1/health`, 150);
const autoBase = `http://127.0.0.1:${autoPort}`;

await check('autostart: one command starts both processes', async () => {
  assert.equal(autoUp, true, `media server did not start:\n${auto.log.slice(-2000)}`);
  const match = /separate resolver on port (\d+)/.exec(auto.log);
  assert.ok(match, 'no autostart log line');
  const autoResolverPort = Number(match[1]);
  const report = await (await fetch(`http://127.0.0.1:${autoResolverPort}/resolver/api/health`)).json();
  assert.equal(report.service, 'elfura-resolver');
  assert.ok(report.sources.length >= 20);
});

await check('autostart: media server uses the resolver it started', async () => {
  const loginAuto = await fetch(`${autoBase}/roxy/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: autoBase },
    body: JSON.stringify({ password: secret }),
  });
  const autoCookie = (loginAuto.headers.get('set-cookie') || '').split(';')[0];
  const payload = await (
    await fetch(`${autoBase}/roxy/api/sources`, { headers: { cookie: autoCookie, origin: autoBase } })
  ).json();
  assert.equal(payload.unavailable, false);
  assert.equal(payload.resolver.kind, 'remote', 'autostart must actually isolate discovery, not silently stay in-process');
  assert.ok(payload.sources.length >= 20);
});

// An explicit ELFURA_RESOLVER_URL must win: an operator running a resolver
// separately must not get a duplicate fighting for the port.
const explicitPort = 8904;
const declarative = spawnElfura([], {
  SERVER_PORT: String(explicitPort),
  ELFURA_RESOLVER_AUTOSTART: '1',
  ELFURA_RESOLVER_URL: `http://127.0.0.1:${resolverPort}`,
});
await waitFor(`http://127.0.0.1:${explicitPort}/api/v1/health`);
await check('autostart yields to an explicit ELFURA_RESOLVER_URL', () => {
  assert.match(declarative.log, /not starting a second resolver/);
});

cleanup();
console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
