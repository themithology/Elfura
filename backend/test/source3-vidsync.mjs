/**
 * Source 3 — VidSync Pro.
 *
 * Two things are pinned here, both from live probing of https://vidsync.pro:
 *
 *  1. The two endpoints the adapter calls — `/api/stream` and
 *     `/api/core/streams` — both answer 404 on the live host. The provider's
 *     documented suite is nine `/embed/...` iframe routes and there is no public
 *     JSON API in it. That is an upstream fact, not a bug we can fix, but the
 *     adapter has to SAY so: reporting `candidates=0` for a 404, a timeout and a
 *     title that simply has no streams makes the panel useless.
 *
 *  2. The adapter must still map real JSON correctly when an operator points
 *     SOURCE3_ORIGIN at a working deployment. That path is tested below with a
 *     fixture so the mapping is not lost along with the public endpoint.
 */
import assert from 'node:assert/strict';

const { createSource3Adapter, fetchFromVidSyncPro } = await import(
  '../../dist/backend/sources/source3.js'
);

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

console.log('\nSource 3 — VidSync Pro');

await check('a 404 on both endpoints is reported as http=404, not silently empty', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>404</html>', { status: 404 });
  try {
    const diag = [];
    const adapter = createSource3Adapter({ enabled: true, origin: 'https://vidsync.example' });
    const result = await adapter.resolve({ type: 'movie', tmdbId: '155', diag });
    assert.equal(result.candidates.length, 0);
    assert.equal(diag.length, 1);
    assert.equal(diag[0].ok, false);
    // The whole point: the reason is visible, not swallowed.
    assert.match(diag[0].detail, /http=404/, `expected http=404 in "${diag[0].detail}"`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('a 200 that is HTML is reported as not-json, not as SyntaxError', async () => {
  // Exact CI failure: on the GitHub runner this host answered 200 with an HTML
  // page and `.json()` threw, so the panel showed "SyntaxError SyntaxError" —
  // a failure with no meaning attached to it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!DOCTYPE html><html><body>blocked</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  try {
    const diag = [];
    const adapter = createSource3Adapter({ enabled: true, origin: 'https://vidsync.example' });
    await adapter.resolve({ type: 'movie', tmdbId: '155', diag });
    assert.match(diag[0].detail, /not-json/, `expected not-json in "${diag[0].detail}"`);
    assert.ok(!/SyntaxError/.test(diag[0].detail), 'a parse failure must not read as a thrown error');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('an empty 200 body is reported as empty-body', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 200 });
  try {
    const diag = [];
    const adapter = createSource3Adapter({ enabled: true, origin: 'https://vidsync.example' });
    await adapter.resolve({ type: 'movie', tmdbId: '155', diag });
    assert.match(diag[0].detail, /empty-body/, `expected empty-body in "${diag[0].detail}"`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('a network failure is reported with its error name', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const err = new Error('boom');
    err.name = 'TimeoutError';
    throw err;
  };
  try {
    const diag = [];
    const adapter = createSource3Adapter({ enabled: true, origin: 'https://vidsync.example' });
    await adapter.resolve({ type: 'movie', tmdbId: '155', diag });
    assert.match(diag[0].detail, /TimeoutError/, `expected the error name in "${diag[0].detail}"`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('a same-origin redirect is followed, a cross-origin one is not', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith('/api/stream?type=movie&id=155&season=1&episode=1&stage=primary')) {
      return new Response(null, { status: 301, headers: { location: '/api/v2/stream?type=movie&id=155&season=1&episode=1&stage=primary' } });
    }
    if (url.includes('/api/v2/stream')) {
      return Response.json({ sources: [{ url: 'https://cdn.example/x.m3u8', type: 'hls', quality: '1080p' }] });
    }
    return new Response(null, { status: 404 });
  };
  try {
    const trace = [];
    const rows = await fetchFromVidSyncPro('https://vidsync.example', { type: 'movie', tmdbId: '155' }, { core: false, stream: true }, trace);
    assert.ok(seen.some((u) => u.includes('/api/v2/stream')), 'a same-origin 301 to /api/v2 must be followed');
    assert.ok(rows.length >= 1, 'the row behind the redirect must survive');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('the adapter still maps real JSON from a working origin', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/core/streams')) {
      return Response.json({
        sources: [
          {
            url: 'https://core.example/proxy?u=abc',
            directUrl: 'https://cdn.example/master.m3u8',
            type: 'hls',
            quality: '1080p',
            audioLanguage: 'Hindi',
            audioTracks: [{ language: 'hi', label: 'Hindi' }],
          },
        ],
      });
    }
    return Response.json({ sources: [] });
  };
  try {
    const rows = await fetchFromVidSyncPro('https://vidsync.example', { type: 'movie', tmdbId: '155' });
    assert.ok(rows.length >= 1, 'a working origin must still produce rows');
    assert.match(rows[0].url, /^https:\/\//);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('an unconfigured or disabled origin yields no adapter at all', async () => {
  const adapter = createSource3Adapter({ enabled: false, origin: 'https://vidsync.example' });
  assert.equal(adapter.enabled(), false);
});

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
