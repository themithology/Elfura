import { fetchFromNxsha } from '../../dist/backend/sources/source5.js';
import { createSource7Adapter } from '../../dist/backend/sources/source7.js';
import { verifyAndFilterCandidatesDetailed, cachedCandidateEvidence } from '../../dist/backend/sources/liveness.js';

// This is a real upstream check, deliberately separate from mocked adapter
// fixtures. A returned HTTP response alone is not success: require a candidate
// whose HLS manifest Elfura can fetch and parse. This does not claim browser playback.
const cases = [
  { type: 'movie', tmdbId: '872585', name: 'Oppenheimer' },
  { type: 'movie', tmdbId: '693134', name: 'Dune Part Two' },
  { type: 'tv', tmdbId: '1396', season: 1, episode: 1, name: 'Breaking Bad S1E1' },
];
const totals = { source5: 0, source7: 0 };
const screenscape = createSource7Adapter(() => true);

for (const query of cases) {
  for (const [source, resolve] of [
    ['source5', async () => {
      const raw = await fetchFromNxsha(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, AbortSignal.timeout(10_000));
      return { candidates: checked.candidates, rawCount: raw.length };
    }],
    ['source7', async () => {
      const result = await screenscape.resolve(query);
      return { candidates: result.candidates, rawCount: result.candidates.length };
    }],
  ]) {
    const started = Date.now();
    let result = { candidates: [], rawCount: 0 };
    let error = '';
    try { result = await resolve(); }
    catch (e) { error = e instanceof Error ? e.name : 'Error'; }
    const candidates = result.candidates;
    const alive = candidates.filter(candidate => cachedCandidateEvidence(candidate)?.alive);
    totals[source] += alive.length;
    console.log(JSON.stringify({
      source,
      title: query.name,
      elapsedMs: Date.now() - started,
      returnedCandidates: result.rawCount,
      manifestReachable: alive.length,
      verifiedAudioLanguages: alive.map(candidate => cachedCandidateEvidence(candidate)?.discoveredAudioLangs ?? []),
      ...(error ? { error } : {}),
    }));
  }
}

console.log(JSON.stringify({ liveSummary: totals }));
if (!totals.source5 || !totals.source7) {
  console.error('No manifest-reachable stream found for one or both Nxsha/ScreenScape source groups.');
  process.exitCode = 1;
}
