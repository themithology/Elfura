import assert from 'node:assert/strict';
import {
  createSource21Adapter,
  fetchFromWatchout,
  watchoutCandidatesFrom,
} from '../../../dist/backend/sources/source21.js';

const original = globalThis.fetch;
const keepAlive = setInterval(() => {}, 1000);
const MASTER = 'https://sw5.aurorionacademy.site/v4/epu/99occ/cf-master.1760494247.txt';
const manifest = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="हिन्दी",LANGUAGE="hi",AUTOSELECT=YES,DEFAULT=YES,URI="index-a1.txt"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",AUTOSELECT=NO,DEFAULT=NO,URI="index-a4.txt"',
  '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2047048,RESOLUTION=1920x816,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio0"',
  'index-v1-a4.txt',
].join('\n');

try {
  // Catalogue parsing is pure and is what the adapter spends its first request on.
  assert.equal(watchoutCandidatesFrom(MASTER, 'movie', 1, 'k').length, 1, 'movie file is a bare URL');
  assert.equal(watchoutCandidatesFrom(MASTER, 'movie', 1, 'k')[0].type, 'hls');
  const season = watchoutCandidatesFrom(JSON.stringify({ '1': MASTER, '2': 'https://cdn.example.org/x/master.txt' }), 'tv', 1, 'k');
  assert.equal(season.length, 1, 'season file returns only the requested episode');
  assert.equal(season[0].url, MASTER);
  assert.equal(watchoutCandidatesFrom('{}', 'tv', 1, 'k').length, 0, 'missing episode is empty, not an error');
  assert.equal(watchoutCandidatesFrom('not-json', 'tv', 1, 'k').length, 0);
  assert.equal(watchoutCandidatesFrom('http://insecure.example/x.txt', 'movie', 1, 'k').length, 0, 'plain http is rejected');
  assert.equal(watchoutCandidatesFrom('https://localhost/x.txt', 'movie', 1, 'k').length, 0, 'private hosts are rejected');
  assert.equal(watchoutCandidatesFrom('https://cdn.example.org/x.png', 'movie', 1, 'k').length, 0, 'non-playlist files are rejected');

  // Mirror fallback: the CDN 404s, the git origin answers.
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.includes('cdn.jsdelivr.net')) return new Response('not found', { status: 404 });
    if (url.endsWith('/hls/tv/1396/S1.json')) return Response.json({ '1': MASTER });
    if (url.includes('/hls/movie/10138')) return new Response(`${MASTER}\n`, { status: 200 });
    if (url === MASTER) return new Response(manifest, { status: 200, headers: { 'content-type': 'text/plain' } });
    if (/\/index-a\d+\.txt$/.test(url) || url.endsWith('/index-v1-a4.txt')) {
      return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n#EXT-X-ENDLIST', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url.endsWith('seg1.ts')) return new Response(new Uint8Array(2048), { status: 206, headers: { 'content-type': 'video/mp2t' } });
    return new Response('nope', { status: 404 });
  };
  const tv = await fetchFromWatchout({ type: 'tv', tmdbId: '1396', season: 1, episode: 1 });
  assert.equal(tv.length, 1, 'falls back to the raw git mirror when the CDN misses');
  assert(seen.some((u) => u.includes('raw.githubusercontent.com')), 'raw origin was used');
  const movie = await fetchFromWatchout({ type: 'movie', tmdbId: '10138' });
  assert.equal(movie.length, 1);
  assert.equal(await fetchFromWatchout({ type: 'movie', tmdbId: '12/../etc' }).then((r) => r.length), 0, 'path traversal is refused');
  assert.equal(await fetchFromWatchout({ type: 'tv', tmdbId: '1396', season: 1, episode: 99 }).then((r) => r.length), 0);

  // End to end through the adapter: the master is probed and its audio group
  // becomes real language data rather than a claim.
  const adapter = createSource21Adapter(() => true);
  const diag = [];
  const result = await adapter.resolve({ type: 'tv', tmdbId: '1396', season: 1, episode: 1, diag });
  assert.equal(result.candidates.length, 1, 'adapter returns the verified lane');
  const candidate = result.candidates[0];
  assert.equal(candidate.url, MASTER);
  assert.equal(diag[0]?.detail, 'candidates=1,reachable=1');
  assert.deepEqual([...(candidate.availableAudioLangs ?? [])].sort(), ['en', 'hi']);

  // Disabled lane does nothing at all.
  const off = createSource21Adapter(() => false);
  assert.equal(off.enabled(), false);

  console.log('✓ Watchout catalogue: TMDB movie/TV lookup, CDN→git mirror fallback, playlist-only URLs, episode mapping, real audio languages from the master, bounds and toggle.');
} finally {
  globalThis.fetch = original;
  clearInterval(keepAlive);
}
