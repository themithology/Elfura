/**
 * Source 5 — Nxsha failure reporting.
 *
 * `fetchFromNxsha` used to end in a bare `catch { return []; }`. Everything that
 * could go wrong — a reset connection, a 403, an HTML challenge page, a changed
 * envelope, an empty server list — produced the same empty array, and the panel
 * showed `candidates=0` with nothing after it. On CI that is exactly what
 * appeared, so there was no way to tell a broken adapter from a throttled host.
 *
 * Each case below is a genuinely different fault with a different response, so
 * each gets its own assertion. The thing being tested is not "does it return
 * empty" (it always should) but "does it say which empty".
 */
import assert from 'node:assert/strict';

const { fetchFromNxsha } = await import('../../dist/backend/sources/source5.js');

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

const query = { type: 'movie', tmdbId: '550' };

/** Run a resolve against a mocked transport and return the collected trace. */
async function traceWith(handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  const trace = [];
  try {
    const rows = await fetchFromNxsha(query, undefined, { trace });
    return { rows, trace: trace.join(' ') };
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\nSource 5 — failure reporting');

await check('a reset connection reports the underlying error code', async () => {
  const { rows, trace } = await traceWith(async () => {
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNRESET' };
    throw err;
  });
  assert.deepEqual(rows, []);
  assert.match(trace, /ECONNRESET/, `expected the cause code, got "${trace}"`);
});

await check('a 403 reports the status', async () => {
  const { rows, trace } = await traceWith(async () => new Response('denied', { status: 403 }));
  assert.deepEqual(rows, []);
  assert.match(trace, /http=403/, `expected http=403, got "${trace}"`);
});

await check('an HTML challenge page reports the body it got instead', async () => {
  const { rows, trace } = await traceWith(async () =>
    new Response('<!doctype html><html><body>Just a moment...</body></html>', { status: 200 }),
  );
  assert.deepEqual(rows, []);
  assert.match(trace, /not-json/, `expected not-json, got "${trace}"`);
});

await check('a 200 without an envelope reports no-envelope', async () => {
  const { rows, trace } = await traceWith(async () => Response.json({ ok: true }));
  assert.deepEqual(rows, []);
  assert.match(trace, /no-envelope/, `expected no-envelope, got "${trace}"`);
});

await check('an envelope that will not decode reports undecodable', async () => {
  // A well-formed envelope whose payload is not a valid Nxsha ciphertext.
  const { rows, trace } = await traceWith(async () =>
    Response.json({ _hash: `U2FsdGVkX1${'A'.repeat(48)}` }),
  );
  assert.deepEqual(rows, []);
  assert.match(trace, /undecodable/, `expected undecodable, got "${trace}"`);
});

await check('the four faults produce four different words', async () => {
  const make = (h) => async () => h;
  const cases = [
    await traceWith(async () => {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNRESET' };
      throw err;
    }),
    await traceWith(make(new Response('x', { status: 403 }))),
    await traceWith(make(new Response('<html>', { status: 200 }))),
    await traceWith(make(Response.json({ nothing: true }))),
  ];
  const distinct = new Set(cases.map((c) => c.trace));
  assert.equal(distinct.size, 4, `expected four distinct traces, got ${JSON.stringify([...distinct])}`);
});

await check('a valid request still returns rows when the transport works', async () => {
  // Encode a real envelope using the module's own cipher so this exercises the
  // success path rather than asserting on [].  The adapter will then find no
  // matching lanes, which is itself a distinct, reportable outcome.
  const { nxEncode } = await import('../../dist/backend/sources/source5.js');
  const { rows, trace } = await traceWith(async () => Response.json({ _hash: nxEncode({ servers: [] }) }));
  assert.deepEqual(rows, []);
  assert.match(trace, /servers=none/, `expected servers=none for a reachable host with no lanes, got "${trace}"`);
});

await check('servers present but none matching our lanes says so', async () => {
  const { nxEncode } = await import('../../dist/backend/sources/source5.js');
  const { rows, trace } = await traceWith(async () =>
    Response.json({ _hash: nxEncode({ servers: [{ scraper: 'renamed-lane' }] }) }),
  );
  assert.deepEqual(rows, []);
  assert.match(trace, /0-matching-lanes/, `expected 0-matching-lanes, got "${trace}"`);
});

await check('an unsafe id costs no request at all', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('{}');
  };
  try {
    assert.deepEqual(await fetchFromNxsha({ type: 'movie', tmdbId: 'not-a-number' }), []);
    assert.equal(called, false, 'a malformed id must be rejected before any network call');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('a rotation to an older known passphrase still decodes', async () => {
  // The site rotates its public client passphrase; when it does, every stream
  // silently becomes "no results". nxDecode holds the known history and tries
  // each, so an envelope sealed with the previous key must still open.
  const crypto = await import('node:crypto');
  const { nxDecode } = await import('../../dist/backend/sources/source5.js');
  const OLD = 'S8x!Jk4ZP1uG8$my';
  const salt = crypto.randomBytes(8);
  let material = Buffer.alloc(0), prev = Buffer.alloc(0);
  while (material.length < 48) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(OLD), salt])).digest();
    material = Buffer.concat([material, prev]);
  }
  const cipher = crypto.createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  const body = JSON.stringify({ servers: [{ scraper: 'moviebox' }] });
  const env = Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(body), cipher.final()]).toString('base64url');
  assert.equal(nxDecode(env).servers?.[0]?.scraper, 'moviebox', 'the previous passphrase must still open its own envelopes');
});

