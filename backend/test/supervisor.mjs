// The packaged entrypoint (`index.js`, the file the panel starts) must keep the
// service alive by itself.
//
// Pterodactyl supervises the process it starts and cannot restart one that has
// already exited. So when the server died, the panel sat there showing it
// offline. The entrypoint now holds a supervising parent that re-spawns the
// worker whenever it exits unexpectedly.
//
// Covered here, using a real crash with no test hooks inside the product code:
//   * a worker that cannot bind its port exits, the supervisor retries, and
//     once the port is free the service comes up and answers requests;
//   * SIGTERM stops everything and leaves no survivor - a panel stop/restart
//     must not fight a resurrecting worker, and must not leak a stray process.
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = path.join(repo, 'index.js');
const port = 45300 + (process.pid % 200);

const waitFor = async (label, predicate, timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const listens = (p) =>
  new Promise((resolve) => {
    const probe = http.get({ host: '127.0.0.1', port: p, path: '/api/v1/health', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    probe.on('error', () => resolve(false));
    probe.on('timeout', () => {
      probe.destroy();
      resolve(false);
    });
  });

const ownPort = () =>
  new Promise((resolve) => {
    const blocker = http.createServer();
    blocker.listen(port, '0.0.0.0', () => resolve(blocker));
  });

// Occupy the port first, so the first worker attempts are guaranteed failures.
let blocker = await ownPort();

const supervisor = spawn(process.execPath, [entry], {
  cwd: repo,
  stdio: 'pipe',
  env: {
    ...process.env,
    ELFURA_PORT: String(port),
    PORT: String(port),
    ELFURA_HOST: '0.0.0.0',
    ELFURA_SECRET: crypto.randomBytes(24).toString('base64'),
    ELFURA_SELF_TEST: '0',
    ELFURA_RESOLVE_BUDGET_MS: '1500',
    RESOLVE_TIMEOUT_MS: '1500',
    // Keep the test off the public DNS rescue path.
    ELFURA_DNS_RESCUE: '0',
  },
});

let log = '';
supervisor.stdout.on('data', (chunk) => (log += chunk));
supervisor.stderr.on('data', (chunk) => (log += chunk));
let exited = null;
supervisor.on('exit', (code, signal) => (exited = { code, signal }));

const cleanup = async () => {
  if (!exited) supervisor.kill('SIGKILL');
  await new Promise((resolve) => blocker.close(resolve));
};
process.on('exit', () => {
  if (!exited) supervisor.kill('SIGKILL');
});

try {
  // 1. The worker keeps dying on the busy port, and the supervisor keeps going.
  await waitFor('the worker to fail its first bind', () =>
    /\[elfura-backend\] cannot listen/.test(log),
  );
  assert.equal(exited, null, 'the supervisor must outlive a worker crash');
  assert.match(
    log,
    /\[elfura-supervisor\] server exited unexpectedly[\s\S]*restarting in \d+ms \(attempt \d+\/\d+\)/,
    'the crash must be reported and scheduled for retry',
  );

  // 2. Free the port. The next retry must bind it and serve.
  await new Promise((resolve) => blocker.close(resolve));
  blocker = { close: (cb) => cb() };
  await waitFor('the service to answer after the retry', () => listens(port));
  assert.equal(await listens(port), true, 'the service recovered on its own');
  assert.equal(exited, null, 'the supervisor is still alive after recovery');

  // 3. A panel stop must be obeyed, not fought. SIGTERM: the child is told to
  // stop, and the supervisor exits without spawning another.
  const before = log.length;
  supervisor.kill('SIGTERM');
  await waitFor('the supervisor to exit after SIGTERM', () => exited !== null);
  assert.notEqual(exited.signal, 'SIGKILL', 'SIGTERM must be handled, not ignored');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await listens(port), false, 'nothing may be left listening after a stop');
  assert.doesNotMatch(
    log.slice(before),
    /restarting in \d+ms/,
    'a deliberate stop must not trigger a restart',
  );
} catch (error) {
  console.error('--- supervisor log ---');
  console.error(log.slice(-4000));
  throw error;
} finally {
  await cleanup().catch(() => {});
  process.removeAllListeners('exit');
}

console.log('supervisor: ok');
