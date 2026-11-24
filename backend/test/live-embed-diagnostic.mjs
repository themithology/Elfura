const endpoint = new URL('/fetch', 'http://opal.coffaie.online:4011');
endpoint.searchParams.set('url', 'https://api.ipify.org?format=json');
const results = [];
for (let attempt = 1; attempt <= 3; attempt++) {
  const started = Date.now();
  try {
    const res = await fetch(endpoint, {
      headers: { 'x-api-key': 'pussymaxxing' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();
    results.push(`#${attempt}: status=${res.status} ${Date.now() - started}ms ${body.slice(0, 120)}`);
    if (res.ok) break;
  } catch (err) {
    results.push(`#${attempt}: error=${(err)?.message || err} ${Date.now() - started}ms`);
  }
}
console.log(`::notice::${results.join(' | ')}`);
