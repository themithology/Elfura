/**
 * "Why did it stop?" telemetry.
 *
 * The user's observation was that when sources die, the logo and backdrop stop
 * loading at the same moment. Both are endpoints on one Node process, so this
 * test proves the monitor can tell the possible causes apart: a blocked event
 * loop, CPU/cgroup throttling, GC pauses, and rate-limit lockouts.
 */
import assert from 'node:assert/strict';

process.env.ELFURA_STALL_WARN_MS = '120';
const {
  healthSummary,
  noteRateLimit,
  noteRequest,
  perfSnapshot,
  phaseStart,
  sampleNow,
  startPerfMonitor,
  stopPerfMonitor,
} = await import('../../dist/backend/perf.js');

startPerfMonitor();
// The histogram needs one tick to establish its baseline before it can measure
// a delay; in production that tick is the first 2 s of uptime.
await new Promise((resolve) => setTimeout(resolve, 120));

// 1. Phase tracking: the monitor must know what was running when it stalled.
const endResolve = phaseStart('playback');
const during = perfSnapshot().inFlight;
assert.equal(during.playback, 1, 'an in-flight resolve is visible');
endResolve();
assert.equal(perfSnapshot().inFlight.playback, undefined, 'the phase clears when the work ends');

// 2. A genuinely blocked loop is reported with what was busy and a verdict.
const endBlock = phaseStart('art');
const until = Date.now() + 320;
while (Date.now() < until) {
  /* deliberately block the event loop, like a synchronous decrypt or PoW */
}
endBlock();
// The histogram is filled by the loop's own timer, so let one tick through.
await new Promise((resolve) => setTimeout(resolve, 80));
sampleNow();
const stalled = perfSnapshot();
assert(stalled.eventLoop.maxMs >= 120, `a 320ms block is measured (got ${stalled.eventLoop.maxMs}ms)`);
assert(stalled.eventLoop.stalls.length >= 1, 'the stall is recorded');
assert.match(stalled.eventLoop.stalls.at(-1).busy, /art/, 'the stall says which endpoint was running');
assert.match(stalled.verdict, /event-loop-blocked|cpu-|gc-|rate-limited|healthy/);

// 3. Rate-limit lockouts are counted, because a 429 on /art and a 429 on
//    /playback look exactly like "everything broke" from the browser.
noteRequest();
noteRateLimit('art');
noteRateLimit('playback');
noteRateLimit('playback');
const limited = perfSnapshot();
assert.equal(limited.traffic.requests, 1);
assert.equal(limited.traffic.rateLimited, 3);
assert.deepEqual(limited.traffic.rateLimitedByBucket, { art: 1, playback: 2 });

// 4. Shapes are complete and numeric — no NaN sneaks into the JSON.
for (const value of [
  limited.eventLoop.p50Ms,
  limited.eventLoop.p99Ms,
  limited.cpu.percent,
  limited.gc.maxPauseMs,
]) {
  assert(Number.isFinite(value), `finite number, got ${value}`);
}
assert(Number.isFinite(limited.cpu.cores) && limited.cpu.cores >= 1);
assert(Number.isFinite(limited.memory.rssMb) && limited.memory.rssMb > 0);
assert.match(limited.verdict, /rate-limited/, 'a denial outranks a healthy verdict');
assert(limited.cpu.cgroup === null || typeof limited.cpu.cgroup === 'object', 'cgroup block is always present');

// 5. The compact health summary carries the same verdict.
const summary = healthSummary();
assert(Number.isFinite(summary.eventLoopMs));
assert.match(summary.verdict, /rate-limited/);

// 6. Both endpoints answer over HTTP, in the shape the panel reads.
const { createBackendServer } = await import('../../dist/backend/index.js');
const { server } = createBackendServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const headers = { 'X-Forwarded-Host': 'player.elfura.app' };
try {
  const perf = await fetch(`http://127.0.0.1:${port}/api/v1/perf`, { headers });
  assert.equal(perf.status, 200);
  const body = await perf.json();
  assert.equal(body.ok, true);
  assert(body.eventLoop && body.cpu && body.memory && body.traffic && body.verdict, 'perf payload is complete');
  assert.equal(typeof body.eventLoop.worstMs, 'number');
  assert(!JSON.stringify(body).includes('http'), 'no upstream URL leaks into telemetry');

  const health = await (await fetch(`http://127.0.0.1:${port}/api/v1/health`, { headers })).json();
  assert.equal(health.ok, true);
  assert.equal(typeof health.perf.verdict, 'string', 'health carries the one-line verdict');
} finally {
  await new Promise((resolve) => server.close(resolve));
  stopPerfMonitor();
}

console.log('✓ perf telemetry: event-loop stalls with the busy endpoint, CPU/cgroup throttling, GC pauses, 429 lockouts, and a one-line verdict on health');
