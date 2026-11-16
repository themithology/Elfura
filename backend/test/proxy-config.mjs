// Verify .env proxy configuration with a local HTTP CONNECT proxy.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'elfura-proxy-test-'));
const target = http.createServer((_req, res) => res.end('through proxy'));
let connects = 0;
const proxy = http.createServer();
proxy.on('connect', (req, client, head) => {
  connects++;
  assert.equal(req.headers['proxy-authorization'], `Basic ${Buffer.from('testuser:testpass').toString('base64')}`);
  const upstream = net.connect(target.address().port, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});
await Promise.all([new Promise(r => target.listen(0, '127.0.0.1', r)), new Promise(r => proxy.listen(0, '127.0.0.1', r))]);
const proxyUrl = `http://testuser:testpass@127.0.0.1:${proxy.address().port}`;
const moduleUrl = pathToFileURL(path.resolve('dist/backend/egress.js')).href;
async function run(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELFURA_EGRESS_PROFILE;
  const code = `import { installEgressProfile } from ${JSON.stringify(moduleUrl)}; await installEgressProfile(); const r = await fetch('http://127.0.0.1:${target.address().port}/'); console.log(await r.text()); process.exit(0);`;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: temp, env });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
try {
  await fs.writeFile(path.join(temp, '.env'), `ELFURA_UPSTREAM_PROXY=${proxyUrl}\n`);
  const output = await run({ ELFURA_UPSTREAM_PROXY: undefined });
  assert.match(output, /via configured proxy/);
  assert.match(output, /through proxy/);
  assert.ok(!output.includes('testpass'), 'credentials must not be logged');
  assert.equal(connects, 1, 'discovery requests use the proxy from .env');
  const directOutput = await run({ ELFURA_UPSTREAM_PROXY: '' });
  assert.doesNotMatch(directOutput, /via configured proxy/);
  assert.equal(connects, 1, 'environment variable overrides .env');
  console.log('✓ proxy configuration from .env, environment precedence, and credential-safe logs');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
  await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => target.close(r))]);
}
