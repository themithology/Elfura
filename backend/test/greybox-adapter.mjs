/**
 * Greybox (source-2): the three mistakes that made this lane look dead, pinned.
 *
 * The research harness recorded 502s and a 429 for this lane and drew "0/4".
 * Each of those had a specific cause, and each cause gets a test here so it
 * cannot come back:
 *
 *   1. it scored the payload's WORST row — an absolute `workers.dev` bridge that
 *      answers 502 — while the majority of rows are relative `/api/media?u=`,
 *      which were measured 8/8 as real `#EXTM3U`. Relative rows must be resolved.
 *   2. a TV 429 was treated as "no streams". A throttle must be retried, and it
 *      must be distinguishable from a real failure.
 *   3. rows were counted, not tokenised. A row with no readable language must not
 *      become a candidate that can win a language-filtered race by accident.
 *
 * Fixtures are trimmed copies of the shape documented by the retired Source 25
 * adapter, which measured this payload directly.
 */
import assert from 'node:assert/strict';
import {
  absolveRowUrl,
  greyboxCandidates,
  greyboxUrl,
  rowLanguage,
  rowQuality,
  rowType,
} from '../../dist/backend/sources/greybox.js';

const ORIGIN = 'https://greyboxtv.duckdns.org';
const MB = 1024 * 1024;

const row = (over = {}) => ({
  provider: 'moviebox',
  label: 'MovieBox',
  type: 'hls',
  quality: '1080p',
  height: 1080,
  language: 'en',
  audio: ['en'],
  subtitles: [],
  ...over,
});

console.log('— row language');
{
  assert.equal(rowLanguage('en'), 'en');
  assert.equal(rowLanguage('en-2'), 'en', 'a second English track is still English');
  assert.equal(rowLanguage('ar-3'), 'ar');
  assert.equal(rowLanguage('HI'), 'hi');
  assert.equal(rowLanguage('und'), null, 'und is not a language');
  assert.equal(rowLanguage('x7'), null, 'junk codes are not languages');
  assert.equal(rowLanguage(''), null);
  assert.equal(rowLanguage(undefined), null);
}

console.log('— quality, from height first');
{
  assert.equal(rowQuality('1080p', 1080), '1080p');
  assert.equal(rowQuality('720p', 720), '720p');
  assert.equal(rowQuality(undefined, 1080), '1080p', 'a height alone is enough');
  assert.equal(rowQuality('4K', 2160), '2160p');
  assert.equal(rowQuality('auto', undefined), 'auto');
  assert.equal(rowQuality('480p', 999999), '480p', 'an implausible height falls back to the label, not to nothing');
}

console.log('— the relay rejection and the relative-URL rescue');
{
  // The exact shape that produced a 502 and made this lane look dead.
  assert.equal(
    absolveRowUrl('https://dash-hls-bridge.john1mc.workers.dev/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F1%2Fmaster.m3u8', ORIGIN),
    null,
    'a third-party relay front must be refused, not promoted',
  );
  // The shape that was never tried, and that mostly works.
  assert.equal(
    absolveRowUrl('/api/media?u=m1.abcdef&t=1', ORIGIN),
    `${ORIGIN}/api/media?u=m1.abcdef&t=1`,
    'the provider\u2019s own proxy row must be resolved, never discarded',
  );
  assert.equal(absolveRowUrl('api/media?u=m1', ORIGIN), `${ORIGIN}/api/media?u=m1`);
  assert.equal(absolveRowUrl('http://plain.example/x.m3u8', ORIGIN), null, 'plain http is refused');
  assert.equal(absolveRowUrl('', ORIGIN), null);
  assert.equal(absolveRowUrl('https://user:pass@host.example/x', ORIGIN), null, 'credentials in a URL are refused');
}

console.log('— type inference: /api/media carries no extension');
{
  assert.equal(rowType(undefined, `${ORIGIN}/api/media?u=m1`), 'hls', 'extensionless proxy rows are HLS');
  assert.equal(rowType('dash', `${ORIGIN}/api/media?u=m1`), 'dash');
  assert.equal(rowType(undefined, 'https://cdn.example/x.mpd'), 'dash');
  assert.equal(rowType(undefined, 'https://cdn.example/x.mp4'), 'mp4');
  assert.equal(rowType('hls', `${ORIGIN}/api/media?u=m1`), 'hls');
}

