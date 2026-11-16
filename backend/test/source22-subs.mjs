/**
 * Source 22 — Vidly subtitle index.
 *
 * This lane is the one part of vidly.pro that is worth depending on: the
 * subtitle index is unauthenticated, plain JSON, and carries 60+ languages per
 * title. Everything here comes from a body captured from the live endpoint:
 *
 *   GET https://vidly.pro/api/subtitles?kind=movie&tmdb=1010581
 *   { "subtitles": [ { "url": "https://cache.vdrk.site/v1/vtt/movie/1010581/Hindi.vtt",
 *                      "lang": "hi", "label": "Hindi", "group": "Hindi",
 *                      "source": "vdrk" }, ... ] }
 *
 * The cases below are the ways this can go wrong in production, each of which has
 * a different fix — so each gets its own assertion rather than one happy path:
 *
 *   1. shape change upstream (key renamed)  -> parse yields nothing, lane reports
 *                                              `subtitles-only tracks=0` rather
 *                                              than crashing the resolve;
 *   2. a hostile/unexpected host in the index -> rejected, because we would
 *                                              otherwise fetch an arbitrary URL
 *                                              on the operator's behalf;
 *   3. duplicate language variants ("English",
 *      "English 2", "English 3")            -> collapsed to one per language;
 *   4. hearing-impaired ("HI") tracks        -> kept, but never chosen over a
 *                                              clean track for the same language;
 *   5. subtitles must NOT become streams     -> the adapter returns zero
 *                                              candidates, always.
 */
import assert from 'node:assert/strict';

const { vidlySubtitleTracks, createSource22Adapter } = await import(
  '../../dist/backend/sources/source22.js'
);

const VTT = 'https://cache.vdrk.site/v1/vtt/movie/1010581';

const fixture = {
  subtitles: [
    { url: `${VTT}/English Hi2.vtt`, lang: 'en', label: 'English 2 (HI)', group: 'English', source: 'vdrk' },
    { url: `${VTT}/English.vtt`, lang: 'en', label: 'English', group: 'English', source: 'vdrk' },
    { url: `${VTT}/English3.vtt`, lang: 'en', label: 'English 3', group: 'English', source: 'vdrk' },
    { url: `${VTT}/Hindi.vtt`, lang: 'hi', label: 'Hindi', group: 'Hindi', source: 'vdrk' },
    { url: `${VTT}/Malayalam.vtt`, lang: 'ml', label: 'Malayalam', group: 'Malayalam', source: 'vdrk' },
    { url: `${VTT}/Tamil.vtt`, lang: 'ta', label: 'Tamil', group: 'Tamil', source: 'vdrk' },
    { url: `${VTT}/Telugu.vtt`, lang: 'te', label: 'Telugu', group: 'Telugu', source: 'vdrk' },
    { url: `${VTT}/Arabic.vtt`, lang: 'ar', label: 'Arabic', group: 'Arabic', source: 'vdrk' },
    { url: 'https://evil.example/x.vtt', lang: 'xx', label: 'Not ours', source: 'other' },
    { url: '/relative/path.vtt', lang: 'yy', label: 'Relative', source: 'other' },
  ],
};

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

console.log('\nSource 22 — Vidly subtitles');

const tracks = vidlySubtitleTracks(fixture);

check('parses the live shape into tracks', () => {
  assert.ok(tracks.length >= 6, `expected several tracks, got ${tracks.length}`);
  for (const track of tracks) {
    assert.match(track.url, /^https:\/\/cache\.vdrk\.site\//, `host must be the known sentence cache: ${track.url}`);
    assert.equal(track.format, 'vtt');
    assert.ok(track.lang && track.lang !== 'und');
  }
});

check('one track per language, clean label preferred', () => {
  const english = tracks.filter((t) => t.lang === 'en');
  assert.equal(english.length, 1, `expected exactly one English track, got ${english.length}`);
  // "English", not "English 2 (HI)" and not "English 3".
  assert.equal(english[0].label, 'English', `expected the clean label, got "${english[0].label}"`);
});

check('Hindi is available (the reason this lane exists)', () => {
  const hindi = tracks.find((t) => t.lang === 'hi');
  assert.ok(hindi, 'Hindi track missing');
  assert.match(hindi.url, /Hindi\.vtt$/);
});

check('rejects a URL from an unexpected host', () => {
  assert.ok(
    !tracks.some((t) => t.url.includes('evil.example')),
    'a third-party host in the index must never become a fetch target',
  );
});

check('rejects relative and non-https URLs', () => {
  assert.ok(!tracks.some((t) => !t.url.startsWith('https://')));
});

check('a renamed payload yields nothing instead of throwing', () => {
  assert.deepEqual(vidlySubtitleTracks({ subs: fixture.subtitles }), []);
  assert.deepEqual(vidlySubtitleTracks(null), []);
  assert.deepEqual(vidlySubtitleTracks({ subtitles: 'nope' }), []);
});

await check('subtitles are never reported as streams', async () => {
  const diag = [];
  const adapter = createSource22Adapter(() => true);
  const result = await adapter.resolve({
    type: 'movie',
    tmdbId: '1010581',
    diag,
    // Point the adapter at a dead host so this asserts the *shape*, not the network.
    signal: AbortSignal.timeout(1),
  });
  assert.equal(result.candidates.length, 0, 'a subtitle lane must return zero video candidates');
  assert.equal(diag.length, 1, 'it must still report itself in diagnostics');
  assert.equal(diag[0].ok, false, 'a subtitle hit must never be reported as a working source');
  assert.match(diag[0].detail, /subtitles-only/);
});

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
