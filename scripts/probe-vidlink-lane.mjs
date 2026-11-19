#!/usr/bin/env node
/**
 * Does source-24 (VidLink) actually produce playable candidates?
 *
 * Everything else is already proven: `/api/b` returns application/json and
 * enc-dec returns a token. What is not proven is the full path end to end —
 * encrypt a real TMDB id, call the real API, and get manifests back that the
 * liveness checks would accept.
 *
 * Runs on a GitHub runner via diagnose-compare.yml.
 * Prints counts, hosts and quality labels only, never a full stream URL.
 */
import { createSource24Adapter } from '../dist/backend/sources/source24.js';

const log = (t, v) => console.log(`[vl] ${t} :: ${v}`);

const adapter = createSource24Adapter({
  enabled: true,
  origin: 'https://vidlink.pro/api/b',
  timeoutMs: 15_000,
  rank: 55,
});

log('adapter', `${adapter.id} (${adapter.label}) enabled=${adapter.enabled()}`);

// Real ids: a movie, a US series, an anime series, and a K-drama.
const CASES = (
  process.env.VL_TITLES || 'movie:550,tv:1399/1/1,tv:94664/1/1,tv:291496/1/1'
)
  .split(',')
  .map((t) => {
    const [type, rest] = t.trim().split(':');
    return { type, rest };
  });

for (const { type, rest } of CASES) {
  const query =
    type === 'tv'
      ? {
          type: 'tv',
          tmdbId: rest.split('/')[0],
          season: Number(rest.split('/')[1] || 1),
          episode: Number(rest.split('/')[2] || 1),
          diag: [],
        }
      : { type: 'movie', tmdbId: rest, diag: [] };

  const started = Date.now();
  const out = await adapter.resolve(query);
  const ms = Date.now() - started;

  const hosts = [
    ...new Set(
      out.candidates.map((c) => {
        try {
          return new URL(c.url).hostname;
        } catch {
          return '?';
        }
      }),
    ),
  ];
  const types = [...new Set(out.candidates.map((c) => c.type))];
  const quals = out.candidates.map((c) => c.quality).slice(0, 8);

  log(
    `${type}/${rest}`,
    `candidates=${out.candidates.length} types=${types.join(',') || '-'} quals=${quals.join(',') || '-'} hosts=${hosts.join(',') || '-'} ${ms}ms`,
  );
  for (const d of query.diag) log(`  diag ${type}/${rest}`, `${d.lane} ok=${d.ok} ${d.detail} (${d.ms}ms)`);
}

console.log('[vl:done]');
