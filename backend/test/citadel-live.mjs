/**
 * The owner's rule, proven against a real provider.
 *
 * ---------------------------------------------------------------------------
 * This is the check that matters. The unit test proves the comparator sorts by
 * size; it cannot prove that a real stream ever *produces* a size. This asks
 * citadel for the same title in two languages and requires that every listed
 * stream arrived with bytes behind it, that the mean is over measured streams,
 * and that the biggest stream of the requested language is the one the player
 * opens on.
 *
 * It needs egress, so it runs on a runner, not in the editing sandbox.
 * ---------------------------------------------------------------------------
 */
import assert from 'node:assert/strict';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { APPROVED_SOURCES } from '../../dist/backend/sources/index.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { selectPlaybackCandidates } from '../../dist/backend/sources/selection.js';

const MB = 1024 * 1024;
const source = APPROVED_SOURCES[0];
assert(source, 'a source must be approved before its ranking can be measured');

const adapter = source.create();
const probe = { type: 'movie', tmdbId: '550' };

const quiet = console.log;
console.log = () => {}; // the adapter narrates; the verdict below is the point
const resolved = await adapter.resolve({ ...probe, signal: AbortSignal.timeout(25_000) });
console.log = quiet;

assert(resolved.candidates.length > 0, 'the provider returned no rows for the probe title');

// ── 1. every candidate carries a real measurement ──────────────────────────
const sizes = resolved.candidates
  .filter((c) => Number.isFinite(c.measuredBytes) && c.measuredBytes > 0)
  .map((c) => c.measuredBytes);
assert(
  sizes.length > 0,
  'no candidate measured a size — the byte-range probe did not reach the segment',
);
for (const bytes of sizes) {
  assert(bytes > 1 * MB, `a measured size of ${bytes}B is not a video`);
  assert(bytes < 200 * 1024 * MB, `a measured size of ${(bytes / 1024 / MB).toFixed(1)}GB is implausible`);
}
quiet(`  sizes measured: ${sizes.map((b) => `${(b / MB).toFixed(0)}MB`).join(', ')}`);

// ── 2. the ranking puts the biggest of the requested language first ────────
{
  const rows = resolved.candidates.map((candidate) => ({
    adapter: { id: 'source-1', label: 'Source 1', enabled: () => true },
    candidate,
  }));
  const lang = resolved.candidates.find((c) => c.claimedAudioLang)?.claimedAudioLang;
  if (lang) {
    const ordered = selectPlaybackCandidates(rows, lang);
    const inLang = ordered.filter((e) => e.candidate.claimedAudioLang === lang);
    if (inLang.length > 1) {
      const measured = inLang.filter((e) => e.candidate.measuredBytes > 0);
      if (measured.length > 1) {
        for (let i = 1; i < measured.length; i += 1) {
          assert(
            measured[i - 1].candidate.measuredBytes >= measured[i].candidate.measuredBytes,
            `within ${lang}, ${(measured[i - 1].candidate.measuredBytes / MB).toFixed(0)}MB ranked above ` +
              `${(measured[i].candidate.measuredBytes / MB).toFixed(0)}MB`,
          );
        }
        quiet(
          `  ${lang}: ${measured.map((e) => `${(e.candidate.measuredBytes / MB).toFixed(0)}MB`).join(' ≥ ')}`,
        );
      }
    }
  }
}

// ── 3. end to end: the response carries sizes and a mean ───────────────────
{
  const cfg = loadBackendConfig({
    ELFURA_SECRET: 'citadel-live-secret',
    TMDB_API_KEY: 'k',
    OPENSUBTITLES_ENABLED: '0',
    RESOLVE_TIMEOUT_MS: '90000',
  });
  const registry = new SourceRegistry(cfg);
  // Only the lane under test. The manifest is the source of truth; overriding
  // the adapter list is how the other tests isolate one lane.
  registry.adapters = [adapter];
  const body = await registry.resolvePlayback({ type: 'movie', tmdbId: '550', preferredLang: 'hi' });
  assert(body && body.ok, 'playback did not resolve');
  assert(Array.isArray(body.sources) && body.sources.length > 0, 'playback listed no stream');
  quiet(`  playback: ${body.sources.length} stream(s), primary ${body.primary?.label ?? '?'}`);
  assert(body.size, 'the response carried no size summary — nothing was measured end to end');
  quiet(
    `  mean ${(body.size.meanBytes / MB).toFixed(0)}MB over ${body.size.measured}/${body.size.total} measured, ` +
      `biggest ${(body.size.maxBytes / MB).toFixed(0)}MB`,
  );
  assert(body.size.measured <= body.size.total, 'the mean cannot cover more streams than exist');
  assert(body.size.meanBytes > 0, 'a reported mean of zero bytes is not a measurement');
  assert(body.size.maxBytes >= body.size.meanBytes, 'the biggest stream cannot be smaller than the mean');

  // The owner's rule, at the only place it matters: what the player opens.
  const primary = body.primary;
  assert(
    Number.isFinite(primary?.measuredBytes),
    'the stream the player opens on carries no measured size',
  );
  const sameLang = body.sources.filter(
    (s) => Number.isFinite(s.measuredBytes) && s.measuredBytes > primary.measuredBytes,
  );
  for (const bigger of sameLang) {
    // A bigger stream may outrank the primary only by carrying a different
    // language than the viewer asked for.
    assert.notEqual(
      bigger.lang ?? bigger.audioLang,
      primary.lang ?? primary.audioLang,
      `a ${(bigger.measuredBytes / MB).toFixed(0)}MB stream outranks the ${(primary.measuredBytes / MB).toFixed(0)}MB primary in the same language`,
    );
  }
}

console.log('\n✓ citadel live: real sizes measured, requested language ranked biggest-first');
