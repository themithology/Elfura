/** Experimental ScreenScape lanes, separate from the existing Nxsha source.
 * Only manifest-proven multilingual HLS candidates leave this adapter. */
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { fetchFromNxsha } from './source5.js';
import type { SourceAdapter } from './types.js';

// Fixed and bounded: these are additional lanes seen in ScreenScape's plugin,
// not proof that each returns HLS, a matching episode, or multiple languages.
const LANES = ['mbox', 'bdxs', 'watchout', 'rive-hindicast', 'purstream', 'em-8'] as const;

export function createSource7Adapter(enabled: () => boolean): SourceAdapter {
  return { id: 'source-7', label: 'Source 7', enabled, async resolve(query) {
    const start = Date.now();
    // Wait for the bounded set of lanes rather than publish unverified late results.
    const discoverySignal = query.signal
      ? AbortSignal.any([query.signal, AbortSignal.timeout(4000)])
      : AbortSignal.timeout(4000);
    const candidates = await fetchFromNxsha({ ...query, signal: discoverySignal, diag: [], onLateResult: undefined }, LANES);
    const verified = await verifyAndFilterCandidatesDetailed(candidates, query.signal);
    const multi = verified.candidates.filter(candidate => {
      const evidence = cachedCandidateEvidence(candidate);
      return !!evidence?.alive && new Set(evidence.discoveredAudioLangs ?? []).size > 1;
    });
    query.diag?.push({ adapter: 'source-7', lane: 'S', ok: multi.length > 0, ms: Date.now() - start,
      detail: `candidates=${candidates.length},multi=${multi.length}` });
    return { candidates: multi.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'S' } : candidate) };
  } };
}
