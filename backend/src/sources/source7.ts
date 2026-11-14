/** Experimental ScreenScape lanes, separate from the existing Nxsha source.
 * Retains manifest-proven multi-audio and reachable, explicitly labelled dubs. */
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { fetchFromNxsha, NXSHA_SERVER_PRIORITY } from './source5.js';
import type { NxshaTransport } from './source5.js';
import type { SourceAdapter } from './types.js';

// Source 5 takes the first 12 available Nxsha lanes. ScreenScape takes the
// next six from the same upstream list; this is genuinely additive and avoids
// repeating Source 5's early lanes (as the previous hard-coded list did).

export function createSource7Adapter(enabled: () => boolean, transport?: NxshaTransport): SourceAdapter {
  return { id: 'source-7', label: 'Source 7', enabled, async resolve(query) {
    const start = Date.now();
    // Wait for the bounded set of lanes rather than publish unverified late results.
    const discoverySignal = query.signal
      ? AbortSignal.any([query.signal, AbortSignal.timeout(4000)])
      : AbortSignal.timeout(4000);
    const candidates = await fetchFromNxsha(
      { ...query, signal: discoverySignal, diag: [], onLateResult: undefined },
      NXSHA_SERVER_PRIORITY,
      transport,
      12,
    );
    const verified = await verifyAndFilterCandidatesDetailed(candidates, query.signal);
    const usable = verified.candidates.filter(candidate => {
      const evidence = cachedCandidateEvidence(candidate);
      return !!evidence?.alive;
    });
    query.diag?.push({ adapter: 'source-7', lane: 'S', ok: usable.length > 0, ms: Date.now() - start,
      detail: `candidates=${candidates.length},usable=${usable.length}` });
    return { candidates: usable.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'S' } : candidate) };
  } };
}
