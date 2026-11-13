import assert from 'node:assert/strict';
import { fetchFromBingr } from '../../dist/backend/sources/source4.js';

const original = globalThis.fetch;
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ url, init });
  assert.equal(init.redirect, 'error');
  assert.equal(new Headers(init.headers).get('origin'), 'https://bingr.one');
  if (url.pathname === '/api/details/movie/693134') {
    return Response.json({ title: 'Dune: Part Two', year: '2024' });
  }
  if (url.pathname === '/api/details/tv/1396') {
    return Response.json({ title: 'Breaking Bad', year: '2008' });
  }
  if (url.pathname === '/api/stream') {
    const body = JSON.parse(init.body);
    assert.equal(body.id, '693134');
    assert.equal(body.t, 'movie');
    assert.equal(body.query.title, 'Dune: Part Two');
    assert.equal(body.query.year, '2024');
    if (body.srv === 's70') {
      return Response.json({ sources: [
        { url: 'https://cdn.example.org/movie.m3u8', type: 'hls', quality: '1080p', language: 'Hindi', headers: { Referer: 'https://bingr.one/watch/' } },
        { url: 'https://cdn.example.org/movie.mp4', type: 'mp4', quality: '720p' },
        { url: 'https://evil.example/embed/player', type: 'iframe' },
        { url: 'http://127.0.0.1/private.m3u8', type: 'hls' },
      ] });
    }
    return Response.json({ sources: [] });
  }
  if (url.pathname === '/api/stream/aphelion-tv/1396/1/1') {
    assert.equal(init.method, undefined);
    return Response.json({ sources: [{ url: 'https://cdn.example.org/episode.m3u8', type: 'hls' }] });
  }
  throw new Error(`Unexpected Bingr request: ${url.pathname}`);
};

try {
  const movie = await fetchFromBingr({ type: 'movie', tmdbId: '693134' });
  assert.equal(movie.length, 2);
  assert.equal(movie[0].audioLang, 'hi');
  assert.equal(movie[0].type, 'hls');
  assert.equal(movie[0].headers.Referer, 'https://bingr.one/watch/');
  assert.equal(movie[1].type, 'mp4');

  const tv = await fetchFromBingr({ type: 'tv', tmdbId: '1396', season: 1, episode: 1 });
  assert.equal(tv.length, 1);
  assert.equal(tv[0].url, 'https://cdn.example.org/episode.m3u8');
  assert(requests.some(({ url }) => url.pathname === '/api/stream/aphelion-tv/1396/1/1'));
  assert.deepEqual(await fetchFromBingr({ type: 'movie', tmdbId: '../../bad' }), []);
} finally {
  globalThis.fetch = original;
}
console.log('✓ Bingr official API, TV-specific endpoint, media filtering, headers, and validation');
