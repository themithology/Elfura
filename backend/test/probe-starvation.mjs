/**
 * A lane that was never probed must never be dropped.
 *
 * Probes share one process-wide pool. When the pool is busy, lanes queue, and
 * the batch budget can expire before some of them are ever reached. Those lanes
 * come back with no outcome at all — not dead, simply unproven. They used to be
 * discarded the moment any other lane verified alive, which meant a busy process
 * reported fewer sources than an idle one, and at high concurrency it dropped
 * whole sources. This test starves the pool on purpose and asserts that every
 * unprobed lane survives, still ranked behind the ones that proved themselves.
 *
 * A lane that WAS probed and timed out is a different case and stays hidden while
 * a healthy lane exists (see the e2e "slow lanes" case) — so the invariant here is
 * precisely: kept = verified + never-probed, and nothing else.
 */
import assert from 'node:assert/strict';

process.env.ELFURA_PROBE_PARALLELISM = '4';

const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';
const realFetch = globalThis.fetch;
let probing = 0;
let peak = 0;

globalThis.fetch = async () => {
  probing += 1;
  if (probing > peak) peak = probing;
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return new Response(MEDIA, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    });
  } finally {
    probing -= 1;
  }
};

const { verifyAndFilterCandidatesDetailed, probePoolStats } = await import(
  '../../dist/backend/sources/liveness.js'
);

try {
  // A hundred and twenty distinct lanes against a pool of four and a 3.5 s batch
  // budget: most of them are still queued when the budget runs out.
  const candidates = Array.from({ length: 120 }, (_, i) => ({
    key: `lane-${i}`,
    url: `https://cdn${i}.example.test/lane-${i}/master.m3u8`,
    type: 'hls',
    quality: '720p',
    rank: i + 1,
  }));

  const detailed = await verifyAndFilterCandidatesDetailed(candidates);

  assert.ok(peak <= 4, `the probe pool stayed within its limit (peak ${peak})`);
  assert.ok(
    detailed.verifiedAliveCount < candidates.length,
    `the budget did interrupt the batch (probed ${detailed.verifiedAliveCount} of ${candidates.length})`,
  );

  // An unproven lane is returned as the very object it came in as; anything that
  // was probed comes back as a copy with the measurement applied.
  const unproven = detailed.candidates.filter((c) => candidates.includes(c));
  assert.ok(unproven.length > 0, 'the batch really did leave lanes unprobed');
  assert.equal(
    detailed.candidates.length,
    detailed.verifiedAliveCount + unproven.length,
    'kept lanes are exactly the verified ones plus the never-probed ones',
  );

  const firstUnproven = detailed.candidates.findIndex((c) => candidates.includes(c));
  assert.ok(firstUnproven > 0, 'proven lanes are listed before unproven ones');
  assert.ok(
    detailed.candidates.slice(firstUnproven).every((c) => candidates.includes(c)),
    'and no proven lane is ranked behind an unproven one',
  );

  assert.deepEqual(probePoolStats(), { active: 0, queued: 0 }, 'the pool drains: no slot or waiter leaks');

  console.log(
    `✓ probe starvation: ${unproven.length} never-probed lanes kept, ${detailed.verifiedAliveCount} verified, pool peak ${peak}`,
  );
} finally {
  globalThis.fetch = realFetch;
}
