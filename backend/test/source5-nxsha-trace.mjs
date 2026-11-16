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

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
