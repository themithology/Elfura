/**
 * The probe pool is process-wide.
 *
 * Each resolve used to open its own pool of twenty probes, so 128 concurrent
 * resolves could hold thousands of HTTP responses in memory at once — the RSS
 * climb the operator saw. Parallelism of I/O is bounded here; requests are
 * never refused, they are simply not all fetching at the same instant.
 */
import assert from 'node:assert/strict';

process.env.ELFURA_PROBE_PARALLELISM = '8';

const realFetch = globalThis.fetch;
let active = 0;
let peak = 0;
globalThis.fetch = async () => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, 20));
  active -= 1;
  return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n', {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
  });
};

const { verifyAndFilterCandidatesDetailed, probePoolStats } = await import('../../dist/backend/sources/liveness.js');

try {
  const batch = (tag) =>
    Array.from({ length: 20 }, (_, i) => ({
      key: `${tag}-${i}`,
      url: `https://cdn${tag}-${i}.example.test/master.m3u8`,
      type: 'hls',
      quality: '720p',
      rank: i,
    }));

  // Six resolves at once, 120 probes total.
  const results = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((tag) => verifyAndFilterCandidatesDetailed(batch(tag))),
  );

  assert.equal(results.length, 6);
  assert(results.every((r) => r.candidates.length === 20), 'every resolve still gets all of its lanes');
  assert(peak <= 8, `no more than 8 probes may run at once (peak ${peak})`);
  assert(peak >= 2, `the pool is actually used (peak ${peak})`);
  assert.deepEqual(probePoolStats(), { active: 0, queued: 0 }, 'every slot is released');

  console.log(`✓ probe pool: 120 probes from six resolves ran at most ${peak} at a time, none refused, no slot leaked`);
} finally {
  globalThis.fetch = realFetch;
}
