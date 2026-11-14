import assert from 'node:assert/strict';
import { fetchFromNxsha, NXSHA_SERVER_PRIORITY, nxEncode, nxDecode } from '../../dist/backend/sources/source5.js';

const rotated = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const seen = [];
const transport = {
  preferCurl: false,
  fetch: async (input) => {
    const url = new URL(input);
    seen.push(url.pathname);
    if (url.pathname === '/embed/movie/27205') {
      return new Response('<script src="/_next/static/chunks/app.js"></script>');
    }
    if (url.pathname === '/_next/static/chunks/app.js') {
      return new Response(`self.x="${rotated}"`);
    }
    if (url.pathname.startsWith('/api/')) {
      const query = nxDecode(url.searchParams.get('q'));
      const payload = url.pathname.endsWith('/servers')
        ? { servers: [{ scraper: NXSHA_SERVER_PRIORITY[0] }] }
        : { sources: [{ url: 'https://cdn.example.org/rotated.m3u8', type: 'hls' }] };
      assert.equal(query.tmdbId, '872585');
      return Response.json({ _hash: nxEncode(payload, rotated) });
    }
    throw new Error(`unexpected request ${url}`);
  },
};
const streams = await fetchFromNxsha({ type: 'movie', tmdbId: '872585', diag: [] }, [NXSHA_SERVER_PRIORITY[0]], transport);
assert.equal(streams.length, 1, 'fetcher should recover when the upstream rotates its protocol passphrase');
assert.equal(streams[0].url, 'https://cdn.example.org/rotated.m3u8');
assert(seen.includes('/embed/movie/27205'));
assert(seen.includes('/_next/static/chunks/app.js'));
console.log('Nxsha passphrase-rotation recovery passed');
