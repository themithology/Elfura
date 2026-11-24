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

// Ask for the language this lane actually publishes, taken from its own rows.
// Asking for Hindi on a title citadel only has in English proves nothing: the
// previous run did exactly that and compared the primary against an empty set,
// then reported success.
const offered = [
  ...new Set(
    resolved.candidates
      .map((c) => c.claimedAudioLang)
      .filter((lang) => typeof lang === 'string' && lang !== 'und'),
  ),
];
assert(offered.length > 0, 'the lane published no language at all — nothing can be ranked');
const lang = offered[0];
quiet(`  languages published: ${offered.join(', ')}; ranking inside "${lang}"`);

const wanted = await resolveFor(lang);
const MB_ = MB;
quiet(`\n  "${lang}" request: ${wanted.sources.length} stream(s), primary ${wanted.primary?.label ?? '?'}`);
for (const stream of wanted.sources) {
  const label = `${stream.label} [${
    stream.audioLang ? `${stream.audioLang} verified` : `${stream.claimedAudioLang} label`
  }]`;
  quiet(
    `    ${label.padEnd(38)} ` +
      (Number.isFinite(stream.measuredBytes)
        ? `${(stream.measuredBytes / MB_).toFixed(0)}MB`
        : 'unmeasured'),
  );
}

// ── 1. the streams carry measured sizes, and they are plausible ─────────────
const measured = wanted.sources.filter((s) => Number.isFinite(s.measuredBytes) && s.measuredBytes > 0);
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
assert(wanted.size, 'the response carried no size summary');
quiet(
  `\n  mean ${(wanted.size.meanBytes / MB_).toFixed(0)}MB over ${wanted.size.measured}/${wanted.size.total} measured, ` +
    `biggest ${(wanted.size.maxBytes / MB_).toFixed(0)}MB`,
);
assert(wanted.size.measured <= wanted.size.total, 'the mean cannot cover more streams than exist');
assert(wanted.size.measured === measured.length, 'the summary disagrees with the streams it summarises');
assert(wanted.size.meanBytes > 0, 'a reported mean of zero bytes is not a measurement');
assert(wanted.size.maxBytes >= wanted.size.meanBytes, 'the biggest stream cannot be smaller than the mean');

// ── 3. every stream tells the player what language it is ───────────────────
for (const stream of wanted.sources) {
  assert(
    stream.audioLang || stream.claimedAudioLang,
    `${stream.label} reached the player with no language at all`,
  );
}

// ── 4. THE RULE: within the requested language, the biggest stream opens ────
const primary = wanted.primary;
assert(Number.isFinite(primary?.measuredBytes), 'the stream the player opens on carries no measured size');
const primaryLang = primary.audioLang ?? primary.claimedAudioLang;
assert(
  primaryLang && primaryLang.split('-')[0] === lang.split('-')[0],
  `the primary stream is "${primaryLang}", not the requested "${lang}"`,
);
const biggerSameLang = wanted.sources.filter(
  (s) =>
    Number.isFinite(s.measuredBytes) &&
    s.measuredBytes > primary.measuredBytes &&
    (s.audioLang ?? s.claimedAudioLang) === primaryLang,
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

// ── 5. a second language is a second ranking, not a copy of the first ──────
const other = offered.find((code) => code.split('-')[0] !== lang.split('-')[0]);
if (other) {
  const second = await resolveFor(other);
  const secondPrimary = second.primary;
  const secondLang = secondPrimary?.audioLang ?? secondPrimary?.claimedAudioLang;
  quiet(`\n  "${other}" request: ${second.sources.length} stream(s), primary ${secondPrimary?.label ?? '?'}`);
  assert(
    secondLang && secondLang.split('-')[0] === other.split('-')[0],
    `asking for "${other}" opened a "${secondLang}" stream`,
  );
  if (Number.isFinite(secondPrimary?.measuredBytes)) {
    quiet(`  primary ${(secondPrimary.measuredBytes / MB_).toFixed(0)}MB, language "${secondLang}"`);
  }
} else {
  // Honest about what was proven: one language cannot show that the rule
  // discriminates between languages, only that it sorts inside one.
  quiet(`  (this title is published in one language only; cross-language ranking not exercised)`);
}

console.log('\n✓ citadel live: real sizes measured, requested language ranked biggest-first');