await check('a key we do not know reports no-key, not a generic failure', async () => {
  // Envelope with the right magic but sealed under an unknown key: the shape a
  // genuine upstream rotation takes. Must be distinguishable from a stub.
  const crypto = await import('node:crypto');
  const salt = crypto.randomBytes(8);
  const cipher = crypto.createCipheriv('aes-256-cbc', crypto.randomBytes(32), crypto.randomBytes(16));
  const env = Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(Buffer.from('{"servers":[]}'.padEnd(64))), cipher.final()]).toString('base64url');
  const { rows, trace } = await traceWith(async () => Response.json({ _hash: env }));
  assert.deepEqual(rows, []);
  assert.match(trace, /no-key/, `expected no-key for an unknown passphrase, got "${trace}"`);
});

await check('an unreadable primary fails over to the mirror', async () => {
  // Two front-ends of one catalogue, each sealing with its own key. If the
  // primary answers in a key we do not hold, the mirror is still readable and
  // the source must not be reported dead.
  const crypto = await import('node:crypto');
  const MIRROR = 'S8x!Jk4ZP1uG8$my';
  const sealed = (obj) => {
    const salt = crypto.randomBytes(8);
    let material = Buffer.alloc(0), prev = Buffer.alloc(0);
    while (material.length < 48) {
      prev = crypto.createHash('md5').update(Buffer.concat([prev, Buffer.from(MIRROR), salt])).digest();
      material = Buffer.concat([material, prev]);
    }
    const cipher = crypto.createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
    const body = JSON.stringify(obj);
    return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(body), cipher.final()]).toString('base64url');
  };
  const realFetch = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (input) => {
    const host = new URL(typeof input === 'string' ? input : input.url).hostname;
    hosts.push(host);
    if (host === 'nxsha.space') {
      // Right shape, sealed with a key we do not have.
      const salt = crypto.randomBytes(8);
      const cipher = crypto.createCipheriv('aes-256-cbc', crypto.randomBytes(32), crypto.randomBytes(16));
      const env = Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(Buffer.from('{"servers":[]}'.padEnd(96))), cipher.final()]).toString('base64url');
      return Response.json({ _hash: env });
    }
    return Response.json({ _hash: sealed({ servers: [] }) });
  };
  const trace = [];
  try {
    await fetchFromNxsha(query, undefined, { trace });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(hosts.includes('web.nxsha.app'), `expected a retry against the mirror, saw ${JSON.stringify([...new Set(hosts)])}`);
  assert.match(trace.join(' '), /failover=web\.nxsha\.app/, `expected a failover note, got "${trace.join(' ')}"`);
});

await check('a refusal on both front-ends is named as an IP-level refusal', async () => {
  // The honest description of source-5 on CI: the hosts answer browsers and
  // refuse datacenter addresses. Reporting that as a plain 403 made a healthy
  // source look broken.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('no', { status: 403 });
  const trace = [];
  try {
    await fetchFromNxsha(query, undefined, { trace });
  } finally {
    globalThis.fetch = realFetch;
  }
  const joined = trace.join(' ');
  assert.match(joined, /failover=web\.nxsha\.app/, `expected the mirror to be tried, got "${joined}"`);
  assert.match(joined, /all-front-ends-refused-this-ip/, `expected the IP-refusal note, got "${joined}"`);
});

