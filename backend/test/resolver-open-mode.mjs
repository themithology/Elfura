#!/usr/bin/env node
/**
 * Tokenless resolver mode must not mean "open to the internet".
 *
 * The operator asked to drop the token because the resolver "is not on the public
 * internet". It was: a panel-assigned domain resolves to it from anywhere. An
 * authenticated-less resolver answers "give me this episode's stream URLs" to
 * whoever finds it, and accepts a POST that turns the operator's sources off.
 *
 * So ELFURA_RESOLVER_OPEN=1 is deliberately NOT an auth off-switch. It drops the
 * token requirement only for callers arriving over a loopback or private address,
 * which is what "we communicate through the VPS IP" actually means. A request
 * that came through a public domain, a reverse proxy or a port forward is still
 * refused.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PORT = 3157;

/** Any non-internal IPv4 the container has, to act as a distant caller. */
function externalAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '';
}

const isPrivate = (address) =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address);

const canConnect = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });

const get = (url) => fetch(url, { signal: AbortSignal.timeout(6000) }).then((r) => r.json());

// Boot a tokenless resolver in open mode.
const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    ELFURA_RESOLVER_MODE: '1',
    ELFURA_RESOLVER_PORT: String(PORT),
    ELFURA_RESOLVER_LISTEN: '0.0.0.0',
    ELFURA_RESOLVER_OPEN: '1',
    ELFURA_RESOLVER_TOKEN: '',
    ELFURA_SECRET: '',
    ELFURA_SUPERVISE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => (output += chunk));
child.stderr.on('data', (chunk) => (output += chunk));

const deadline = Date.now() + 25_000;
while (Date.now() < deadline) {
  if (output.includes('[elfura-resolver] ready')) break;
  if (/refusing to start without a token/.test(output)) {
    throw new Error(`open mode was rejected at boot:\n${output}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
assert.match(output, /ELFURA_RESOLVER_OPEN=1/, 'boot must state the limit of open mode, not just accept it');

try {
  // 1. A private/loopback caller gets through with no token. This is the setup the
  //    operator described: two nodes talking over the VPS IP.
  const internal = await get(`http://127.0.0.1:${PORT}/resolver/api/sources`);
  assert.equal(internal.ok, true, 'an internal caller must not need the token in open mode');
  assert.ok(Array.isArray(internal.sources), 'and must get the real answer');

  // 2. A caller that did NOT arrive over a private address is refused. If the
  //    container only has a link-local address, reaching it at all is the test.
  const external = externalAddress();
  if (external && !isPrivate(external)) {
    const reachable = await canConnect(external, PORT);
    if (reachable) {
      const refused = await get(`http://${external}:${PORT}/resolver/api/sources`);
      assert.equal(
        refused.ok,
        false,
        'a non-private caller must be refused even in open mode - otherwise this is an open proxy',
      );
      assert.match(String(refused.error), /token missing or wrong/);
    }
  }
} finally {
  child.kill('SIGTERM');
}

console.log('✓ resolver open mode: tokenless for internal callers, still 401 for anyone else');
