const started = Date.now();
try {
  const res = await fetch('https://embed.theogpiratebot.to/api/v1/resolver-test', { signal: AbortSignal.timeout(10000) });
  const body = await res.text();
  console.log(`::notice::status=${res.status} (${Date.now() - started}ms) ${body.slice(0, 600)}`);
} catch (err) {
  console.log(`::notice::error=${(err)?.message || err} (${Date.now() - started}ms)`);
}