await check('a refusal followed by a good mirror is not called an IP refusal', async () => {
  // Only one host refused; the other answered. Must not overclaim.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const host = new URL(typeof url === 'string' ? url : url.url).hostname;
    if (host === 'nxsha.space') return new Response('no', { status: 403 });
    const err = new TypeError('fetch failed');
    err.cause = { code: 'ECONNRESET' };
    throw err;
  };
  const trace = [];
  try {
    await fetchFromNxsha(query, undefined, { trace });
  } finally {
    globalThis.fetch = realFetch;
  }
  const joined = trace.join(' ');
  assert.doesNotMatch(joined, /all-front-ends-refused-this-ip/, `must not overclaim: "${joined}"`);
  assert.match(joined, /ECONNRESET/, `expected the mirror's own reason, got "${joined}"`);
});

await check('a rotation is recovered from the site bundle instead of losing the source', async () => {
  // The realistic bad day: nxsha redeploys with a new passphrase, so our key
  // stops opening replies. Their client has to ship the new key to work at all,
  // so it is recoverable from the JS the browser downloads. The adapter must
  // find it, prove it by opening the failed payload, and carry on.
  const crypto = await import('node:crypto');
  const NEW = 'b'.repeat(64);
  const evp = (pass, salt) => {
    let m = Buffer.alloc(0), p2 = Buffer.alloc(0);
    while (m.length < 48) { p2 = crypto.createHash('md5').update(Buffer.concat([p2, Buffer.from(pass), salt])).digest(); m = Buffer.concat([m, p2]); }
    return { key: m.subarray(0, 32), iv: m.subarray(32, 48) };
  };
  const seal = (obj) => {
    const salt = crypto.randomBytes(8); const { key, iv } = evp(NEW, salt);
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([Buffer.from('Salted__'), salt, c.update(Buffer.from(JSON.stringify(obj))), c.final()]).toString('base64url');
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/servers')) return Response.json({ _hash: seal({ servers: [{ scraper: 'nitro' }] }) });
    if (u.includes('/api/sources')) return Response.json({ _hash: seal({ sources: [{ url: 'https://cdn.example/x.m3u8', language: 'English', quality: '1080p' }] }) });
    if (u.includes('/embed/movie/')) return new Response('<script src="/_next/static/chunks/main-abc.js"></script>', { status: 200 });
    if (u.includes('/_next/static/chunks/')) return new Response(`let t="${NEW}";other="deadbeef"`, { status: 200 });
    return new Response('', { status: 404 });
  };
  const trace = [];
  let rows;
  try { rows = await fetchFromNxsha(query, undefined, { trace }); } finally { globalThis.fetch = realFetch; }
  assert.match(trace.join(' '), /recovered-passphrase/, `expected a recovered key, got "${trace.join(' ')}"`);
  assert.equal(rows.length, 1, 'the stream must survive the rotation');
  assert.equal(rows[0].url, 'https://cdn.example/x.m3u8');
});

await check('a bundle key that does not open the payload is not adopted', async () => {
  // Guessing must never be blindly trusted: only a key that provably decrypts
  // the failed reply may replace the current one.
  const crypto = await import('node:crypto');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/servers')) {
      const salt = crypto.randomBytes(8);
      const c = crypto.createCipheriv('aes-256-cbc', crypto.randomBytes(32), crypto.randomBytes(16));
      const env = Buffer.concat([Buffer.from('Salted__'), salt, c.update(Buffer.from('{"servers":[]}'.padEnd(64))), c.final()]).toString('base64url');
      return Response.json({ _hash: env });
    }
    if (u.includes('/embed/movie/')) return new Response('<script src="/_next/static/chunks/m.js"></script>', { status: 200 });
    if (u.includes('/_next/static/chunks/')) return new Response(`k="${'c'.repeat(64)}"`, { status: 200 });
    return new Response('', { status: 403 });
  };
  const trace = [];
  try { await fetchFromNxsha(query, undefined, { trace }); } finally { globalThis.fetch = realFetch; }
  const joined = trace.join(' ');
  assert.doesNotMatch(joined, /recovered-passphrase/, `a bogus bundle key must not be adopted: "${joined}"`);
  assert.match(joined, /no-key/, `expected the honest no-key report, got "${joined}"`);
});

