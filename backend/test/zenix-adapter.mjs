import assert from 'node:assert/strict';
import { fetchFromZenix } from '../../dist/backend/sources/source20.js';

const requests = [];
const fetcher = async (input, options) => {
  const url = new URL(input);
  requests.push(url);
  assert.equal(options.headers.Referer, 'https://zenix.website/');
  assert.equal(options.headers['sec-fetch-mode'], 'cors');
  if (url.pathname === '/api/boot/movie/693134') {
    assert.equal(url.searchParams.get('key'), 'k_dd6ed463ad5bbd10301e1eec');
    return Response.json({ meta: { playbackToken: 'short-lived-player-token' } });
  }
  assert.equal(url.pathname, '/api/source/movie/693134');
  assert.equal(url.searchParams.get('token'), 'short-lived-player-token');
  if (url.searchParams.get('provider') === 'moviebox') {
    return Response.json({ streams: [
      { url: '/api/orion/abc/master.m3u8', name: 'MovieBox', rungs: [{ height: 1080 }] },
      { url: 'http://127.0.0.1/private.m3u8', name: 'unsafe' },
    ] });
  }
  return Response.json({ streams: [{ url: 'https://cdn.example/file.mp4', type: 'video/mp4', name: 'VAPlayer' }] });
};
const candidates = await fetchFromZenix({ type: 'movie', tmdbId: '693134' }, fetcher);
assert.equal(requests.length, 3, 'boot once and query both provider families');
assert.equal(candidates.length, 2, 'reject unsafe streams while keeping direct HLS and MP4');
assert.equal(candidates[0].url, 'https://embed.vidrift.in/api/orion/abc/master.m3u8');
assert.equal(candidates[0].type, 'hls');
assert.equal(candidates[0].headers.Referer, 'https://embed.vidrift.in/');
assert.equal(candidates[0].quality, '1080p');
assert.equal(candidates[1].type, 'mp4');
assert.deepEqual(await fetchFromZenix({ type: 'tv', tmdbId: 'bad', season: 1, episode: 1 }, fetcher), []);
assert.equal(requests.length, 3);
console.log('✓ Zenix boot/token flow, provider queries, HLS/MP4 classification, headers, and SSRF rejection');
