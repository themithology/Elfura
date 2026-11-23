const endpoint = new URL('/fetch', 'http://opal.coffaie.online:4011');
endpoint.searchParams.set('url', 'https://api.ipify.org?format=json');
const started = Date.now();
try {
  const res = await fetch(endpoint, {
    headers: { 'x-api-key': 'pussymaxxing' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.text();
  console.log(`::notice::status=${res.status} latency=${Date.now() - started}ms body=${body.slice(0, 200)}`);
} catch (err) {
  console.log(`::notice::error=${(err)?.message || err} latency=${Date.now() - started}ms`);
}
