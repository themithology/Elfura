/**
 * Source 12 — VidZen.
 *
 * The CI run for movie/550 reported `candidates=16, reachable=0`. Sixteen
 * candidates were found and not one could be verified, which looks like a
 * verification problem. It was not: every candidate pointed at
 * `https://vidzen.fun/api/stream/...`, and that path is player-locked.
 *
 * Probing it directly returns an HTML page, not a stream:
 *
 *   🚫 Direct Stream Access Prohibited
 *   This video stream is protected and can only be played inside the official
 *   Vidzen player.
 *
 * That answer is the same with a valid token, with an invalid token, and with no
 * token. The adapter was pinning candidates to a URL that nothing outside their
 * player could ever fetch, so discovery worked perfectly and every result was
 * unusable by construction.
 *
 * The fix: prefer a real provider URL from the payload (`directUrl`, `rawUrl`,
 * `proxyUrl`, then `url`), and keep a player-locked URL only as a last resort,
 * ranked last, so the panel still shows the provider returned something.
 */
import assert from 'node:assert/strict';

const { createSource12Adapter } = await import('../../../dist/backend/sources/source12.js');

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

/** Serve a VidZen-shaped site with a chosen /api/sources payload. */
function withSite(payload, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/movie/550' || url.pathname === '/tv/1399/1/1') {
      return new Response('<html>"apiToken":"abcdefgh12345678"</html>', { status: 200 });
    }
    if (url.pathname === '/api/sources') {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.hostname === 'cdn.provider.example') {
      if (url.pathname.endsWith('.mp4')) {
        return new Response('x', { status: 206, headers: { 'content-type': 'video/mp4' } });
      }
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild.m3u8\nchild.m3u8');
    }
    return new Response('not found', { status: 404 });
  };
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = realFetch;
  });
}

console.log('\nSource 12 — VidZen');

await check('a provider-hosted url is used and verifies', async () => {
  await withSite(
    { sources: [{ type: 'hls', url: 'https://cdn.provider.example/master.m3u8' }] },
    async () => {
      const diag = [];
      const result = await createSource12Adapter(() => true).resolve({
        type: 'movie',
        tmdbId: '550',
        diag,
        signal: AbortSignal.timeout(8000),
      });
      assert.equal(result.candidates.length, 1, 'the provider url must survive verification');
      assert.equal(result.candidates[0].url, 'https://cdn.provider.example/master.m3u8');
      assert.match(diag[0].detail, /reachable=1/, `got "${diag[0].detail}"`);
    },
  );
});

await check('a player-locked /api/stream/ url is ranked last, not dropped silently', async () => {
  await withSite(
    {
      sources: [
        { type: 'hls', url: 'https://cdn.provider.example/master.m3u8' },
        { type: 'hls', url: '/api/stream/locked?token=abc' },
      ],
    },
    async () => {
      const diag = [];
      const result = await createSource12Adapter(() => true).resolve({
        type: 'movie',
        tmdbId: '550',
        diag,
        signal: AbortSignal.timeout(8000),
      });
      // The locked one cannot verify (the site answers it with HTML), so what
      // comes back is the usable provider url only — but discovery still saw 2.
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].url, 'https://cdn.provider.example/master.m3u8');
      assert.match(diag[0].detail, /candidates=2/, 'both rows must be counted as discovered');
    },
  );
});

await check('directUrl/rawUrl/proxyUrl are preferred over the plain url field', async () => {
  await withSite(
    {
      sources: [
        { type: 'hls', url: '/api/stream/locked?token=abc', directUrl: 'https://cdn.provider.example/a.m3u8' },
        { type: 'mp4', url: '/api/stream/locked2?token=abc', rawUrl: 'https://cdn.provider.example/b.mp4' },
        { type: 'hls', url: '/api/stream/locked3?token=abc', proxyUrl: 'https://cdn.provider.example/c.m3u8' },
      ],
    },
    async () => {
      const diag = [];
      const result = await createSource12Adapter(() => true).resolve({
        type: 'movie',
        tmdbId: '550',
        diag,
        signal: AbortSignal.timeout(8000),
      });
      const urls = result.candidates.map((c) => c.url).sort();
      assert.deepEqual(urls, [
        'https://cdn.provider.example/a.m3u8',
        'https://cdn.provider.example/b.mp4',
        'https://cdn.provider.example/c.m3u8',
      ]);
    },
  );
});

await check('unsafe or malformed urls are still refused', async () => {
  await withSite(
    {
      sources: [
        { type: 'hls', url: 'http://127.0.0.1/private.m3u8' },
        { type: 'hls', url: 'javascript:alert(1)' },
        { type: 'hls', url: 'https://cdn.provider.example/ok.m3u8' },
      ],
    },
    async () => {
      const result = await createSource12Adapter(() => true).resolve({
        type: 'movie',
        tmdbId: '550',
        signal: AbortSignal.timeout(8000),
      });
      for (const candidate of result.candidates) {
        assert.ok(!candidate.url.includes('127.0.0.1'), 'loopback must never become a candidate');
        assert.ok(candidate.url.startsWith('https://'), 'only https');
      }
    },
  );
});

await check('a payload with only player-locked urls yields nothing usable', async () => {
  await withSite(
    { sources: [{ type: 'hls', url: '/api/stream/locked?token=abc' }] },
    async () => {
      const diag = [];
      const result = await createSource12Adapter(() => true).resolve({
        type: 'movie',
        tmdbId: '550',
        diag,
        signal: AbortSignal.timeout(8000),
      });
      // This is the honest answer: the provider returned a row we cannot use. The
      // panel shows candidates=1, reachable=0 rather than pretending otherwise.
      assert.equal(result.candidates.length, 0);
      // The adapter retries a failed resolve once (RETRY_ON_EMPTY) before giving
      // up, so both attempts are counted in the discovered total.
      assert.match(diag[0].detail, /candidates=(1|2),reachable=0/, `got "${diag[0].detail}"`);
    },
  );
});

await check('provider-owned headers are passed through, nothing else', async () => {
  await withSite(
    {
      sources: [
        {
          type: 'hls',
          directUrl: 'https://cdn.provider.example/master.m3u8',
          headers: { Referer: 'https://provider.example/', Authorization: 'secret', 'X-Evil': 'x' },
        },
      ],
    },
    async () => {
      const result = await createSource12Adapter(() => true).resolve({
        type: 'movie',
        tmdbId: '550',
        signal: AbortSignal.timeout(8000),
      });
      const headers = result.candidates[0]?.headers ?? {};
      assert.equal(headers.Referer, 'https://provider.example/');
      assert.ok(!('Authorization' in headers), 'an Authorization header must never be forwarded');
      assert.ok(!('X-Evil' in headers), 'unknown headers must not be forwarded');
    },
  );
});

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
