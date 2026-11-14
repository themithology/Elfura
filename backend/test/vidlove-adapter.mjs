import assert from 'node:assert/strict';
import { fetchFromVidLove } from '../../dist/backend/sources/source18.js';

const requested = [];
const fetcher = async (input, options) => {
  const url = new URL(input);
  requested.push(url);
  assert.equal(options.headers.Referer, 'https://player.vidlove.cc/');
  assert.equal(url.pathname, '/tv');
  assert.equal(url.searchParams.get('id'), '1396');
  assert.equal(url.searchParams.get('season'), '1');
  assert.equal(url.searchParams.get('episode'), '2');
  const variant = url.searchParams.get('sources') || 'default';
  return Response.json({ source: {
    url: `https://cdn.example/${variant}.m3u8`,
    manifest: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080\nhi.m3u8',
    tracks: [{ file: 'https://cdn.example/en.vtt', label: 'English', language: 'en' }],
  } });
};
const result = await fetchFromVidLove({ type: 'tv', tmdbId: '1396', season: 1, episode: 2, diag: [] }, fetcher);
assert.equal(requested.length, 8, 'probe the variants used by CineHD/CineJoy in one bounded parallel pass');
assert.equal(result.length, 8);
assert(result.every(candidate => candidate.type === 'hls' && candidate.quality === '1080p'));
assert(result.every(candidate => candidate.headers.Referer === 'https://player.vidlove.cc/'));
assert(result.every(candidate => candidate.subtitles?.[0]?.lang === 'en'));
assert.equal(result[0].claimedAudioLang, undefined, 'do not treat provider labels as verified audio evidence');
assert.deepEqual(await fetchFromVidLove({ type: 'movie', tmdbId: 'bad' }, fetcher), []);
assert.equal(requested.length, 8);
console.log('✓ VidLove CineHD/CineJoy variants, TV params, headers, subtitle hints, and validation');
