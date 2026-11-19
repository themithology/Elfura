#!/usr/bin/env node
/**
 * The three timeouts must be a ladder, and the client must make one call.
 *
 * Regression test for a live outage. The numbers were:
 *
 *   resolver scan budget   5 000 ms
 *   media node patience   30 000 ms   <- 6x the work it was waiting for
 *   player patience       15 000 ms   <- the viewer's actual limit
 *
 * The media node sat waiting for an answer the player had already stopped
 * listening for, and the log filled with "This operation was aborted" for every
 * title. The player showed "TimeoutError: signal timed out".
 *
 * The rule:
 *
 *   resolver scan  <  media node patience  <  player patience
 *
 * and ONE call per request: no retry (it doubles a wait that is already too
 * late), no health check (a second round-trip on the box serving video).
 */
import assert from 'node:assert/strict';

const { ResolverUnavailableError } = await import('../../dist/backend/playback-resolver-remote.js');
const { createResilientPlaybackResolver } = await import('../../dist/backend/playback-resolver.js');

const PLAYER_PATIENCE_MS = 15_000; // src/core/player.ts: AbortSignal.timeout(15000)
const DEFAULT_CLIENT_PATIENCE_MS = 10_000; // playback-resolver-remote.ts default
const RESCUE_MS = 700; // RESCUE_EXTENSION_MS: one-off extension on an empty scan
const DEFAULT_SCAN_MS = 5_000;

/* ── the ladder ──────────────────────────────────────────────────────────── */

assert.ok(
  DEFAULT_CLIENT_PATIENCE_MS > DEFAULT_SCAN_MS + RESCUE_MS,
  `the media node must outwait the resolver's scan (${DEFAULT_CLIENT_PATIENCE_MS} vs ${DEFAULT_SCAN_MS + RESCUE_MS})`,
);
assert.ok(
  DEFAULT_CLIENT_PATIENCE_MS < PLAYER_PATIENCE_MS,
  `the media node must give up BEFORE the player does (${DEFAULT_CLIENT_PATIENCE_MS} vs ${PLAYER_PATIENCE_MS})`,
);

/* ── one call, no retry, no health check ─────────────────────────────────── */

let resolveCalls = 0;
let probeCalls = 0;
const failing = {
  kind: 'remote',
  label: 'unreachable',
  resolve: async () => {
    resolveCalls += 1;
    throw new ResolverUnavailableError('This operation was aborted');
  },
  probe: async () => {
    probeCalls += 1;
    return { reachable: false, detail: 'silent' };
  },
  sourceStatus: async () => null,
  setSourceEnabled: async () => false,
};

const resolver = createResilientPlaybackResolver({ remote: failing, onFallback: () => {} });
const started = Date.now();
let thrown = null;
try {
  await resolver.resolve({ type: 'tv', tmdbId: 1, season: 1, episode: 1 });
} catch (error) {
  thrown = error;
}
const elapsed = Date.now() - started;

assert.ok(thrown, 'a failing resolver must raise, not hang');
assert.equal(
  resolveCalls,
  1,
  `exactly ONE resolver call per request (got ${resolveCalls}) - the operator asked for blind trust: one attempt, any failure means offline`,
);
assert.equal(
  probeCalls,
  0,
  `no health check inside the resolve path (got ${probeCalls}) - that is a second round-trip on the node serving video`,
);
assert.equal(thrown.name, 'ResolverBackendDownError', `any failure means "backend offline" (got ${thrown.name})`);
assert.ok(elapsed < 1000, 'and it fails fast, never after another full patience window');

/* ── one success, then one failure: the recovery notice is accurate ──────── */

let mode = 'ok';
let recovered = 0;
const flaky = {
  ...failing,
  resolve: async () => {
    if (mode === 'fail') throw new ResolverUnavailableError('gone');
    return { ok: true };
  },
};
const r2 = createResilientPlaybackResolver({ remote: flaky, onRecovered: () => (recovered += 1) });
await r2.resolve({ type: 'tv', tmdbId: 1, season: 1, episode: 1 });
mode = 'fail';
await r2.resolve({ type: 'tv', tmdbId: 1, season: 1, episode: 1 }).catch(() => {});
mode = 'ok';
await r2.resolve({ type: 'tv', tmdbId: 1, season: 1, episode: 1 });
assert.equal(recovered, 1, 'the "answering again" notice must fire once, on the transition');

console.log(
  `✓ timeout ladder: scan ${DEFAULT_SCAN_MS + RESCUE_MS}ms < client ${DEFAULT_CLIENT_PATIENCE_MS}ms < ` +
    `player ${PLAYER_PATIENCE_MS}ms, one call only, any failure = backend offline`,
);
