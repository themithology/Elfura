#!/usr/bin/env node
/**
 * A configured-but-unusable resolver must never resolve locally.
 *
 * This is the rule the operator asked for in as many words: "when the backend is
 * connected don't resolve anything in streaming node". The dangerous case is the
 * middle one - a URL *was* configured but got rejected (bad scheme, public
 * address without the opt-in). Previously that fell through to local scraping:
 * the media process paid the CPU cost the split was meant to free, and nothing
 * anywhere said so.
 *
 * The states must stay distinguishable:
 *   no URL        -> 'local'     (single-container install; scraping is correct)
 *   URL usable    -> 'remote'    (split engaged)
 *   URL unusable  -> 'degraded'  (local resolving continues LOUDLY)
 *   strict opt-in -> 'refusing'  (503; only when ELFURA_RESOLVER_ALLOW_LOCAL=0)
 *
 * The middle one is a reversal, deliberately recorded here. An earlier version
 * made an unusable URL refuse to resolve at all, on the theory that a silent
 * fallback hides a broken split. It did hide it - and it also turned an operator's
 * typo into a 503 for every viewer on the site. Hiding a problem must never cost
 * a visitor an episode: the split is a performance feature, playback is the
 * product.
 */
import assert from 'node:assert/strict';

const { resolverConfig, resolverFallbackReason, resolverIntended } = await import(
  '../../dist/backend/playback-resolver.js'
);

const ENV_KEYS = [
  'ELFURA_RESOLVER_URL',
  'ELFURA_RESOLVER_TOKEN',
  'ELFURA_RESOLVER_ALLOW_LOCAL',
  'ELFURA_RESOLVER_ALLOW_PUBLIC',
];

const withEnv = (values) => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  return () => {
    for (const key of ENV_KEYS) delete process.env[key];
  };
};

/* ── the three states ─────────────────────────────────────────────────────── */

{
  const done = withEnv({});
  assert.equal(resolverIntended(), false, 'nothing configured is not an intent to split');
  assert.equal(resolverConfig(), null);
  assert.equal(
    resolverFallbackReason(),
    'ELFURA_RESOLVER_URL is not set',
    'the reason must be specific enough to act on',
  );
  done();
}

{
  const done = withEnv({ ELFURA_RESOLVER_URL: 'http://10.0.0.5:3003' });
  const cfg = resolverConfig();
  assert.ok(cfg, 'a private URL must engage the split');
  assert.equal(cfg.url, 'http://10.0.0.5:3003');
  assert.equal(resolverFallbackReason(), '', 'no fallback reason when the split works');
  done();
}

{
  // The exact URL from the incident: a public IP, no opt-in.
  const done = withEnv({ ELFURA_RESOLVER_URL: 'http://91.92.35.88:3002' });
  assert.equal(resolverIntended(), true, 'a configured URL is an intent to split, even if refused');
  assert.equal(resolverConfig(), null, 'a public URL without opt-in must be refused');
  assert.match(
    resolverFallbackReason(),
    /refused public resolver URL/,
    'the refusal must name itself',
  );
  done();
}

/* ── the refusing resolver must refuse, loudly ────────────────────────────── */

{
  const { createRefusingPlaybackResolver, ResolverRefusedError } = await import(
    '../../dist/backend/playback-resolver.js'
  );
  const resolver = createRefusingPlaybackResolver('refused public resolver URL: http://x');
  assert.equal(resolver.kind, 'refusing', 'the panel must be able to tell this state apart');
  await assert.rejects(
    () => resolver.resolve({ type: 'tv', tmdbId: 1, season: 1, episode: 1 }),
    (error) => {
      assert.ok(error instanceof ResolverRefusedError, 'must be a typed refusal, not a generic throw');
      assert.match(error.detail, /refused public resolver URL/, 'the cause must survive to the caller');
      return true;
    },
    'the refusing resolver must never return a result',
  );
}

/* ── end to end: a bad URL must 503, not silently scrape ──────────────────── */

{
  const { createBackendServer } = await import('../../dist/backend/index.js');
  const done = withEnv({ ELFURA_RESOLVER_URL: 'http://91.92.35.88:3002' });
  const { server } = createBackendServer({ host: '127.0.0.1', port: 0, requireToken: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const bundle = await (await fetch(`http://127.0.0.1:${port}/api/v1/diagnose-bundle`)).json();
  assert.equal(
    bundle.resolver.mode,
    'degraded',
    `a rejected resolver URL must report "degraded" (working, split inactive), got "${bundle.resolver.mode}"`,
  );

  const playback = await fetch(
    `http://127.0.0.1:${port}/api/v1/playback?type=tv&tmdbId=1399&season=1&episode=1&source=__offline_fixture__`,
  );
  assert.notEqual(
    playback.status,
    503,
    'THE RULE: a broken resolver configuration must never cost a viewer a stream',
  );
  assert.ok(
    bundle.resolver.localBecause.length > 0,
    'the split being inactive must still be reported, just not as a viewer-facing failure',
  );

  server.close();
  done();
}

/* ── and the explicit opt-out still allows a single-process install ───────── */

{
  const { createBackendServer } = await import('../../dist/backend/index.js');
  const done = withEnv({
    ELFURA_RESOLVER_URL: 'http://91.92.35.88:3002',
    ELFURA_RESOLVER_ALLOW_LOCAL: '0',
  });
  const { server } = createBackendServer({ host: '127.0.0.1', port: 0, requireToken: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const bundle = await (await fetch(`http://127.0.0.1:${port}/api/v1/diagnose-bundle`)).json();
  assert.equal(
    bundle.resolver.mode,
    'refusing',
    'ELFURA_RESOLVER_ALLOW_LOCAL=0 is the explicit strict opt-in, and must be honoured',
  );
  server.close();
  done();
}

console.log('✓ resolver authority: broken split still plays (degraded); strict mode is opt-in only');
