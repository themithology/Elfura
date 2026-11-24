import assert from 'node:assert/strict';
import {
  DURATION_TOLERANCE_SEC,
  durationFits,
  durationToleranceSec,
} from '../../dist/backend/sources/duration.js';
import { sumHlsDurationSec } from '../../dist/backend/sources/liveness.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

const keepAlive = setInterval(() => {}, 1000);
const original = globalThis.fetch;

/* ── the pure rule ── */
assert.equal(DURATION_TOLERANCE_SEC.movie, 1200, 'movies get ±20 minutes');
assert.equal(DURATION_TOLERANCE_SEC.tv, 300, 'episodes get ±5 minutes');

// Breaking Bad S1E1 is 47 minutes.
assert.equal(durationFits(47 * 60, 47 * 60, 300), true, 'exact runtime');
assert.equal(durationFits(44 * 60, 47 * 60, 300), true, 'a little short is fine');
assert.equal(durationFits(51 * 60, 47 * 60, 300), true, 'a little long is fine');
assert.equal(durationFits(2 * 60, 47 * 60, 300), false, 'a 2-minute clip is not the episode');
assert.equal(durationFits(20, 47 * 60, 300), false, 'a 20-second bumper is not the episode');
assert.equal(durationFits(0, 47 * 60, 300), true, 'zero means unmeasured, and unmeasured never rejects');
assert.equal(durationFits(null, 47 * 60, 300), true, 'unmeasurable is never rejected');
assert.equal(durationFits(47 * 60, null, 300), true, 'unknown expected runtime never rejects');
assert.equal(durationFits(3 * 60, null, 300), true);

// A double episode (94 min) must not pass as one 47-minute episode.
assert.equal(durationFits(94 * 60, 47 * 60, 300), false, 'double episode is rejected');
// ...but a real 2-hour film ±20 min window accepts a 1h45 print.
assert.equal(durationFits(105 * 60, 120 * 60, 1200), true);
assert.equal(durationFits(40 * 60, 120 * 60, 1200), false, 'a 40-minute "movie" is not a 2-hour film');

// Short content keeps its own scale instead of being judged by ±20 min.
assert.equal(durationToleranceSec('movie', 4 * 60), 120, 'a short film is judged on its own scale');
assert.equal(durationToleranceSec('movie', 30), 60, 'the floor keeps tiny runtimes from collapsing to zero');
assert.equal(durationToleranceSec('tv', 47 * 60), 300);

/* ── playlist measurement ── */
const vod = (segments) =>
  ['#EXTM3U', '#EXT-X-TARGETDURATION:6', ...segments.flatMap(() => ['#EXTINF:6.0,', 'seg.ts']), '#EXT-X-ENDLIST'].join('\n');
assert.equal(sumHlsDurationSec(vod(new Array(470).fill(0))), 2820, '47 minutes of 6 s segments');
assert.equal(sumHlsDurationSec(vod(new Array(20).fill(0))), 120, '2-minute clip measures as 2 minutes');
assert.equal(sumHlsDurationSec(['#EXTM3U', '#EXTINF:6.0,', 'seg.ts'].join('\n')), null, 'a live playlist has no total');
assert.equal(sumHlsDurationSec('#EXTM3U\n#EXT-X-ENDLIST'), null, 'an empty playlist has no total');

/* ── end to end through the registry ── */
const manifestFor = (minutes) =>
  [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720',
    `variant-${minutes}.m3u8`,
  ].join('\n');
const variantFor = (minutes) =>
  [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:6',
    ...new Array(Math.max(1, Math.round((minutes * 60) / 6))).fill(0).flatMap(() => ['#EXTINF:6.0,', 'seg.ts']),
    '#EXT-X-ENDLIST',
  ].join('\n');

globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.startsWith('https://tmdb.example/')) {
    return Response.json({
      id: 1396,
      name: 'Breaking Bad',
      first_air_date: '2008-01-20',
      episode_run_time: [47],
      seasons: [{ season_number: 1, name: 'Season 1', episode_count: 7 }],
      overview: 'x',
    });
  }
  if (target.includes('/season/1/episode/1')) return Response.json({ name: 'Pilot', runtime: 47, air_date: '2008-01-20' });
  if (target.includes('/master-full')) return new Response(manifestFor(47), { status: 200 });
  if (target.endsWith('/variant-47.m3u8')) return new Response(variantFor(47), { status: 200 });
  if (target.includes('/master-clip')) return new Response(manifestFor(2), { status: 200 });
  if (target.endsWith('/variant-2.m3u8')) return new Response(variantFor(2), { status: 200 });
  if (target.includes('/master-long')) return new Response(manifestFor(70), { status: 200 });
  if (target.endsWith('/variant-70.m3u8')) return new Response(variantFor(70), { status: 200 });
  if (target.endsWith('seg.ts')) return new Response(new Uint8Array(2048), { status: 206, headers: { 'content-type': 'video/mp2t' } });
  return new Response('nope', { status: 404 });
};

try {
  const cfg = loadBackendConfig({
    ELFURA_SECRET: 'duration-test-secret',
    TMDB_API_BASE: 'https://tmdb.example',
    TMDB_API_KEY: 'k',
    OPENSUBTITLES_ENABLED: '0',
  });
  const registry = new SourceRegistry(cfg);
  const lane = (id, url) => ({
    id,
    label: id,
    enabled: () => true,
    resolve: async () => ({
      candidates: [{ key: `${id}:${url}`, fingerprint: `${id}:${url}`, url, type: 'hls', quality: 'auto', rank: 0 }],
    }),
  });
  registry.adapters = [
    lane('source-1', 'https://cdn.example.org/master-full.m3u8'),
    lane('source-2', 'https://cdn.example.org/master-clip.m3u8'),
    lane('source-3', 'https://cdn.example.org/master-long.m3u8'),
  ];
  const playback = await registry.resolvePlayback({ type: 'tv', tmdbId: '1396', season: 1, episode: 1 });
  assert(playback, 'the real episode survives');
  const urls = playback.sources.map((source) => source.url);
  // The guard ranks, it does not delete. The correctly-runtimed lane is first,
  // and a wrong-length stream stays available behind it rather than being
  // hidden: it plays, and an empty slot helps nobody.
  assert.ok(playback.sources.length >= 1, 'the episode still resolves');
  // URLs are sealed stream tickets, so identify lanes by the adapter that
  // produced them: source-1 is the 47-minute stream, source-2 the 2-minute clip.
  assert.equal(
    playback.sources[0].sourceId,
    'source-1',
    `the correctly-runtimed lane must be ranked first (got ${playback.sources[0]?.sourceId})`,
  );
  const clipIndex = playback.sources.findIndex((source) => source.sourceId === 'source-2');
  assert(clipIndex > 0, 'a short mismatch remains listed behind the matched episode');
  assert(playback.sources.findIndex(source => source.sourceId === 'source-3') > 0,
    'a longer episode that disagrees with metadata also remains available');
  // A filter must never empty the list: when every verified stream would be
  // dropped, the guard stands down and keeps them (and logs why).
  const clipOnly = new SourceRegistry(cfg);
  clipOnly.adapters = [
    lane('source-1', 'https://cdn.example.org/master-clip.m3u8'),
    lane('source-2', 'https://cdn.example.org/master-clip.m3u8?mirror=1'),
  ];
  const rescued = await clipOnly.resolvePlayback({ type: 'tv', tmdbId: '1396', season: 1, episode: 1 });
  assert(rescued, 'the guard must not turn a title with live streams into "no sources"');
  assert.equal(rescued.sources.length, 2, 'every verified stream is kept when the guard would empty the list');

  console.log('✓ Runtime guard: ±20 min movies / ±5 min episodes, VOD-only measurement, correct-length ranked first, wrong-length demoted not deleted.');
} finally {
  globalThis.fetch = original;
  clearInterval(keepAlive);
}