await check('the two lane sets stay disjoint', async () => {
  // Primary and ScreenScape lanes are issued as two separate passes at the same
  // host. A provider listed in both gets requested twice per resolve and shows
  // up as two lanes, which is exactly what happened when the primary list was
  // widened: 'bdxs' appeared in both and every ScreenScape provider was asked
  // for twice. PRIMARY_LANES now filters itself against SCREENSCAPE_LANES;
  // this asserts the filter stays in place.
  const { SCREENSCAPE_LANES, primaryLanesForTest } = await import('../../dist/backend/sources/source5.js');
  const overlap = primaryLanesForTest().filter((l) => SCREENSCAPE_LANES.includes(l));
  assert.deepEqual(overlap, [], `primary lanes must not repeat a ScreenScape lane: ${JSON.stringify(overlap)}`);
});

await check('a resolve does not outwait lanes that have all already failed', async () => {
  // With the wider lane list this mattered: if the server list call worked but
  // every lane errored, the old code still sat on a flat 2.2s fallback timer.
  // Nothing was left to wait for, so the resolve has to end promptly.
  const crypto = await import('node:crypto');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/servers')) {
      // A real (decodable with our key) server list containing one of our lanes.
      const salt = crypto.randomBytes(8);
      let m = Buffer.alloc(0), p2 = Buffer.alloc(0);
      const KEY = '38c8cd65d781936f4b9fe1fd985234fd7335699855051abf76ea3493bcfc0120';
      while (m.length < 48) { p2 = crypto.createHash('md5').update(Buffer.concat([p2, Buffer.from(KEY), salt])).digest(); m = Buffer.concat([m, p2]); }
      const c = crypto.createCipheriv('aes-256-cbc', m.subarray(0, 32), m.subarray(32, 48));
      const body = JSON.stringify({ servers: [{ scraper: 'nitro' }, { scraper: 'mhbox' }] });
      return Response.json({ _hash: Buffer.concat([Buffer.from('Salted__'), salt, c.update(body), c.final()]).toString('base64url') });
    }
    // Every lane fails immediately.
    return new Response('nope', { status: 500 });
  };
  const started = Date.now();
  try { await fetchFromNxsha(query, undefined, { trace: [] }); } finally { globalThis.fetch = realFetch; }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1200, `a fully failed lane set must not wait on a fallback timer (took ${elapsed}ms)`);
});

await check('diagnose mode reports a hung lane without waiting for it forever', async () => {
  // Diagnose awaits every lane so the panel can describe each one. Without a
  // ceiling, a single provider that never answers stalled the whole report
  // (measured at 20s with one 20s lane). The ceiling must still let ordinary
  // slow lanes finish.
  const crypto = await import('node:crypto');
  const { nxDecode } = await import('../../dist/backend/sources/source5.js');
  const KEY = '38c8cd65d781936f4b9fe1fd985234fd7335699855051abf76ea3493bcfc0120';
  const seal = (o) => {
    const s2 = crypto.randomBytes(8); let m = Buffer.alloc(0), p2 = Buffer.alloc(0);
    while (m.length < 48) { p2 = crypto.createHash('md5').update(Buffer.concat([p2, Buffer.from(KEY), s2])).digest(); m = Buffer.concat([m, p2]); }
    const ci = crypto.createCipheriv('aes-256-cbc', m.subarray(0, 32), m.subarray(32, 48)); const b = JSON.stringify(o);
    return Buffer.concat([Buffer.from('Salted__'), s2, ci.update(b), ci.final()]).toString('base64url');
  };
  const { createSource5Adapter } = await import('../../dist/backend/sources/source5.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/servers')) return Response.json({ _hash: seal({ servers: [{ scraper: 'nitro' }, { scraper: 'mhbox' }] }) });
    const body = nxDecode(new URL(u).searchParams.get('q'));
    if (body.provider === 'mhbox') await new Promise((r) => setTimeout(r, 20000));
    await new Promise((r) => setTimeout(r, 100));
    return Response.json({ _hash: seal({ sources: [{ url: `https://cdn.example/${body.provider}.m3u8`, language: 'English', type: 'hls' }] }) });
  };
  const started = Date.now();
  let out;
  try { out = await createSource5Adapter(() => true, () => false).resolve({ type: 'movie', tmdbId: '550', diag: [] }); }
  finally { globalThis.fetch = realFetch; }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4500, `diagnose must cap a hung lane (took ${elapsed}ms)`);
  assert.ok(out.candidates.length >= 1, 'the responsive lane must still be reported');
});

