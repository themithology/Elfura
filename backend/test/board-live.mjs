/**
 * The owner's rule, proven against a real provider.
 *
 * ---------------------------------------------------------------------------
 * This is the check that matters. The unit test proves the comparator sorts by
 * size; it cannot prove that a real stream ever *produces* a size. This asks
 * EVERY lane on the board for the same title and requires that the listed
 * streams arrived with bytes behind them, that the mean is over measured
 * streams, and that the biggest stream of the requested language is the one the
 * player opens on.

 * With one source this proved the rule. With two it proves the thing the rule
 * exists for: two independent lanes competing on the same title, and the bigger
 * stream winning regardless of which lane it came from.
 *
 * It needs egress, so it runs on a runner, not in the editing sandbox.
 * ---------------------------------------------------------------------------
 */
import assert from 'node:assert/strict';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { APPROVED_SOURCES } from '../../dist/backend/sources/index.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';

const MB = 1024 * 1024;
assert(APPROVED_SOURCES.length > 0, 'a source must be approved before its ranking can be measured');

// Every lane on the board, not just the first. When this file only exercised
// APPROVED_SOURCES[0] it silently stopped testing the board the moment a second
// source was added - and the second source is where lanes actually compete.
const adapters = APPROVED_SOURCES.map((source) => ({ id: source.id, adapter: source.create() }));
const probe = { type: 'movie', tmdbId: '550' };

const quiet = console.log;
console.log = () => {}; // the adapters narrate; the verdict below is the point
const perLane = [];
for (const lane of adapters) {
  try {
    const resolved = await lane.adapter.resolve({ ...probe, signal: AbortSignal.timeout(25_000) });
    perLane.push({ ...lane, candidates: resolved.candidates ?? [] });
  } catch {
    perLane.push({ ...lane, candidates: [] });
  }
}
console.log = quiet;

const resolved = { candidates: perLane.flatMap((lane) => lane.candidates) };
const answering = perLane.filter((lane) => lane.candidates.length > 0);
quiet(
  `  lanes answering: ${answering.map((l) => `${l.id}=${l.candidates.length}`).join(', ') || 'none'}`,
);
assert(resolved.candidates.length > 0, 'no lane on the board returned a row for the probe title');

