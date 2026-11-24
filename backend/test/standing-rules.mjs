#!/usr/bin/env node
/**
 * The standing rules, checked against the code.
 *
 * Every one of these was a decision the operator made explicitly, several of
 * them after being burned. A later change that quietly reverses one is exactly
 * how this project has lost days: a "fix" that contradicts a rule nobody wrote
 * down. The rules live here so a contradiction fails a test instead of a viewer.
 *
 * Add a rule when a decision is made. Do not delete one because it is
 * inconvenient - change the code, or ask the operator to change the rule.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const rules = [];
const rule = (name, check) => {
  try {
    check();
    rules.push({ name, ok: true });
  } catch (error) {
    rules.push({ name, ok: false, why: error.message });
  }
};

/* ── deployment ───────────────────────────────────────────────────────────── */

rule('TMDB_API_BASE stays on /4 (this install has always used it)', () => {
  for (const file of ['deploy/STREAMING.env', 'deploy/RESOLVER.env']) {
    assert.match(read(file), /^TMDB_API_BASE=https:\/\/api\.themoviedb\.org\/4$/m, file);
  }
});

rule('both nodes bind 0.0.0.0', () => {
  for (const file of ['deploy/STREAMING.env', 'deploy/RESOLVER.env']) {
    assert.match(read(file), /^HOST=0\.0\.0\.0$/m, file);
  }
});

rule('viewer rate limiting stays off by default', () => {
  for (const file of ['deploy/STREAMING.env', 'deploy/RESOLVER.env']) {
    assert.match(read(file), /^RATE_LIMIT_PER_MIN=0$/m, file);
  }
});