console.log('— the payload: a mix of relay and local rows');
{
  const body = {
    sources: [
      // First URL in the payload — this is what the harness scored.
      row({
        url: 'https://dash-hls-bridge.john1mc.workers.dev/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fdash%2F4046544153143035520_0_0_1080_h265_235%2Fmaster.m3u8',
        quality: '1080p',
      }),
      // The majority: greybox's own proxy.
      row({ url: '/api/media?u=m1.aaa', language: 'hi', quality: '720p', height: 720, provider: 'moviebox' }),
      row({ url: '/api/media?u=m1.bbb', language: 'ta-2', quality: '1080p', height: 1080, provider: 'showbox' }),
      row({ url: '/api/media?u=m1.ccc', language: 'en', quality: '480p', height: 480, provider: 'moviebox' }),
      // No readable language: refused.
      row({ url: '/api/media?u=m1.ddd', language: 'und' }),
      // Duplicate of a kept row.
      row({ url: '/api/media?u=m1.aaa', language: 'hi' }),
      // Intro/credits markers.
      row({ url: '/api/media?u=m1.eee', language: 'te', intro: { start: 0, end: 92 }, credits: { start: 2400, end: 2500 } }),
    ],
    resolvedAt: '2026-11-24T00:00:00Z',
    failures: [],
  };

  const parsed = greyboxCandidates(body, ORIGIN);
  const urls = parsed.candidates.map((c) => c.url);

  assert.equal(parsed.candidates.length, 4, 'relay and unlabelled rows are refused, the duplicate collapses');
  assert.ok(
    !urls.some((u) => u.includes('workers.dev')),
    'no relay URL may reach the player',
  );
  assert.ok(
    urls.every((u) => u.startsWith(ORIGIN)),
    'every kept row is on the provider origin',
  );
  assert.deepEqual(
    parsed.candidates.map((c) => c.claimedAudioLang),
    ['hi', 'ta', 'en', 'te'],
    'qualifiers are stripped and und is dropped',
  );
  assert.deepEqual(parsed.languages, ['hi', 'en', 'ta', 'te'], 'languages in the order the payload presents them');
  assert.deepEqual(parsed.segments.intro, [0, 92]);
  assert.deepEqual(parsed.segments.outro, [2400, 2500]);
  assert.equal(parsed.candidates[0].type, 'hls', 'extensionless rows are typed HLS');
  assert.ok(parsed.candidates[0].headers?.Referer, 'rows need provider headers or the CDN refuses');
}

console.log('— malformed answers are refused, not thrown');
{
  assert.deepEqual(greyboxCandidates(null, ORIGIN).candidates, []);
  assert.deepEqual(greyboxCandidates({}, ORIGIN).candidates, []);
  assert.deepEqual(greyboxCandidates({ sources: 'nope' }, ORIGIN).candidates, []);
  assert.deepEqual(greyboxCandidates({ sources: [null, 7, 'x'] }, ORIGIN).candidates, []);
}

console.log('— api url');
{
  assert.equal(
    greyboxUrl({ type: 'movie', tmdbId: '550' }, ORIGIN),
    `${ORIGIN}/api/player/sources?media=movie&id=550`,
  );
  assert.equal(
    greyboxUrl({ type: 'tv', tmdbId: '1399', season: 1, episode: 2 }, ORIGIN),
    `${ORIGIN}/api/player/sources?media=tv&id=1399&season=1&episode=2`,
  );
  assert.equal(greyboxUrl({ type: 'movie', tmdbId: 'abc' }, ORIGIN), null);
}

console.log('— the throttle path, end to end through the adapter');
{
  // 429 then 200: the lane must retry and deliver, not report empty.
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response('slow down', { status: 429 });
    return Response.json({
      sources: [row({ url: '/api/media?u=m1.worked', language: 'hi', quality: '1080p', height: 1080 })],
    });
  };
  const { createGreyboxAdapter } = await import('../../dist/backend/sources/greybox.js');
  const adapter = createGreyboxAdapter({ origin: ORIGIN });
  const quiet = console.log;
  const quietWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  const resolved = await adapter.resolve({ type: 'tv', tmdbId: '1399', season: 1, episode: 1 });
  console.log = quiet;
  console.warn = quietWarn;

  assert.equal(calls.length, 2, 'a throttle is asked once more, not given up on');
  assert.equal(resolved.candidates.length, 1, 'the retry delivered the stream');
  assert.equal(resolved.candidates[0].claimedAudioLang, 'hi');
  assert.equal(adapter.id, 'source-2');
  assert.equal(adapter.traits?.includes('aggregator'), true, 'the lane fronts several upstreams and says so');
}

console.log('— a hard failure is not retried and reports empty');
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('nope', { status: 500 });
  };
  const { createGreyboxAdapter } = await import('../../dist/backend/sources/greybox.js');
  const adapter = createGreyboxAdapter({ origin: ORIGIN });
  const quiet = console.warn;
  console.warn = () => {};
  const resolved = await adapter.resolve({ type: 'movie', tmdbId: '550' });
  console.warn = quiet;
  assert.equal(calls, 1, 'a 500 is an answer, not a throttle');
  assert.equal(resolved.candidates.length, 0);
}

console.log('\n✓ greybox: relative rows kept, relays refused, throttles retried, languages read');