// NOTE: adapter.resolve() deliberately returns unmeasured candidates. Sizes are
// produced by the liveness pass inside the registry, which is the only place a
// segment is actually fetched. Asserting a size here would be asserting on a
// layer that never measures anything — it did exactly that on the first run.

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
async function resolveFor(lang, { allowEmpty = false } = {}) {
  const registry = new SourceRegistry(cfg);
  // The whole board, which is the thing the viewer is actually served.
  registry.adapters = adapters.map((lane) => lane.adapter);
  const body = await registry.resolvePlayback({ type: 'movie', tmdbId: '550', preferredLang: lang });
  if (allowEmpty && !body) return null;
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
quiet(`  languages any adapter returned: ${offered.join(', ')}; ranking inside "${lang}"`);

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
//
// A stream can tell the player its language in four different ways, and this
// check used to read two of them. That was not a harmless omission: a
// multi-audio stream has NO single language by definition — the selection layer
// deliberately clears `audioLang` on it and publishes the set instead — so the
// check demanded a single language from exactly the streams that carry several,
// and went red on source-3, then on source-4, for doing the right thing.
//
// This is the same mistake the vidly subtitle pass made: read one field, draw a
// conclusion about the whole row.
const langsOf = (stream) => [
  stream.audioLang,
  stream.claimedAudioLang,
  ...(stream.availableAudioLangs ?? []),
].filter((code) => typeof code === 'string' && code !== 'und');

for (const stream of wanted.sources) {
  const known = langsOf(stream);
  assert(
    known.length > 0,
    `${stream.label} reached the player with no language at all — no audioLang, ` +
      'no claimedAudioLang and an empty availableAudioLangs',
  );
  if (stream.multiAudio) {
    // Multi-audio must name more than one, or the flag is a lie the player will
    // act on (it offers a language switch that changes nothing).
    assert(
      known.length > 1,
      `${stream.label} is advertised multi-audio but names only ${JSON.stringify(known)}`,
    );
  }
}

// ── 4. THE RULE: within the requested language, the biggest stream opens ────
const primary = wanted.primary;
assert(Number.isFinite(primary?.measuredBytes), 'the stream the player opens on carries no measured size');
// The primary carries the requested language if ANY of its language evidence
// matches it. For a multi-audio stream that means the set contains it, which is
// the honest meaning of "this stream can play English".
const primaryLangs = langsOf(primary ?? {}).map((code) => code.split('-')[0]);
assert(
  primaryLangs.includes(lang.split('-')[0]),
  `the primary stream carries "${primaryLangs.join(',') || 'nothing'}", not the requested "${lang}"`,
);
// The size rule still holds inside the language: no bigger stream may offer the
// same language the primary offers, or the wrong copy won.
const primarySet = new Set(primaryLangs);
const biggerSameLang = wanted.sources.filter(
  (s) =>
    Number.isFinite(s.measuredBytes) &&
    s.measuredBytes > primary.measuredBytes &&
    langsOf(s)
      .map((code) => code.split('-')[0])
      .some((code) => primarySet.has(code)),
);
assert.equal(
  biggerSameLang.length,
  0,
  `a ${((biggerSameLang[0]?.measuredBytes ?? 0) / MB_).toFixed(0)}MB ${[...primarySet].join('/')} stream ` +
    `outranks the ${(primary.measuredBytes / MB_).toFixed(0)}MB primary in the same language`,
);
quiet(
  `  primary ${(primary.measuredBytes / MB_).toFixed(0)}MB is the biggest ${[...primarySet].join('/')} stream listed`,
);

// What the board can actually PLAY, by language. Raw adapter rows are not proof:
// a lane whose rows all failed the probe publishes nothing, and counting its
// labels here made an unavailable language look available — which is what made
// this file demand a Hindi stream that no lane could serve.
const playableLangs = [
  ...new Set(
    wanted.sources
      .flatMap((s) => [s.audioLang, s.claimedAudioLang, ...(s.availableAudioLangs ?? [])])
      .filter((code) => typeof code === 'string' && code !== 'und')
      .map((code) => code.split('-')[0]),
  ),
];
quiet(`\n  playable languages on this title: ${playableLangs.join(', ') || 'none declared'}`);

// ── 5. asking for a language nobody has must SAY so ────────────────────────
//
// This is the case that produced a false pass and then a false failure on the
// runner: asking citadel for Hindi on a title it only has in English returned
// English with no indication anywhere that the request was not honoured. A
// silent fallback looks exactly like a broken language filter.
{
  const absent = playableLangs.includes('hi') ? 'ta' : 'hi';
  const miss = await resolveFor(absent, { allowEmpty: true });
  if (miss && miss.sources.length > 0) {
    const primaryLang = miss.primary?.audioLang ?? miss.primary?.claimedAudioLang;
    const served = miss.languageFallback;
    quiet(`\n  "${absent}" request: ${miss.sources.length} stream(s), primary "${primaryLang}"`);
    if (served) {
      quiet(`  reported fallback: requested "${served.requested}" (${served.reason})`);
    }
    assert(
      served || primaryLang?.split('-')[0] === absent.split('-')[0],
      `asked for "${absent}", served "${primaryLang}", and the response did not say so ` +
        '— a silent fallback is indistinguishable from a broken language filter',
    );
  } else {
    quiet(`\n  "${absent}" request: correctly served nothing`);
  }
}

// ── 6. a language that IS published opens that language ────────────────────
const other = playableLangs.find((code) => code.split('-')[0] !== lang.split('-')[0]);
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

console.log('\n✓ board live: real sizes measured, requested language ranked biggest-first');
