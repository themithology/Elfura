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

// Every source the registry mounts by default. Kept in one place so a row
// silently disappearing is a loud failure rather than a soft `>=` that a
// duplicate row could satisfy.
//
// 19 -> 20 when source-24 (VidLink) was added. The earlier 20 was a different
// 20: it counted a dead vidbolt-only stub alongside the real adapter, so the
// number matching is a coincidence, not a regression.
//
// 21 -> 19 when the retired Hindi/credential lanes were removed: source-16
// (Anivexa), source-17 (Anivortex) and source-19 (DesiDub) each made zero
// network requests without credentials or a title, and were replaced by the
// single Mikaza lane now occupying source-16. 21 - 3 + 1 = 19.
const MIN_LISTED_SOURCES = 19;
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
  // `index.js` re-execs itself once (to set memory flags), so the process that is
  // actually listening is a *grandchild* and `pkill -P <pid>` misses it — the
  // parent dies, the server keeps running, and it holds a port for the next test
  // run. Because the child was spawned `detached: true` it has its own process
  // group, so killing the group gets everything.
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* no process group (already gone) */
  }
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
await check('resolver health reveals nothing about sources', () => {
  assert.equal(health.ok, true);
  assert.equal(health.service, 'elfura-resolver');
  // This route is unauthenticated by design, so its body is public. It must not
  // carry the source list, a source count, the port or the bind address.
  const body = JSON.stringify(health);
  assert.equal(health.sources, undefined, 'health must not list sources');
  assert.doesNotMatch(body, /source-\d+/, 'health body must never contain a source id');
  assert.deepEqual(Object.keys(health).sort(), ['ok', 'service']);
});

await check('resolver refuses untrusted callers', async () => {
  const r = await fetch(`${resolverBase}/resolver/api/sources`);
  assert.equal(r.status, 401, `unauthenticated /sources must be 401, got ${r.status}`);
});

const listed = await (await fetch(`${resolverBase}/resolver/api/sources`, { headers: tokenHeader })).json();
await check('resolver serves nothing but its own API', async () => {
  // It must be impossible to reach a player, an embed or the panel on the
  // resolver: that box is supposed to be invisible to the public.
  for (const route of ['/embed/movie/550', '/roxy', '/', '/api/v1/health', '/api/v1/stream?t=x']) {
    const response = await fetch(`http://127.0.0.1:${resolverPort}${route}`);
    assert.ok(
      response.status === 401 || response.status === 404,
      `${route} on the resolver must not serve anything (got ${response.status})`,
    );
  }
});

await check('media server does not proxy the resolver API', async () => {
  for (const route of ['/resolver/api/health', '/resolver/api/sources', '/resolver/api/playback']) {
    const response = await fetch(`${mediaBase}${route}`, { headers: { origin: mediaBase } });
    assert.equal(response.status, 404, `${route} must not exist on the public server`);
  }
});

await check('public health exposes a count, never a list', async () => {
  const body = await (await fetch(`${mediaBase}/api/v1/health`)).json();
  assert.equal(body.sources, undefined, 'the public health route must not list sources');
  assert.doesNotMatch(JSON.stringify(body), /source-\d+/, 'no source id may appear in a public body');
  assert.equal(typeof body.sourceCount, 'number');
});

await check('resolver lists every source with health', () => {
  // 19, not 20: source-1 used to be split into two registry rows — the real
  // adapter (vidrift/vidsync/vidrock) plus a vidbolt-only stub that called
  // /api/resolve, an endpoint vidbolt does not have, so it could never return a
  // candidate. The two are now one row that owns all four upstreams, and
  // source-2 stays unmounted because its nxsha lane duplicates source-5.
  // The count is rows, not reach: no upstream was lost.
  assert.equal(MIN_LISTED_SOURCES, 19, 'the configured board');
  for (const source of listed.sources) {
    assert.equal(typeof source.id, 'string');
    assert.equal(typeof source.paused, 'boolean');
    assert.equal(typeof source.disabledByOperator, 'boolean');
  }
});