// ---------------------------------------------------------------------------
// Source 4 — same idea, but the failure being explained is discovery, not
// transport: a 200 watch page whose RSC chunks do not carry the v1 payload.
// ---------------------------------------------------------------------------
const { fetchFromBingr } = await import('../../dist/backend/sources/source4.js');

async function bingrTrace(handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  const trace = [];
  try {
    const rows = await fetchFromBingr({ type: 'movie', tmdbId: '550' }, { trace });
    return { rows, trace: trace.join(' ') };
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('\nSource 4 — discovery reporting');

await check('a watch page without the payload says so, and whether a token was seen', async () => {
  // This is the CI shape: HTTP 200, a real Next.js page, no `v1.` blob in the
  // RSC chunks. Previously indistinguishable from a network outage.
  const { rows, trace } = await bingrTrace(async () =>
    new Response('<html><script>self.__next_f.push([1,"{\"a\":1}"])</script></html>', { status: 200 }),
  );
  assert.deepEqual(rows, []);
  assert.match(trace, /blob=none/, `expected blob=none, got "${trace}"`);
  assert.match(trace, /token=no/, `expected token=no, got "${trace}"`);
});

await check('a refused watch page reports the status', async () => {
  const { rows, trace } = await bingrTrace(async () => new Response('nope', { status: 404 }));
  assert.deepEqual(rows, []);
  assert.match(trace, /http=404/, `expected http=404, got "${trace}"`);
});

await check('an undecodable payload reports the decode error', async () => {
  const { rows, trace } = await bingrTrace(async () =>
    new Response('<script>self.__next_f.push([1,"v1."])</script>', { status: 200 }),
  );
  assert.deepEqual(rows, []);
  assert.match(trace, /blob=none|undecodable/, `expected a decode reason, got "${trace}"`);
});

// ---------------------------------------------------------------------------
// Source 13 — its host answered 500 to every shape when probed, so the panel
// needs to say that rather than "0 candidates".
// ---------------------------------------------------------------------------
const { fetchFromXpass } = await import('../../dist/backend/sources/source13.js');

console.log('\nSource 13 — failure reporting');

await check('a refusing host reports its status', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('error', { status: 500 });
  const trace = [];
  try { assert.deepEqual(await fetchFromXpass({ type: 'movie', tmdbId: '550' }, { trace }), []); }
  finally { globalThis.fetch = realFetch; }
  assert.match(trace.join(' '), /http=500/, `expected http=500, got "${trace.join(' ')}"`);
});

await check('a reachable host with no usable streams says so', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ type: 'movie', streams: [{ format: 'mp4', url: 'https://x.example/a.mp4' }] });
  const trace = [];
  try { assert.deepEqual(await fetchFromXpass({ type: 'movie', tmdbId: '550' }, { trace }), []); }
  finally { globalThis.fetch = realFetch; }
  assert.match(trace.join(' '), /streams=1\/0-usable/, `expected the stream verdict, got "${trace.join(' ')}"`);
});

await check('a payload for the wrong title kind is reported as such', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ type: 'series', streams: [] });
  const trace = [];
  try { assert.deepEqual(await fetchFromXpass({ type: 'movie', tmdbId: '550' }, { trace }), []); }
  finally { globalThis.fetch = realFetch; }
  assert.match(trace.join(' '), /wrong-type=series/, `expected wrong-type, got "${trace.join(' ')}"`);
});

// ---------------------------------------------------------------------------
// Source 15 — multi-stage discovery, where "which gate failed" is the
// only useful piece of information.
// ---------------------------------------------------------------------------
const { fetchFromMapple } = await import('../../dist/backend/sources/source15.js');

console.log('\nSource 15 — multi-stage discovery');

await check('a refusing host reports its status', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 503 });
  const trace = [];
  try { await fetchFromMapple({ type: 'movie', tmdbId: '550' }, { trace }); } finally { globalThis.fetch = realFetch; }
  assert.match(trace.join(' '), /http=503/, `expected http=503, got "${trace.join(' ')}"`);
});

await check('a page without the request token says which token is missing', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>no token here</html>', { status: 200 });
  const trace = [];
  try { await fetchFromMapple({ type: 'movie', tmdbId: '550' }, { trace }); } finally { globalThis.fetch = realFetch; }
  assert.match(trace.join(' '), /no-request-token/, `expected no-request-token, got "${trace.join(' ')}"`);
});