rule('env files carry no comment lines', () => {
  for (const file of ['deploy/STREAMING.env', 'deploy/RESOLVER.env']) {
    assert.doesNotMatch(read(file), /^#/m, file);
  }
});

rule('node ports: streaming 3001, resolver 3002', () => {
  assert.match(read('deploy/STREAMING.env'), /^SERVER_PORT=3001$/m);
  assert.match(read('deploy/RESOLVER.env'), /^ELFURA_RESOLVER_PORT=3002$/m);
});

/* ── memory ───────────────────────────────────────────────────────────────── */

rule('no heap ceiling unless explicitly asked for', () => {
  const index = read('index.js');
  assert.match(index, /ELFURA_MAX_OLD_SPACE_MB/, 'the opt-in must still exist');
  assert.doesNotMatch(
    index,
    /flags\.push\(`--max-old-space-size=\d+/,
    'a hardcoded ceiling must never come back',
  );
});

/* ── the split ────────────────────────────────────────────────────────────── */

rule('.env is published to process.env before anything reads it', () => {
  assert.match(read('index.js'), /loadDotEnvIntoProcess/, 'the launcher reads .env first');
  const index = read('backend/src/index.ts');
  assert.match(index, /hydrateProcessEnvFromDotEnv/, 'the backend publishes it');
  assert.ok(
    index.indexOf('hydrateProcessEnvFromDotEnv()') < index.indexOf('resolverConfig()'),
    'and does so BEFORE the resolver is chosen',
  );
});

rule('the streaming node never scrapes when a resolver is configured', () => {
  const index = read('backend/src/index.ts');
  const remoteBranch = index.slice(index.indexOf('if (remote) {'), index.indexOf('} else if (splitIntended'));
  assert.doesNotMatch(
    remoteBranch,
    /createLocalPlaybackResolver/,
    'no local resolver may exist in the remote branch - that is how it started scraping mid-stream',
  );
  const proxy = read('backend/src/playback-resolver.ts');
  assert.doesNotMatch(proxy, /options\.local\.resolve/, 'the proxy must never delegate to local');
});

rule('one resolver call, no retry, no health check', () => {
  const proxy = read('backend/src/playback-resolver.ts');
  // Anchor on the resilient factory: several resolvers define resolve(), and
  // searching for the first one lands in the wrong class.
  const factoryAt = proxy.indexOf('export function createResilientPlaybackResolver');
  assert.ok(factoryAt > 0, 'the resilient resolver must exist');
  const body = proxy.slice(proxy.indexOf('async resolve(request: PlaybackRequest)', factoryAt));
  const end = body.search(/\n\s+probe:\s/);
  const resolveBody = end === -1 ? body : body.slice(0, end);
  assert.equal(
    (resolveBody.match(/options\.remote\.resolve\(/g) ?? []).length,
    1,
    'exactly one call to the resolver per request',
  );
  assert.doesNotMatch(resolveBody, /options\.remote\.probe\(/, 'no health check inside resolve');
});

rule('the player aborts before the media node does', () => {
  const player = read('src/core/player.ts');
  assert.match(player, /AbortSignal\.timeout\(15000\)/, 'the player limit these numbers are tuned against');
  const remote = read('backend/src/playback-resolver-remote.ts');
  const m = remote.match(/ELFURA_RESOLVER_TIMEOUT_MS \|\| ([\d_]+)/);
  assert.ok(m, 'the client timeout must be readable');
  const client = Number(m[1].replace(/_/g, ''));
  assert.ok(client < 15_000, `client patience ${client}ms must be under the player's 15000ms`);
});

/* ── other standing decisions ─────────────────────────────────────────────── */

rule('the TMDB→AniList converter stays stateless', () => {
  // Archived with the source board; the rule outlives the module so it is still
  // enforced the moment a lane that needs the converter is approved again.
  let anime;
  try {
    anime = read('backend/attic/sources/anime-db.ts');
  } catch {
    return 'converter is archived with the sources — nothing to enforce';
  }
  assert.doesNotMatch(anime, /setInterval|TTL_MS|evict/i, 'no cache, no TTL, no eviction');
});

rule('the embed takes no client-facing AniList parameter', () => {
  assert.doesNotMatch(read('src/embed.ts'), /anilist/i, 'plain /embed/tv/<tmdbId> only');
});

rule('playback tokens stay stateless HMAC', () => {
  assert.match(read('backend/src/security.ts'), /createHmac/, 'no session store, safe across processes');
});

/* ── the source board has exactly one door ────────────────────────────────── */

rule('the board is the manifest and nothing else', () => {
  const registry = read('backend/src/sources/registry.ts');
  assert.match(
    registry,
    /this\.adapters = APPROVED_SOURCES\.map/,
    'the registry must build its list from APPROVED_SOURCES',
  );
  assert.doesNotMatch(
    registry,
    /from '\.\/source\d+\.js'/,
    'a concrete adapter import would bypass the contract gate',
  );
  assert.doesNotMatch(
    registry,
    /SOURCE_ENV_FLAGS/,
    'a second source table drifts out of sync with the manifest',
  );
  const config = read('backend/src/config.ts');
  assert.doesNotMatch(
    config,
    /\bsource\d+\s*[:?]/,
    'per-source config blocks are a second registry; a source reads its own env',
  );
});

rule('a source is only approved with probe titles', () => {
  const manifest = read('backend/src/sources/index.ts');
  const entries = manifest.split('APPROVED_SOURCES: SourceDefinition[] = [')[1] ?? '';
  // Every entry must name titles for the contract test; an entry with none
  // would pass vacuously and admit a lane nobody ever exercised.
  const creates = (entries.match(/create:\s*\(\)/g) ?? []).length;
  const probes = (entries.match(/probes:\s*\[/g) ?? []).length;
  assert.equal(creates, probes, `every approved source needs a probes list (${creates} sources, ${probes} probe lists)`);
});

rule('archived sources cannot be compiled or imported', () => {
  const tsconfig = read('backend/tsconfig.json');
  assert.match(tsconfig, /"include": \["src\/\*\*\/\*\.ts"\]/, 'only src/ is built');
  for (const file of ['backend/src/sources/registry.ts', 'backend/src/index.ts', 'backend/src/config.ts']) {
    assert.doesNotMatch(read(file), /attic\//, `${file} must not reach into the archive`);
  }
});

/* ── report ───────────────────────────────────────────────────────────────── */

const failed = rules.filter((r) => !r.ok);
for (const r of rules) console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.why ? `\n        ${r.why}` : ''}`);
console.log(`\n${rules.length - failed.length}/${rules.length} standing rules hold`);
if (failed.length) process.exit(1);
