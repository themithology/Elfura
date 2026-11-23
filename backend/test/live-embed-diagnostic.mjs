const out = [];
for (const url of [
  'https://embed.theogpiratebot.to/api/v1/resolver-test',
  'http://veynite.coffaie.online:3002/health',
  'http://opal.coffaie.online:4013/health',
]) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    out.push(`${url}: status=${res.status} (${Date.now() - started}ms) ${body.slice(0, 220)}`);
  } catch (err) {
    out.push(`${url}: error=${(err)?.message || err} (${Date.now() - started}ms)`);
  }
}
console.log(`::notice::${out.join(' || ')}`);