await check('the request token comes from the API, and the chain continues', async () => {
  // The site moved its token out of the page (`window.__REQUEST_TOKEN__`) into
  // POST /api/request-token. Scraping the HTML alone is what made this source
  // report `no-request-token` while the site was perfectly healthy.
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push(`${opts?.method ?? 'GET'} ${u.replace('https://mapple.fun', '')}`);
    if (u.endsWith('/api/request-token')) return Response.json({ token: 'tok-from-api-123' });
    if (u.endsWith('/api/playback-init')) return Response.json({ success: true, token: 'playback-token' });
    if (u.endsWith('/api/encrypt')) return Response.json({ url: '/api/stream-encrypted?x=1' });
    return new Response('<html>page without any inline token</html>', { status: 200 });
  };
  const trace = [];
  try { await fetchFromMapple({ type: 'movie', tmdbId: '550' }, { trace }); }
  finally { globalThis.fetch = realFetch; }
  assert.ok(calls.includes('POST /api/request-token'), `expected the token API to be called, saw ${JSON.stringify(calls)}`);
  assert.ok(calls.includes('POST /api/playback-init'), 'a token from the API must let the handshake continue');
  assert.doesNotMatch(trace.join(' '), /no-request-token/, 'a healthy site must not report a missing token');
});

await check('an inline token is still accepted when the API is gone', async () => {
  // Older deployments may still inline the token; the fallback must keep working.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/request-token')) return new Response('', { status: 404 });
    if (u.endsWith('/api/playback-init')) return Response.json({ success: true, token: 'playback-token' });
    if (u.endsWith('/api/encrypt')) return Response.json({ url: '/api/stream-encrypted?x=1' });
    return new Response(`<script>window.__REQUEST_TOKEN__ = "inline-token-abcdefgh";</script>`, { status: 200 });
  };
  const trace = [];
  try { await fetchFromMapple({ type: 'movie', tmdbId: '550' }, { trace }); }
  finally { globalThis.fetch = realFetch; }
  assert.match(trace.join(' '), /request-token=inline/, `expected the inline fallback to be noted, got "${trace.join(' ')}"`);
  assert.doesNotMatch(trace.join(' '), /no-request-token/, 'the inline token must still be usable');
});

await check('the proof-of-work solver produces a digest that really meets the difficulty', async () => {
  // Verified independently of our own counting: hash the nonce back and count
  // the leading zero bits. A solver that "succeeds" without meeting the target
  // would be rejected by the site and look like a refusal.
  const crypto = await import('node:crypto');
  const { solveMapplePow } = await import('../../dist/backend/sources/source15.js');
  const challenge = 'challenge-abc';
  const leading = (buf) => {
    let n = 0;
    for (const b of buf) { if (b === 0) { n += 8; continue; } for (let bit = 7; bit >= 0; bit--) { if ((b & (1 << bit)) !== 0) return n; n++; } }
    return n;
  };
  const difficulty = 10;
  const nonce = await solveMapplePow(challenge, difficulty, 300000);
  assert.notEqual(nonce, null, 'the solver must find a nonce at a modest difficulty');
  const digest = crypto.createHash('sha256').update(challenge).update(String(nonce)).digest();
  assert.ok(leading(digest) >= difficulty, `nonce ${nonce} only reaches ${leading(digest)} zero bits, needs ${difficulty}`);
});

await check('a proof-of-work the budget cannot cover is reported with its difficulty', async () => {
  // The site chooses the difficulty. When it rises past our budget the honest
  // report is the difficulty, not a bare failure: it says the budget is the
  // problem, not the challenge.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/request-token')) return Response.json({ token: 'tok-from-api-123' });
    if (u.endsWith('/api/playback-init')) {
      // Difficulty 30 is far beyond anything solvable in a request.
      return Response.json({ requiresPow: true, pow: { challenge: 'c', difficulty: 30, challengeId: 'id1' } });
    }
    return new Response('<html></html>', { status: 200 });
  };
  const trace = [];
  try { await fetchFromMapple({ type: 'movie', tmdbId: '550' }, { trace }); }
  finally { globalThis.fetch = realFetch; }
  assert.match(trace.join(' '), /pow-unsolved difficulty=30/, `expected the difficulty in the report, got "${trace.join(' ')}"`);
});

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
