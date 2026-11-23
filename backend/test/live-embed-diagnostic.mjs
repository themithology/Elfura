const out = [];
for (const path of ['/api/v1/resolver-test', '/api/v1/playback?type=movie&tmdb=550']) {
  const started = Date.now();
  try {
    const res = await fetch('https://embed.theogpiratebot.to' + path, { signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    out.push(`${path}: status=${res.status} (${Date.now() - started}ms) ${body.slice(0, 250)}`);
  } catch (err) {
    out.push(`${path}: error=${(err)?.message || err}`);
  }
}
console.log(`::notice::${out.join(' || ')}`);
