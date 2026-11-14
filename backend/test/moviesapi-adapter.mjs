import assert from 'node:assert/strict';
import { fetchFromMoviesApi } from '../../dist/backend/sources/source19.js';

const requested = [];
const fetcher = async (input, options) => {
  const url = new URL(input);
  requested.push(url);
  assert.equal(options.headers['x-player-key'], '3a67e8866ae1d2bb9e81fe7f73315a56eb3bdf5e3e755c7554c8be6910aa6b13');
  assert.equal(options.headers.Referer, 'https://moviesapi.to/');
  assert.equal(url.pathname, '/api/vidora/v1/tv/93405/1/2');
  return Response.json({ result: true, sources: [{
    url: 'https://cdn.example/master.m3u8',
    tracks: [{ file: 'https://cdn.example/en.vtt', label: 'English' }],
  }] });
};
const candidates = await fetchFromMoviesApi({ type: 'tv', tmdbId: '93405', season: 1, episode: 2 }, fetcher);
assert.equal(requested.length, 1);
assert.equal(candidates.length, 1);
assert.equal(candidates[0].type, 'hls');
assert.equal(candidates[0].url, 'https://cdn.example/master.m3u8');
assert.equal(candidates[0].subtitles[0].url, 'https://cdn.example/en.vtt');
assert.deepEqual(await fetchFromMoviesApi({ type: 'movie', tmdbId: 'not-numeric' }, fetcher), []);
console.log('✓ MoviesAPI/FMovies HLS endpoint, authenticated request headers, captions, and input validation');
