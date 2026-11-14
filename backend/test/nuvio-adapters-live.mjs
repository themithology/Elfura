import { fetchFromNxsha } from '../../dist/backend/sources/source5.js';
import { createSource7Adapter } from '../../dist/backend/sources/source7.js';
import { verifyAndFilterCandidatesDetailed, cachedCandidateEvidence } from '../../dist/backend/sources/liveness.js';

// Real upstream check, separate from mocked adapter fixtures. A response alone
// is not success: require a candidate whose media manifest Elfura can fetch.
// This verifies server-side reachability, not actual browser playback.
const cases = [
  { type: 'movie', tmdbId: '872585', name: 'Oppenheimer' },
  { type: 'movie', tmdbId: '693134', name: 'Dune Part Two' },
  { type: 'tv', tmdbId: '1396', season: 1, episode: 1, name: 'Breaking Bad S1E1' },
];
const totals = { source5: 0, source7: 0 };
const originalFetch = globalThis.fetch;
const requestTrace = [];
const tracedFetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const stage = url.hostname === 'nxsha.space'
    ? url.pathname.endsWith('/servers') ? 'servers' : 'sources'
    : 'media';
  try {
    const response = await originalFetch(input, options);
    requestTrace.push({ stage, status: response.status });
    return response;
  } catch (error) {
    requestTrace.push({ stage, error: error?.cause?.code || error?.name || 'Error' });
    throw error;
  }
};
globalThis.fetch = tracedFetch;
const transport = { preferCurl: false, fetch: tracedFetch };
const screenscape = createSource7Adapter(() => true, transport);

try {
  for (const query of cases) {
    for (const [source, resolve] of [
      ['source5', async () => {
        const raw = await fetchFromNxsha({ ...query, diag: [] }, undefined, transport);
        const checked = await verifyAndFilterCandidatesDetailed(raw, AbortSignal.timeout(10_000));
        return { candidates: checked.candidates, rawCount: raw.length };
      }],
      ['source7', async () => {
        const result = await screenscape.resolve(query);
        return { candidates: result.candidates, rawCount: result.candidates.length };
      }],
    ]) {
      requestTrace.length = 0;
      const started = Date.now();
      let result = { candidates: [], rawCount: 0 };
      let error = '';
      try { result = await resolve(); }
      catch (e) { error = e instanceof Error ? e.name : 'Error'; }
      const candidates = result.candidates;
      const alive = candidates.filter(candidate => cachedCandidateEvidence(candidate)?.alive);
      totals[source] += alive.length;
      const report = {
        source,
        title: query.name,
        elapsedMs: Date.now() - started,
        returnedCandidates: result.rawCount,
        manifestReachable: alive.length,
        verifiedAudioLanguages: alive.map(candidate => cachedCandidateEvidence(candidate)?.discoveredAudioLangs ?? []),
        requests: requestTrace.slice(0, 24),
        ...(requestTrace.length > 24 ? { moreRequestRecords: requestTrace.length - 24 } : {}),
        ...(error ? { error } : {}),
      };
      const line = JSON.stringify(report);
      console.log(line);
      if (process.env.GITHUB_ACTIONS) console.log(`::notice title=NxshaLive::${line}`);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}

const summary = JSON.stringify({ liveSummary: totals });
console.log(summary);
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=NxshaLiveSummary::${summary}`);
if (!totals.source5 || !totals.source7) {
  const message = `No manifest-reachable stream for all requested titles: ${summary}`;
  console.error(message);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=NxshaLiveFailure::${message}`);
  process.exitCode = 1;
}
