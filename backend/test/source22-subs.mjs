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

check('with no bare "English", a clean numbered track beats an HI track', () => {
  // Captured verbatim from /api/subtitles?kind=tv&tmdb=1399&season=1&episode=1.
  // This is the real-world shape: there is no un-suffixed "English" to prefer.
  const live = {
    subtitles: [
      { url: `${VTT}/English Hi.vtt`, lang: 'en', label: 'English (HI)', group: 'English' },
      { url: `${VTT}/English Hi4.vtt`, lang: 'en', label: 'English 4 (HI)', group: 'English' },
      { url: `${VTT}/English2.vtt`, lang: 'en', label: 'English 2', group: 'English' },
      { url: `${VTT}/English3.vtt`, lang: 'en', label: 'English 3', group: 'English' },
      { url: `${VTT}/English6.vtt`, lang: 'en', label: 'English 6', group: 'English' },
    ],
  };
  const english = vidlySubtitleTracks(live).filter((t) => t.lang === 'en');
  assert.equal(english.length, 1, 'one English track only');
  assert.equal(english[0].label, 'English 2', `expected the cleanest lowest variant, got "${english[0].label}"`);
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

check('tv queries use kind=tv (kind=series silently returns zero tracks)', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ subtitles: [] }), { status: 200 });
  };
  try {
    const { fetchFromVidlySubtitles } = await import('../../dist/backend/sources/source22.js');
    await fetchFromVidlySubtitles({ type: 'tv', tmdbId: '1399', season: 1, episode: 2 });
    await fetchFromVidlySubtitles({ type: 'movie', tmdbId: '1010581' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(seen[0], /kind=tv/, `expected kind=tv, got ${seen[0]}`);
  assert.match(seen[0], /season=1/, 'season must be sent');
  assert.match(seen[0], /episode=2/, 'episode must be sent');
  assert.match(seen[1], /kind=movie/, `expected kind=movie, got ${seen[1]}`);
  assert.ok(!seen[1].includes('season='), 'a movie query must not carry season');
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
  // This run is pointed at a dead host (signal timeout), so `ok` is false. When
  // the lane does fetch tracks, `ok` is true — see the next case. Reporting a
  // successful subtitle fetch as a failure was putting a working lane in the
  // "answered nothing" list on CI.
  assert.match(diag[0].detail, /subtitles-only/);
});

await check('a successful subtitle fetch reports ok:true but still no stream', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ subtitles: [
      { url: `${VTT}/Hindi.vtt`, lang: 'hi', label: 'Hindi', group: 'Hindi' },
      { url: `${VTT}/Tamil.vtt`, lang: 'ta', label: 'Tamil', group: 'Tamil' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const diag = [];
    const adapter = createSource22Adapter(() => true);
    const result = await adapter.resolve({ type: 'movie', tmdbId: '1010581', diag });
    assert.equal(result.candidates.length, 0, 'still no video candidate');
    assert.equal(diag[0].ok, true, 'a working subtitle lane must not report as failed');
    assert.match(diag[0].detail, /tracks=2/);
    assert.match(diag[0].detail, /subtitles-only/, 'the panel must still know it is subtitle-only');
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
