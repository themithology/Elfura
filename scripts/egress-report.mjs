#!/usr/bin/env node
/**
 * Can this server reach the hosts the sources use, and where does it fail?
 *
 *   node scripts/egress-report.mjs
 *
 * No HTTP, no panel, no gateway timeout: run it in the server console and read
 * the answer. It walks a real connection to five provider hosts plus a control
 * host (TMDB, which is known to work on a healthy install) and prints the stage
 * each one reaches: DNS -> TCP -> TLS -> HTTP.
 */
import { reportEgress } from '../dist/backend/diagnostics.js';

const pad = (value, width) => String(value ?? '-').padEnd(width);
const stage = (value, extra) => {
  if (!value) return 'not-reached';
  if (value.ok) return `ok ${value.ms}ms${extra ? ` ${extra}` : ''}`;
  return `FAIL ${value.ms}ms ${value.error ?? ''}`.trim();
};

const started = Date.now();
const report = await reportEgress();

console.log('');
console.log(`egress report — node ${report.node}, resolver ${report.resolver.join(', ') || 'system'}`);
console.log(`finished in ${Date.now() - started} ms`);
console.log('');
console.log(`${pad('host', 22)} ${pad('dns', 20)} ${pad('tcp', 18)} ${pad('tls', 18)} http`);
console.log('-'.repeat(100));
for (const target of report.targets) {
  console.log(
    [
      pad(target.label, 22),
      pad(stage(target.dns, target.dns?.family ? `ipv${target.dns.family}` : ''), 20),
      pad(stage(target.tcp), 18),
      pad(stage(target.tls), 18),
      target.http ? (target.http.ok ? `${target.http.status} ${target.http.ms}ms` : `${target.http.error} ${target.http.ms}ms`) : 'not-reached',
    ].join(' '),
  );
}
console.log('');
console.log('verdict:');
for (const line of report.verdict) console.log(`  - ${line}`);
// The relay, if one is configured. This is the check an operator needs after
// pasting a URL and token into the panel: it says whether the stored values are
// present and whether the Worker answers, without printing the token.
try {
  const { currentRelayUrl, readRelayToken, relaySource } = await import('../dist/backend/relay-config.js');
  const { checkRelay } = await import('../dist/backend/proxy-check.js');
  const url = currentRelayUrl();
  console.log('');
  if (!url) {
    console.log('relay: none configured (discovery leaves from this server direct)');
  } else {
    const token = readRelayToken();
    console.log(`relay: ${url}`);
    console.log(`  source: ${relaySource() || 'unknown'}   token: ${token ? `present (${token.length} chars)` : 'MISSING'}`);
    if (!token) {
      console.log('  -> paste the TOKEN secret from the Worker into /roxy, or the Worker will answer 403');
    }
    const probe = await checkRelay(url);
    console.log(
      probe.ok
        ? `  test: ok ${probe.ms}ms, exit address ${probe.ip || 'not reported'}`
        : `  test: FAILED ${probe.ms}ms ${probe.error}`,
    );
  }
} catch (error) {
  console.log(`relay: could not be checked (${error instanceof Error ? error.message : String(error)})`);
}

console.log('');
console.log('How to read it:');
console.log('  control-tmdb fails        -> this server has no working outbound egress at all');
console.log('  dns FAIL, timeout         -> the container resolver is not answering');
console.log('  dns ok, tcp FAIL          -> the host/firewall blocks those addresses');
console.log('  tcp ok, tls FAIL          -> TLS is being reset (IPv6 black-hole or interception)');
console.log('  tls ok, http 403/429      -> the site refuses this server IP');
console.log('  everything ok             -> the network is fine; the fault is inside the adapters');
console.log('');
