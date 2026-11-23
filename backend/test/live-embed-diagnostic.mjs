const out = [];
for (const path of ['/health', '/resolver/api/sources']) {
  const started = Date.now();
  try {
    const res = await fetch('http://opal.coffaie.online:4010' + path, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    out.push(`${path}: status=${res.status} (${Date.now() - started}ms) ${body.slice(0, 180)}`);
  } catch (err) {
    out.push(`${path}: error=${(err)?.message || err} (${Date.now() - started}ms)`);
  }
}
console.log(`::notice::${out.join(' || ')}`);