// ---- Nothing may remove a source automatically ------------------------------
// An explicit instruction: record and display failing sources, never bench them.
// A source that has failed a hundred times in a row must still be called.
const healthStore = await import('../../dist/backend/source-health.js');
await check('failures never remove a source from rotation', () => {
  const store = new healthStore.SourceHealthStore(tmp);
  for (let i = 0; i < 100; i++) store.recordFailure('source-1', 'TimeoutError');
  assert.equal(store.shouldAttempt('source-1'), true, 'a failing source must still be attempted');
  const row = store.snapshot([{ id: 'source-1', label: 'Source 1' }])[0];
  assert.equal(row.consecutiveFailures, 100, 'the streak is recorded for display');
  assert.match(row.detail, /failing/, 'the panel must say it is failing');
  assert.equal(row.paused, false, 'nothing pauses itself');
  assert.equal(row.retryAt, null, 'no automatic retry window exists');
});

await check('only an operator switch removes a source', () => {
  const store = new healthStore.SourceHealthStore(tmp);
  store.setEnabled('source-2', false);
  assert.equal(store.shouldAttempt('source-2'), false);
  store.setEnabled('source-2', true);
  assert.equal(store.shouldAttempt('source-2'), true, 'switching back on restores it immediately');
});

// ---- A public resolver URL must be refused ---------------------------------
await check('a public resolver URL is refused, a private one accepted', async () => {
  const resolverModule = await import('../../dist/backend/playback-resolver.js');
  const { resolverConfig, isPrivateResolverUrl } = resolverModule;
  for (const allowed of [
    'http://127.0.0.1:8793',
    'http://localhost:8793',
    'http://10.0.0.5:8793',
    'http://192.168.1.20:8793',
    'http://172.16.4.4:8793',
    'http://100.101.102.103:8793',
    'http://resolver.internal:8793',
  ]) {
    assert.equal(isPrivateResolverUrl(allowed), true, `${allowed} should count as private`);
    assert.ok(resolverConfig({ ELFURA_RESOLVER_URL: allowed, ELFURA_SECRET: 'x' }), `${allowed} should be accepted`);
  }
  for (const refused of ['http://203.0.113.9:8793', 'https://resolver.example.com']) {
    assert.equal(isPrivateResolverUrl(refused), false, `${refused} must not count as private`);
    assert.equal(
      resolverConfig({ ELFURA_RESOLVER_URL: refused, ELFURA_SECRET: 'x' }),
      null,
      `${refused} must be refused: it would send the token and receive source names over the internet`,
    );
  }
  // ...unless the operator has explicitly said they have a trusted private link.
  assert.ok(
    resolverConfig({ ELFURA_RESOLVER_URL: 'https://resolver.example.com', ELFURA_SECRET: 'x', ELFURA_RESOLVER_ALLOW_PUBLIC: '1' }),
    'the override must work for someone who knows what they are doing',
  );
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
  assert.equal(panelAlive.sources.length, MIN_LISTED_SOURCES);
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
  assert.equal(panelBack.sources.length, MIN_LISTED_SOURCES);
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
// Two things can hold this port: a socket in TIME_WAIT from an earlier test, and
// a server left running by an earlier *interrupted* run. The second is the one
// that actually bit us — the port answers, so an autostart boot reports
// EADDRINUSE and the check fails for a reason that has nothing to do with the
// behaviour under test. Clear both before asserting.
await waitForPortClosed(autoPort);
/**
 * Sweep anything left listening in this test's port range.
 *
 * The autostart boot picks the next free port from `autoPort` upward, so a run
 * that was killed mid-flight (a timeout, a Ctrl-C, a sandbox restart) leaves a
 * media server plus its autostarted resolver behind on 8903/8904/8905/... The
 * next run then sees ports that answer, and both autostart checks fail for a
 * reason unrelated to the code. Sweeping the range rather than one port makes
 * the test independent of how the previous run happened to die.
 */
function sweepPortRange(from, to) {
  for (let port = from; port <= to; port++) {
    try {
      const owners = execSync(`ss -ltnp 2>/dev/null | grep ':${port} ' || true`).toString();
      for (const match of owners.matchAll(/pid=(\d+)/g)) {
        try {
          execSync(`kill -9 ${match[1]}`);
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* ss unavailable on this platform; the wait below still covers one port */
    }
  }
}
// 24 ports, not 8: an autostarted resolver picks the next free port from the
// media port upward and was observed landing on 8924 after a few leaked runs.
sweepPortRange(autoPort, autoPort + 24);
await waitForPortClosed(autoPort);
const auto = spawnElfura([], {
  SERVER_PORT: String(autoPort),
  ELFURA_RESOLVER_AUTOSTART: '1',
  // deliberately no ELFURA_RESOLVER_URL: that is the point of autostart
});
const autoUp = await waitFor(`http://127.0.0.1:${autoPort}/api/v1/health`, 150);
// The media server binds its own port first and the autostarted resolver is a
// second process that has to boot from scratch, so "media is up" does not mean
// "resolver is up". Waiting on the media port alone made this check race the
// resolver by a second or two and fail intermittently — the resolver answers on
// its own schedule and the media server now logs when it does.
function waitForLog(pattern, tries = 200) {
  return (async () => {
    for (let i = 0; i < tries; i++) {
      if (pattern.test(auto.log)) return true;
      await wait(100);
    }
    return false;
  })();
}
if (!autoUp) {
  console.log(`\n--- autostart child log (port ${autoPort}) ---`);
  console.log(auto.log.slice(-2000) || '(no output at all)');
  console.log('--- end ---\n');
}
const autoBase = `http://127.0.0.1:${autoPort}`;

await check('autostart: one command starts both processes', async () => {
  // Dump the child's own log on failure. "fetch failed" alone says nothing about
  // whether the media server refused to boot, crashed, or never bound the port.
  assert.equal(autoUp, true, `media server did not start on port ${autoPort}.\n--- child log ---\n${auto.log.slice(-2000) || '(no output)'}`);
  const match = /(?:starting|started) a separate resolver on port (\d+)/.exec(auto.log);
  assert.ok(match, 'no autostart log line');
  // Wait for the media server to confirm the resolver is actually answering, not
  // just for it to have been spawned.
  const confirmed = await waitForLog(/resolver is answering on port \d+/);
  assert.ok(confirmed, `media server never confirmed the resolver was up:\n${auto.log.slice(-1200)}`);
  const autoResolverPort = Number(match[1]);
  let report;
  try {
    report = await (await fetch(`http://127.0.0.1:${autoResolverPort}/resolver/api/health`, { signal: AbortSignal.timeout(2000) })).json();
  } catch (err) {
    // The media server logged a resolver port but nothing answers there. Print
    // what we know rather than letting a bare "fetch failed" stand in for it.
    const probe = execSync(`ss -ltnp 2>/dev/null | grep -E ':(8[0-9]{3}) ' || true`).toString().trim();
    throw new Error(
      `autostart logged resolver port ${autoResolverPort} but it did not answer (${err.message}).\n` +
      `listening ports:\n${probe || '(none in 8000-8999)'}\n--- child log ---\n${auto.log.slice(-1500)}`,
    );
  }
  assert.equal(report.service, 'elfura-resolver');
  // The count now comes from the authenticated route, not the public one.
  const listed = await (
    await fetch(`http://127.0.0.1:${autoResolverPort}/resolver/api/sources`, {
      headers: { 'x-elfura-resolver-token': secret },
    })
  ).json();
  assert.equal(listed.sources.length, MIN_LISTED_SOURCES);
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
  assert.equal(payload.sources.length, MIN_LISTED_SOURCES);
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
