/**
 * Uploaded proxy lists: parsing, storage, masking, rotation and failover.
 *
 * The formats are the ones providers actually export — Webshare's
 * `host:port:user:pass` being the important one — and the failover is proven
 * against real local HTTP CONNECT proxies rather than a mock, because the whole
 * point of the feature is that a dead proxy must not kill the source.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const { parseProxyList, ProxyPool, MAX_PROXIES } = await import('../../dist/backend/proxy-pool.js');

// ---- parsing ---------------------------------------------------------------
const webshare = [
  '45.38.107.97:6014:jaaphwvh:7mmcluipg93z',
  '64.137.96.74:6641:jaaphwvh:7mmcluipg93z',
].join('\r\n');

const parsed = parseProxyList(`\r\n# my proxies\r\n${webshare}\r\n\r\n`);
assert.equal(parsed.entries.length, 2, 'CRLF, blank lines and comments are tolerated');
assert.equal(parsed.entries[0].host, '45.38.107.97');
assert.equal(parsed.entries[0].port, 6014);
assert.equal(parsed.entries[0].username, 'jaaphwvh');
assert.equal(parsed.entries[0].password, '7mmcluipg93z');
assert.equal(
  parsed.entries[0].url,
  'http://jaaphwvh:7mmcluipg93z@45.38.107.97:6014',
  'a Webshare line becomes a usable proxy URL',
);

const formats = parseProxyList(
  [
    'http://user:pass@10.0.0.1:8080',
    'user:pass@10.0.0.2:3128',
    '10.0.0.3:8000',
    '10.0.0.4 9000 user pass',
    '10.0.0.5:7000:user:pa:ss', // password containing colons
  ].join('\n'),
);
assert.equal(formats.entries.length, 5, 'every documented format is accepted');
assert.equal(formats.entries[0].host, '10.0.0.1');
assert.equal(formats.entries[1].username, 'user', 'user:pass@host:port is understood');
assert.equal(formats.entries[2].username, '', 'an open proxy has no credentials');
assert.equal(formats.entries[3].port, 9000, 'space separated lists work');
assert.equal(formats.entries[4].password, 'pa:ss', 'colons inside a password survive');

const deduped = parseProxyList('1.2.3.4:8080:u:p\n1.2.3.4:8080:u:p\n');
assert.equal(deduped.entries.length, 1, 'duplicate lines collapse');

const mixed = parseProxyList('1.2.3.4:8080:u:p\nnot a proxy\n999.1.1.1:99999:u:p\n');
assert.equal(mixed.entries.length, 1);
assert.equal(mixed.rejected, 2, 'unusable lines are counted, not silently accepted');

const huge = parseProxyList(
  Array.from({ length: MAX_PROXIES + 5 }, (_, i) => `10.1.${Math.floor(i / 250)}.${i % 250}:8080:u:p`).join('\n'),
);
assert.equal(huge.entries.length, MAX_PROXIES, 'the pool is capped');

// ---- storage and masking ---------------------------------------------------
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elfura-proxy-pool-'));
try {
  const pool = new ProxyPool(dir);
  const saved = pool.replaceText(webshare);
  assert.equal(saved.added, 2);
  assert.equal(saved.persisted, true);

  const file = path.join(dir, 'proxies.json');
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, 'a file holding proxy credentials is private');

  const reloaded = new ProxyPool(dir);
  assert.equal(reloaded.size, 2, 'the list survives a restart');

  const snapshot = reloaded.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('7mmcluipg93z'), 'the panel snapshot never contains a password');
  assert.ok(!serialized.includes('jaaphwvh'), 'not even the full username');
  assert.ok(snapshot.proxies[0].user.startsWith('jaap'), 'a masked username still identifies the proxy');
  assert.equal(snapshot.proxies[0].state, 'untested');

  // Rotation starts one further along each time, and cooldowns move a proxy back.
  const first = reloaded.nextCandidates(1)[0].id;
  const second = reloaded.nextCandidates(1)[0].id;
  assert.notEqual(first, second, 'candidates rotate between requests');
  reloaded.reportFailure(second, 'connect ECONNREFUSED');
  reloaded.reportFailure(second, 'connect ECONNREFUSED');
  reloaded.reportFailure(second, 'connect ECONNREFUSED');
  assert.equal(reloaded.healthOf(second).until > Date.now(), true, 'three failures rest a proxy');
  const healthyFirst = reloaded.nextCandidates(1)[0].id;
  assert.equal(healthyFirst, first, 'a resting proxy is not the first choice');

  reloaded.clear();
  assert.equal(new ProxyPool(dir).size, 0, 'clearing is persisted too');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---- live rotation and failover through real CONNECT proxies ---------------
let connects = { a: 0, b: 0 };
const makeProxy = (label, expectedAuth) => {
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    connects[label] += 1;
    assert.equal(req.headers['proxy-authorization'], expectedAuth, 'the uploaded credentials are sent');
    const upstream = net.connect(target.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return proxy;
};
const target = http.createServer((_req, res) => res.end('proxied body'));
await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));

const authFor = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const proxyA = makeProxy('a', authFor('alice', 's3cret'));
const proxyB = makeProxy('b', authFor('alice', 's3cret'));
await Promise.all([
  new Promise((resolve) => proxyA.listen(0, '127.0.0.1', resolve)),
  new Promise((resolve) => proxyB.listen(0, '127.0.0.1', resolve)),
]);

// A port that is bound and then released: connect attempts are refused instantly.
const deadProbe = net.createServer();
await new Promise((resolve) => deadProbe.listen(0, '127.0.0.1', resolve));
const deadPort = deadProbe.address().port;
await new Promise((resolve) => deadProbe.close(resolve));

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elfura-proxy-egress-'));
const dist = pathToFileURL(path.resolve('dist/backend')).href;
const childCode = `
  const { proxyPool } = await import(${JSON.stringify(`${dist}/proxy-pool.js`)});
  proxyPool.replaceText(process.env.PROXY_LIST);
  const log = [];
  const { installEgressProfile } = await import(${JSON.stringify(`${dist}/egress.js`)});
  await installEgressProfile((line) => log.push(line));
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    const response = await fetch(process.env.TARGET_URL);
    results.push(response.status + ':' + (await response.text()));
  }
  console.log(JSON.stringify({ log, results, snapshot: proxyPool.snapshot() }));
  process.exit(0);
`;
const runChild = async (proxyList) => {
  const env = {
    ...process.env,
    ROXY_DATA_DIR: dataDir,
    PROXY_LIST: proxyList,
    TARGET_URL: `http://127.0.0.1:${target.address().port}/`,
  };
  delete env.ELFURA_UPSTREAM_PROXY;
  delete env.ELFURA_EGRESS_PROFILE;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { cwd: dataDir, env });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, output);
  return JSON.parse(output.trim().split('\n').at(-1));
};

try {
  const portA = proxyA.address().port;
  const portB = proxyB.address().port;
  // The dead entry comes first on purpose: request one must fail over and still
  // return the target's body.
  const list = [
    `127.0.0.1:${deadPort}:alice:s3cret`,
    `127.0.0.1:${portA}:alice:s3cret`,
    `127.0.0.1:${portB}:alice:s3cret`,
  ].join('\n');
  const run = await runChild(list);

  assert.deepEqual(
    run.results,
    Array(4).fill('200:proxied body'),
    'every request succeeds even though the first proxy in the list is dead',
  );
  assert.ok(connects.a > 0 && connects.b > 0, 'requests rotate across the working proxies');
  assert.match(run.log.join(' | '), /via 3 uploaded proxies/, 'the boot line reports the uploaded list');
  assert.ok(!run.log.join(' | ').includes('s3cret'), 'no credential reaches the console');
  assert.equal(run.snapshot.count, 3);
  const dead = run.snapshot.proxies.find((entry) => entry.port === deadPort);
  assert.equal(dead.state, 'failing', 'the dead proxy is marked failing');
  // Rotation starts one further along on each request, so a working proxy in
  // front of the dead one short-circuits before it is ever dialled. Counting
  // any failure — not a fixed number — is what the panel actually needs.
  assert.ok(dead.failures >= 1, 'and its failures are counted');
  assert.ok(!JSON.stringify(run.snapshot).includes('s3cret'), 'the snapshot stays credential-free');

  // Clearing the list returns to a direct connection immediately.
  const before = connects.a + connects.b;
  const cleared = await runChild('');
  assert.deepEqual(cleared.results, Array(4).fill('200:proxied body'));
  assert.equal(connects.a + connects.b, before, 'no proxy is used once the list is empty');
  assert.match(cleared.log.join(' | '), /one retry on 403/, 'and the log says it is connecting directly');

  console.log('✓ proxy pool: Webshare format parses, credentials stay private, dead proxies fail over, rotation is live');
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
  await Promise.all([
    new Promise((resolve) => proxyA.close(resolve)),
    new Promise((resolve) => proxyB.close(resolve)),
    new Promise((resolve) => target.close(resolve)),
  ]);
}
