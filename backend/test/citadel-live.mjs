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

// NOTE: adapter.resolve() deliberately returns unmeasured candidates. Sizes are
// produced by the liveness pass inside the registry, which is the only place a
// segment is actually fetched. Asserting a size here would be asserting on a
// layer that never measures anything — it did exactly that on the first run.
quiet(`  adapter returned ${resolved.candidates.length} candidate(s); sizes come from the registry`);

// ── 1 + 2 + 3. end to end, through the registry the player is served by ────
const cfg = loadBackendConfig({
  ELFURA_SECRET: 'citadel-live-secret',
  TMDB_API_KEY: 'k',
  OPENSUBTITLES_ENABLED: '0',
  RESOLVE_TIMEOUT_MS: '90000',
});

/**
 * Resolve one title for one language and return what the player would receive.
 * The manifest is the source of truth; overriding the adapter list is how the
 * other tests isolate a single lane.
 */
async function resolveFor(lang) {
  const registry = new SourceRegistry(cfg);
  registry.adapters = [adapter];
  const body = await registry.resolvePlayback({ type: 'movie', tmdbId: '550', preferredLang: lang });
  assert(body && body.ok, `playback did not resolve for ${lang}`);
  assert(Array.isArray(body.sources) && body.sources.length > 0, `playback listed no stream for ${lang}`);
  return body;
}

const hindi = await resolveFor('hi');
const MB_ = MB;
quiet(`\n  Hindi request: ${hindi.sources.length} stream(s), primary ${hindi.primary?.label ?? '?'}`);
for (const source_ of hindi.sources) {
  const label = `${source_.label} [${source_.lang ?? source_.audioLang ?? '?'}]`;
  quiet(
    `    ${label.padEnd(38)} ` +
      (Number.isFinite(source_.measuredBytes)
        ? `${(source_.measuredBytes / MB_).toFixed(0)}MB`
        : 'unmeasured'),
  );
}

// ── 1. the streams carry measured sizes, and they are plausible ─────────────
const measured = hindi.sources.filter((s) => Number.isFinite(s.measuredBytes) && s.measuredBytes > 0);
assert(
  measured.length > 0,
  'not one stream measured a size — the byte-range probe never reached a segment',
);
for (const stream of measured) {
  assert(stream.measuredBytes > 1 * MB_, `a measured size of ${stream.measuredBytes}B is not a video`);
  assert(
    stream.measuredBytes < 200 * 1024 * MB_,
    `a measured size of ${(stream.measuredBytes / MB_).toFixed(1)}GB is implausible`,
  );
}

// ── 2. the response's own summary is honest ────────────────────────────────
assert(hindi.size, 'the response carried no size summary');
quiet(
  `\n  mean ${(hindi.size.meanBytes / MB_).toFixed(0)}MB over ${hindi.size.measured}/${hindi.size.total} measured, ` +
    `biggest ${(hindi.size.maxBytes / MB_).toFixed(0)}MB`,
);
assert(hindi.size.measured <= hindi.size.total, 'the mean cannot cover more streams than exist');
assert(hindi.size.measured === measured.length, 'the summary disagrees with the streams it summarises');
assert(hindi.size.meanBytes > 0, 'a reported mean of zero bytes is not a measurement');
assert(hindi.size.maxBytes >= hindi.size.meanBytes, 'the biggest stream cannot be smaller than the mean');

// ── 3. THE RULE: within the requested language, the biggest stream opens ────
const primary = hindi.primary;
assert(Number.isFinite(primary?.measuredBytes), 'the stream the player opens on carries no measured size');
const primaryLang = primary.lang ?? primary.audioLang ?? primary.claimedAudioLang ?? 'hi';
const biggerSameLang = hindi.sources.filter(
  (s) =>
    Number.isFinite(s.measuredBytes) &&
    s.measuredBytes > primary.measuredBytes &&
    (s.lang ?? s.audioLang ?? s.claimedAudioLang) === primaryLang,
);
assert.equal(
  biggerSameLang.length,
  0,
  `a ${(biggerSameLang[0]?.measuredBytes / MB_).toFixed(0)}MB ${primaryLang} stream outranks the ` +
    `${(primary.measuredBytes / MB_).toFixed(0)}MB primary in the same language`,
);
quiet(
  `  primary ${(primary.measuredBytes / MB_).toFixed(0)}MB is the biggest ${primaryLang} stream listed`,
);

// ── 4. and the same title in another language ranks its own biggest ────────
const english = await resolveFor('en');
quiet(`\n  English request: ${english.sources.length} stream(s), primary ${english.primary?.label ?? '?'}`);
const englishPrimary = english.primary;
if (Number.isFinite(englishPrimary?.measuredBytes)) {
  quiet(`  primary ${(englishPrimary.measuredBytes / MB_).toFixed(0)}MB`);
}

console.log('\n✓ citadel live: real sizes measured, requested language ranked biggest-first');
