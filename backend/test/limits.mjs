/**
 * Concurrency guards: a burst must never queue hundreds of resolutions, and one
 * client must never occupy the whole gate.
 */
import assert from 'node:assert/strict';

const { PerKeyConcurrency, ResolveGate, queueStats, registerQueueStats } = await import('../../dist/backend/limits.js');

// ── gate: bounded, ordered, and it hands slots over without drifting ────────
const gate = new ResolveGate(2, 2, 120);
const order = [];
let release = [];
const blocker = (name) =>
  gate.run(async () => {
    order.push(`start:${name}`);
    await new Promise((resolve) => release.push(resolve));
    order.push(`end:${name}`);
    return name;
  });

const first = blocker('a');
const second = blocker('b');
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(gate.stats(), { active: 2, queued: 0 }, 'two slots in use');

const third = blocker('c');
const fourth = blocker('d');
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(gate.stats(), { active: 2, queued: 2 }, 'two waiters queued');

const rejected = await blocker('e');
assert.deepEqual(rejected, { ok: false, reason: 'queue-full' }, 'a full queue is refused immediately, not queued forever');

release.shift()();
await new Promise((resolve) => setTimeout(resolve, 10));
assert(order.includes('start:c'), 'the first waiter takes the freed slot');
assert.equal(gate.stats().active, 2, 'the slot moved, it did not multiply');

while (release.length) release.shift()();
for (const _ of [first, second, third, fourth]) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  while (release.length) release.shift()();
}
const [r1, r2, r3, r4] = await Promise.all([first, second, third, fourth]);
assert.deepEqual([r1, r2, r3, r4].map((r) => r.ok), [true, true, true, true]);
assert.deepEqual(gate.stats(), { active: 0, queued: 0 }, 'every slot is returned');

// A waiter that waits too long is told to retry rather than hanging.
const tight = new ResolveGate(1, 4, 40);
let hold;
const held = tight.run(async () => {
  await new Promise((resolve) => (hold = resolve));
  return 'held';
});
await new Promise((resolve) => setTimeout(resolve, 5));
const starved = await tight.run(async () => 'never');
assert.deepEqual(starved, { ok: false, reason: 'queue-timeout' }, 'a starved caller gets an answer');
hold();
assert.equal((await held).ok, true);

// ── per-client cap ─────────────────────────────────────────────────────────
const perClient = new PerKeyConcurrency(2);
assert.equal(perClient.enter('1.2.3.4'), true);
assert.equal(perClient.enter('1.2.3.4'), true);
assert.equal(perClient.enter('1.2.3.4'), false, 'a third concurrent resolve from one client is refused');
assert.equal(perClient.enter('5.6.7.8'), true, 'another client is unaffected');
perClient.leave('1.2.3.4');
assert.equal(perClient.enter('1.2.3.4'), true, 'leaving frees the slot');
assert.equal(perClient.stats().clients, 2);

// ── telemetry sees the bounds ──────────────────────────────────────────────
registerQueueStats(() => ({ ...gate.stats(), ...perClient.stats() }));
const stats = queueStats();
assert.equal(stats.active, 0);
assert.equal(stats.clients, 2);

const { perfSnapshot } = await import('../../dist/backend/perf.js');
const { queues } = perfSnapshot();
assert.equal(typeof queues.clients, 'number', 'perf reports the registered bounds');
assert.equal(typeof queues.active, 'number');

console.log('✓ limits: resolution gate queues and refuses instead of stampeding, per-client in-flight cap, bounds visible in perf');
