/**
 * The DNS rescue has to work when the container's resolver does not.
 *
 * Production showed exactly that: resolver 127.0.0.11, every lookup timing out,
 * every adapter reporting zero candidates, while TMDB looked healthy because it
 * was riding a keep-alive socket. Node cannot be told to use other resolvers for
 * `fetch`, so the rescue patches hostname lookups on outgoing sockets and answers
 * them from c-ares against public servers.
 *
 * This test proves the patch end to end against a local DNS server: a name that
 * exists nowhere resolves through the stub, and a real HTTP request is made over
 * the resulting socket.
 */
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';

// --- a minimal DNS server that answers A queries with 127.0.0.1 -------------
const dns = dgram.createSocket('udp4');
dns.on('message', (msg, remote) => {
  // Header 12 bytes, then the QNAME, then QTYPE/QCLASS.
  let offset = 12;
  while (offset < msg.length && msg[offset] !== 0) offset += msg[offset] + 1;
  const questionEnd = offset + 5;
  const qtype = msg.readUInt16BE(offset + 1);

  const answer =
    qtype === 1
      ? Buffer.from([
          0xc0, 0x0c, // pointer to the question name
          0x00, 0x01, // type A
          0x00, 0x01, // class IN
          0x00, 0x00, 0x00, 0x3c, // ttl 60
          0x00, 0x04, // rdlength
          127, 0, 0, 1,
        ])
      : Buffer.alloc(0);

  const header = Buffer.alloc(12);
  msg.copy(header, 0, 0, 2); // same transaction id
  header.writeUInt16BE(0x8180, 2); // response, recursion available
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(qtype === 1 ? 1 : 0, 6); // ancount
  const reply = Buffer.concat([header, msg.subarray(12, questionEnd), answer]);
  dns.send(reply, remote.port, remote.address);
});
await new Promise((resolve) => dns.bind(0, '127.0.0.1', resolve));
const dnsPort = dns.address().port;

// --- a local HTTP server standing in for a provider -------------------------
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('reached-through-rescue');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const sitePort = site.address().port;

process.env.ELFURA_DNS_SERVERS = `127.0.0.1:${dnsPort}`;
process.env.ELFURA_DNS_RESCUE = 'always';

const { installDnsRescue } = await import('../../dist/backend/dns-rescue.js');
const { installNetTap, tapRequests } = await import('../../dist/backend/sources/net-tap.js');
installNetTap();

const lines = [];
const installed = await installDnsRescue((line) => lines.push(line));
assert.equal(installed, true, `rescue installs when forced (log: ${lines.join(' | ')})`);
assert.ok(
  lines.some((line) => line.includes(`127.0.0.1:${dnsPort}`)),
  'and reports which resolvers it uses',
);

try {
  // The name does not exist anywhere: only the stub can answer it.
  const tapped = await tapRequests(() => fetch(`http://provider.elfura-test.invalid:${sitePort}/`));
  const res = tapped.value;
  assert.equal(tapped.net.length, 1, 'tap still sees fetch after rescue replaces the global function');
  assert.equal(tapped.net[0].status, 200);
  assert.equal(res.status, 200, 'a request to an otherwise unresolvable name succeeds');
  assert.equal(await res.text(), 'reached-through-rescue', 'and reaches the real server');

  // Request objects (the vendor sources build them) must survive the swap.
  const madeFromRequest = await fetch(
    new Request(`http://third.elfura-test.invalid:${sitePort}/`, { headers: { accept: 'text/plain' } }),
  );
  assert.equal(madeFromRequest.status, 200, 'a Request object passed to fetch is accepted');
  assert.equal(await madeFromRequest.text(), 'reached-through-rescue');

  // Literals and local names must never be sent to the rescue resolver.
  const local = await fetch(`http://127.0.0.1:${sitePort}/`);
  assert.equal(local.status, 200, 'IP literals bypass the rescue untouched');

  console.log('✓ dns rescue: unresolvable names resolve through the configured servers, so a dead container resolver no longer kills every source');
} finally {
  dns.close();
  await new Promise((resolve) => site.close(resolve));
}
