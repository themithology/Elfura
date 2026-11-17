#!/usr/bin/env node
/**
 * Does the browser lane actually produce a playable candidate?
 *
 * This is the only test that matters for source-23: run the real adapter with
 * the real browser packages and see whether it lifts a manifest out of a page
 * that refuses a plain fetch. Everything else (gating, config, types) is
 * already covered by the build.
 *
 * Runs on a GitHub runner via diagnose-compare.yml:
 *   npm install --no-save --no-package-lock playwright-core @sparticuz/chromium
 *   node scripts/probe-browser-lane.mjs
 */
import { createBrowserLaneAdapter } from '../dist/backend/sources/source23.js';

const log = (t, v) => console.log(`[lane] ${t} :: ${v}`);

const adapter = createBrowserLaneAdapter({
  enabled: true,
  embedOrigin: 'https://tgfrost.lovable.app',
  settleMs: 16_000,
  pageTimeoutMs: 35_000,
  rank: 60,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  referer: 'https://tgfrost.lovable.app/',
});

log('adapter', `${adapter.id} (${adapter.label}) enabled=${adapter.enabled()}`);

const cases = (
  process.env.TG_TITLES ||
  'tv:94664/1/1,tv:291496/1/1,tv:94605/1/1,tv:1399/1/1,tv:207347/1/1,movie:550'
)
  .split(',')
  .map((t) => {
    const [type, rest] = t.trim().split(':');
    return { type, rest };
  });

for (const { type, rest } of cases) {
  const query =
    type === 'tv'
      ? { type: 'tv', tmdbId: rest.split('/')[0], season: Number(rest.split('/')[1] || 1), episode: Number(rest.split('/')[2] || 1), diag: [] }
      : { type: 'movie', tmdbId: rest, diag: [] };

  const started = Date.now();
  const out = await adapter.resolve(query);
  const ms = Date.now() - started;
  const hosts = [...new Set(out.candidates.map((c) => { try { return new URL(c.url).hostname; } catch { return '?'; } }))];
  const types = [...new Set(out.candidates.map((c) => c.type))];
  log(
    `${type}/${rest}`,
    `candidates=${out.candidates.length} types=${types.join(',') || '-'} hosts=${hosts.join(',') || '-'} ${ms}ms`,
  );
  for (const entry of query.diag) log(`  diag ${type}/${rest}`, `${entry.lane} ok=${entry.ok} ${entry.detail} (${entry.ms}ms)`);
}

console.log('[lane:done]');
