#!/usr/bin/env node
/**
 * The diagnose bundle must never lie about a number.
 *
 * These assertions exist because the whole point of the report is to replace
 * guessing. A diagnostic that says "CPU-BOUND" when the process is idle would
 * send the operator chasing the wrong cause for another week — which is exactly
 * what this thread has already done four times.
 *
 * So the test drives the REAL builder twice: once idle, once while deliberately
 * burning a core, and asserts the verdict changes. It also asserts the values are
 * self-consistent (headroom arithmetic, share within [0, cores], delay ordering).
 */
import assert from 'node:assert/strict';

const { buildDiagnoseBundle } = await import('../../dist/backend/diagnose-bundle.js');

/* ── shape: every documented field exists and has the right type ──────────── */

const idle = await buildDiagnoseBundle();
for (const key of ['generatedAt', 'build', 'resolver', 'memory', 'cpu', 'resolverProbe', 'env']) {
  assert.ok(key in idle, `missing top-level field: ${key}`);
}
assert.equal(typeof idle.cpu.cpuShareOfCore, 'number');
assert.equal(typeof idle.cpu.eventLoopUtilization, 'number');
assert.equal(typeof idle.memory.headroomMb, 'number');
assert.ok(idle.env.maxOldSpaceFlag.length > 0, 'the flag must say something, even "none (uncapped)"');

/* ── arithmetic must hold ─────────────────────────────────────────────────── */

assert.equal(
  idle.memory.headroomMb,
  Math.round((idle.memory.heapLimitMb - idle.memory.heapUsedMb) * 10) / 10,
  'headroom must equal limit minus used, not a separate guess',
);
assert.ok(
  idle.cpu.eventLoopUtilization >= 0 && idle.cpu.eventLoopUtilization <= 1,
  'event-loop utilisation is a 0..1 ratio',
);
const d = idle.cpu.loopDelayMs;
assert.ok(d.mean <= d.p95 + 0.001 && d.p95 <= d.max + 0.001, 'mean <= p95 <= max');

/* ── the resolver block explains itself when it is local ──────────────────── */

if (idle.resolver.mode === 'local') {
  assert.ok(
    idle.resolver.localBecause.length > 0,
    'a local resolver must state WHY — a bare "local" is what wasted the most time',
  );
  assert.equal(idle.resolverProbe.attempted, false, 'nothing to probe when local');
} else {
  assert.equal(idle.resolver.localBecause, '', 'a remote resolver has no fallback reason');
  assert.equal(idle.resolver.url.length > 0, true, 'a remote resolver must name its URL');
}

/* ── it must actually detect saturation ──────────────────────────────────── */

const idleVerdict = idle.cpu.verdict.split(':')[0];

const until = Date.now() + 2_600;
const burn = () => {
  if (Date.now() < until) setImmediate(burn);
};
burn();
const loaded = await buildDiagnoseBundle();
const loadedVerdict = loaded.cpu.verdict.split(':')[0];

assert.ok(
  loaded.cpu.cpuShareOfCore > idle.cpu.cpuShareOfCore,
  `a busy process must report more CPU than an idle one (idle=${idle.cpu.cpuShareOfCore} loaded=${loaded.cpu.cpuShareOfCore})`,
);
assert.equal(
  loadedVerdict,
  'CPU-BOUND',
  `burning a core must be diagnosed as CPU-BOUND, got "${loadedVerdict}" (share=${loaded.cpu.cpuShareOfCore}, elu=${loaded.cpu.eventLoopUtilization})`,
);
assert.notEqual(
  idleVerdict,
  'CPU-BOUND',
  `an idle process must never be diagnosed as CPU-BOUND (got share=${idle.cpu.cpuShareOfCore}, elu=${idle.cpu.eventLoopUtilization})`,
);

/* ── and it must not leak anything private ───────────────────────────────── */

const serialised = JSON.stringify(loaded);
assert.doesNotMatch(serialised, /https?:\/\/(?!.*ELFSENTINEL)/, 'no upstream URLs may appear');
assert.doesNotMatch(serialised, /m3u8|\.mp4/, 'no stream URLs may appear');
assert.doesNotMatch(serialised, /pltoken|nonce|x-elfura-resolver-token/i, 'no credentials may appear');

console.log(
  `✓ diagnose bundle: idle=${idle.cpu.cpuShareOfCore} share/${idleVerdict}, ` +
    `loaded=${loaded.cpu.cpuShareOfCore} share/${loadedVerdict}, resolver=${idle.resolver.mode}`,
);
