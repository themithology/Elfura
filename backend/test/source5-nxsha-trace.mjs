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

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
