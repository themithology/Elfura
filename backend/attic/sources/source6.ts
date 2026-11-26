/**
 * Source 6 — the Telugu lane.
 *
 * Why this exists as its own source instead of one more entry in source-5's
 * PRIMARY_LANES.
 *
 * nxsha publishes a scraper called `bkl-blast` (the repo above it labels the
 * lane "MbBlast"). Measured on 2026-11-16 from a GitHub runner against eight
 * titles, it answered 6/8 with real streams, and every row it produced was
 * Telugu (movies) or English (TV) - 1080p/720p/480p, single audio track each.
 * A control request for the same titles through the `nitro` lane answered 8/8,
 * so those are the lane's numbers and not a query-shape artefact.
 *
 * It is NOT folded into source-5 because the two answer different questions.
 * source-5 races its lanes and ranks whatever comes back; its lane list is
 * tuned for multi-audio and Hindi dubs, and a Telugu-only lane sitting inside
 * that race is invisible in the panel - it looks like source-5 "had fewer
 * results", with nothing to say which lane carried them. As its own adapter the
 * lane gets its own id, its own health row and its own switch.
 *
 * Trust boundary: this reuses `fetchFromNxsha` rather than re-implementing the
 * AES envelope. nxsha rotates its passphrase whenever it redeploys its player,
 * and source-5 already knows how to recover a rotated key from the front-end
 * bundle; a copy of that logic here would silently rot the first time it
 * rotated. The cost is that source-6 speaks the same protocol as source-5 and
 * shares its rate budget - which is why the lane filter is applied on our side
 * and every candidate is verified before it is returned.
 */
import { fetchFromNxsha } from './source5.js';
import { verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawSourceResult, RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

/**
 * Scrapers belonging to this lane. Deliberately one entry: adding a lane that
 * has not been measured here would put unverified rows behind a source whose
 * whole value is that "Telugu" means something. Add a scraper only with a
 * measured Telugu yield in hand.
 */
export const SOURCE6_LANE = 'bkl-blast';

/**
 * Keep only candidates the provider itself labelled Telugu.
 *
 * `normalizeLang` in source-5 resolves the provider's label to a code, so an
 * unlabelled row arrives as 'und'. Those are dropped rather than assumed: the
 * lane's Telugu claim is the entire reason this source exists, and an unlabelled
 * row is not evidence of it.
 */
function isTelugu(candidate: RawStreamCandidate): boolean {
  const codes = new Set<string>([
    ...(candidate.audioLang ? [candidate.audioLang] : []),
    ...(candidate.availableAudioLangs ?? []),
  ]);
  if (codes.has('te')) return true;
  // The label is free text from the provider ("720P (Telugu)"); match it as a
  // fallback for rows whose language the normaliser could not pin to a code.
  return /telugu|\btel\b/i.test(String(candidate.audioLabel ?? ''));
}

export function createSource6Adapter(isEnabled: () => boolean): SourceAdapter {
  const enabled = () => isEnabled();
  return {
    id: 'source-6',
    label: 'Source 6 (Telugu)',
    enabled,

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      const started = Date.now();
      // Indirection so the module can be loaded without a full config object
      // (tests construct it with `undefined`) while production reads the
      // env-driven flag from config.ts.
      const raw = await fetchFromNxsha(query, [SOURCE6_LANE]);
      const telugu = raw.filter(isTelugu);

      // Verify before returning, exactly like source-8: a labelled row is a
      // claim, and a manifest that 404s is worse than no row at all because the
      // player will spend its budget racing it.
      const verified = await verifyAndFilterCandidatesDetailed(telugu, query.signal);
      const alive = verified.candidates.filter((c) => candidateAlive(c, verified));

      query.diag?.push({
        adapter: 'source-6',
        lane: SOURCE6_LANE,
        ok: alive.length > 0,
        ms: Date.now() - started,
        detail:
          `raw=${raw.length},telugu=${telugu.length},alive=${alive.length}` +
          (raw.length && !telugu.length ? ' (lane returned no Telugu-labelled row)' : ''),
      });

      return {
        candidates: alive.map((c) =>
          query.diag ? { ...c, diagnosticLane: `6:${SOURCE6_LANE}` } : c,
        ),
      };
    },
  };
}

/**
 * `verifyAndFilterCandidatesDetailed` returns the surviving set; a candidate
 * that survived is the evidence. Kept as a named helper so the filter reads the
 * same way as source-8's without importing its private one.
 */
function candidateAlive(candidate: RawStreamCandidate, verified: { candidates: RawStreamCandidate[] }): boolean {
  return verified.candidates.includes(candidate);
}
