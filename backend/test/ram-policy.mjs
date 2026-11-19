/**
 * RAM policy regression test.
 *
 * This deployment is RAM-constrained by choice: the operator would rather spend
 * bandwidth and CPU recomputing than hold payloads in memory. That decision has
 * to survive future edits, so this test pins it down.
 *
 * It also covers the subtler half of the problem. Turning caching off must not
 * quietly change *behaviour*: ranking, runtime filtering and per-lane reporting
 * all used to read cached probe evidence, which made "no cache" look like "no
 * verification". The helpers below assert that evidence carried on the candidate
 * itself keeps those decisions working with caching off.
 */
import assert from 'node:assert/strict';

import {
  RAM_CACHE_ENABLED,
  PolicyCache,
  describeMemoryPolicy,
} from '../../dist/backend/memory-policy.js';
import {
  candidateEvidence,
  verifyAndFilterCandidatesDetailed,
} from '../../dist/backend/sources/liveness.js';
import { selectPlaybackCandidates } from '../../dist/backend/sources/selection.js';

const keepAlive = setInterval(() => {}, 1000);
const originalFetch = globalThis.fetch;

try {
  /* ------------------------------------------------------------------ */
  /* 1. The switch itself                                               */
  /* ------------------------------------------------------------------ */
  // Retuned for a 4 GB container: caching used to default off, which made every
  // viewer re-fetch what the previous one had just fetched. The caches are all
  // entry-bounded, so "on" cannot grow without limit.
  assert.equal(RAM_CACHE_ENABLED, true, 'payload caching must default to on a 4 GB host');
  assert.match(describeMemoryPolicy(), /payload caches are ON/);

  // A disabled cache must behave like no cache at all, and never grow.
  const off = new PolicyCache(4, false);
  off.set('a', 1);
  assert.equal(off.get('a'), undefined, 'a disabled cache must not serve hits');
  assert.equal(off.has('a'), false);
  assert.equal(off.size, 0, 'a disabled cache must not retain anything');
  assert.equal(off.delete('a'), false);
  assert.deepEqual(off.describe(), { enabled: false, entries: 0, maxEntries: 4 });

  // An enabled cache still evicts oldest-first, so it cannot pin the heap.
  const on = new PolicyCache(3, true);
  on.set('a', 1);
  on.set('b', 2);
  on.set('c', 3);
  on.set('d', 4);
  assert.equal(on.size, 3, 'an enabled cache must respect its entry cap');
  assert.equal(on.get('a'), undefined, 'the oldest entry is evicted first');
  assert.equal(on.get('d'), 4);
  assert.deepEqual(on.describe(), { enabled: true, entries: 3, maxEntries: 3 });

  /* ------------------------------------------------------------------ */
  /* 2. Evidence survives without a cache                               */
  /* ------------------------------------------------------------------ */
  // Two lanes: one real multi-audio master, one single-language. Nothing is
  // cached, so every decision below has to come from this request's probe.
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/child.m3u8')) {
      return new Response('#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST');
    }
    const langs = url.pathname.includes('multi') ? ['hi', 'en'] : ['en'];
    const tracks = langs
      .map((l) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="x",LANGUAGE="${l}",NAME="${l}",URI="/child.m3u8"`)
      .join('\n');
    return new Response(
      `#EXTM3U\n${tracks}\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="x"\n/child.m3u8`,
    );
  };

  const adapter = { id: 'source-1', label: 'source-1', enabled: () => true };
  const multi = {
    key: 'multi',
    url: 'https://ram-test.example/multi.m3u8',
    type: 'hls',
    quality: 'auto',
    rank: 0,
  };
  const single = {
    key: 'single',
    // Deliberately claims multi-audio: an unproven claim must not be published.
    url: 'https://ram-test.example/single.m3u8',
    type: 'hls',
    quality: 'auto',
    rank: 0,
    multiAudio: true,
    availableAudioLangs: ['hi', 'en', 'fr'],
  };

  const verified = await verifyAndFilterCandidatesDetailed([multi, single]);
  assert.equal(verified.verifiedAliveCount, 2, 'both lanes answer');
  assert.equal(verified.probedDead.size, 0);

  // The measured evidence rides along on each candidate.
  for (const candidate of verified.candidates) {
    assert.ok(candidate.measuredThisRequest, `${candidate.key} must carry its measurement`);
    assert.equal(candidate.measuredThisRequest.alive, true);
  }

  const byUrl = new Map(verified.candidates.map((c) => [c.url, c]));
  const selected = selectPlaybackCandidates([
    { adapter, candidate: byUrl.get(multi.url) },
    { adapter, candidate: byUrl.get(single.url) },
  ]);

  const multiSelected = selected.find((entry) => entry.candidate.url === multi.url);
  const singleSelected = selected.find((entry) => entry.candidate.url === single.url);
  assert.ok(multiSelected, 'the measured multi-audio lane must be listed');
  assert.equal(multiSelected.candidate.multiAudio, true, 'a measured multi-audio lane is promoted');
  assert.deepEqual(multiSelected.candidate.availableAudioLangs, ['hi', 'en']);
  assert.ok(singleSelected, 'the single-language lane must still be listed');
  assert.equal(singleSelected.candidate.multiAudio, false, 'an unmeasured multi-audio claim must not survive');

  /* ------------------------------------------------------------------ */
  /* 3. Liveness evidence answers the same question as a cache hit      */
  /* ------------------------------------------------------------------ */
  const evidenceFromCandidate = candidateEvidence(byUrl.get(multi.url));
  assert.equal(evidenceFromCandidate?.alive, true, 'evidence is readable with no cache');
  assert.deepEqual(evidenceFromCandidate?.discoveredAudioLangs, ['hi', 'en']);

  // A lane the probe rejected reports itself as dead, not merely unknown.
  globalThis.fetch = async (input) =>
    String(input).includes('/dead.m3u8')
      ? new Response('', { status: 404 })
      : new Response('#EXTM3U\n#EXTINF:5,\nseg.ts\n#EXT-X-ENDLIST');
  const deadLane = {
    key: 'dead',
    url: 'https://ram-test.example/dead.m3u8',
    type: 'hls',
    quality: 'auto',
    rank: 0,
  };
  const deadRun = await verifyAndFilterCandidatesDetailed([deadLane]);
  assert.equal(deadRun.verifiedAliveCount, 0);
  assert.ok(deadRun.probedDead.has(deadLane.url), 'a probed-dead lane is reported without a cache');

  console.log(
    '✓ RAM policy: caching off by default, caches bounded when on, and ranking, runtime and liveness ' +
      'decisions all work with no cache at all',
  );
} finally {
  globalThis.fetch = originalFetch;
  clearInterval(keepAlive);
}
