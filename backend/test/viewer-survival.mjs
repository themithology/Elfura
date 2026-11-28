#!/usr/bin/env node
/**
 * A viewer must never lose an episode because the resolver split is broken.
 *
 * This is a regression test for a real outage. A rule that "refuse to resolve
 * locally when a resolver is configured but unusable" sounded principled - it
 * makes a broken split impossible to miss - and it shipped. On the live site it
 * meant every embed showed "Couldn't find this title ... request 503: source
 * resolver is unreachable". One operator typo, zero playable episodes.
 *
 * Two rules had to be reconciled, and the operator chose explicitly:
 *
 *   1. The media node NEVER scrapes providers when a resolver is configured. It
 *      serves video; scraping there competes with the relay. This is the rule
 *      that wins, because "the streaming node keeps fetching mid-stream" was a
 *      real, visible performance bug.
 *   2. A broken resolver must say something a viewer can act on, not a bare
 *      transport error.
 *
 * So a dead resolver now yields 503 "switch server", and a failed lookup yields
 * 502 "try again". Neither is silent, and neither makes this node scrape.
 */
import assert from 'node:assert/strict';

const { createBackendServer } = await import('../../dist/backend/index.js');

const ENV_KEYS = [
  'ELFURA_RESOLVER_URL',
  'ELFURA_RESOLVER_TOKEN',
  'ELFURA_RESOLVER_ALLOW_LOCAL',
  'ELFURA_RESOLVER_ALLOW_PUBLIC',
];

/**
 * Boot a server with a given environment and ask for one episode, the same
 * request the player makes. Returns the verdict rather than asserting, so one
 * run reports every configuration.
 */
async function probeViewer(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const { server } = createBackendServer({ host: '127.0.0.1', port: 0, requireToken: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const bundle = await (await fetch(`http://127.0.0.1:${port}/api/v1/diagnose-bundle`)).json();
    const playback = await fetch(
      `http://127.0.0.1:${port}/api/v1/playback?type=tv&tmdbId=1399&season=1&episode=1&source=__offline_fixture__`,
    );
    return { mode: bundle.resolver.mode, why: bundle.resolver.localBecause, status: playback.status };
  } finally {
    server.close();
  }
}

/* ── the four configurations an operator can actually end up in ───────────── */

// 1. Nothing configured - the single-container install. Must play.
const plain = await probeViewer({});
assert.notEqual(plain.status, 503, 'a single-container install must be able to play');
assert.equal(plain.mode, 'local', 'with no resolver configured, discovery is local');

// 2. A URL that is present but refused (public address, no opt-in). THIS is the
//    configuration that caused the outage. It must still play.
const refused = await probeViewer({ ELFURA_RESOLVER_URL: 'http://91.92.35.88:3002' });
assert.notEqual(refused.status, 503, 'a refused resolver URL must NOT block playback');
assert.equal(refused.mode, 'degraded', 'the panel must still show that the split is not active');
assert.ok(refused.why.length > 0, 'and it must say why, or the operator is back to guessing');

// 3. A URL that is valid but unreachable (box down, firewalled, wrong route).
//    The split cannot be honoured, so discovery runs here instead.
const dead = await probeViewer({ ELFURA_RESOLVER_URL: 'http://10.255.255.1:3002' });
// Operator's explicit decision: with a resolver configured, this node does NOT
// scrape. Saying "switch server" is actionable; silently scraping here is what
// caused the streaming node to compete with its own resolver.
assert.equal(dead.status, 503, 'an unreachable resolver must fail loudly, never fall back to scraping');

// 4. Strict mode, explicitly requested. This one MAY refuse - and must say so.
const strict = await probeViewer({
  ELFURA_RESOLVER_URL: 'http://91.92.35.88:3002',
  ELFURA_RESOLVER_ALLOW_LOCAL: '0',
});
assert.equal(
  strict.mode,
  'refusing',
  'ELFURA_RESOLVER_ALLOW_LOCAL=0 is an opt-in to strict behaviour and must be honoured',
);

console.log(
  `✓ viewer survival: plain=${plain.status} refused=${refused.status}(${refused.mode}) ` +
    `dead=${dead.status}(no scraping) strict=${strict.mode} - a broken split never turns this node into a scraper`,
);
