#!/usr/bin/env node
/**
 * Does our source-4 (bingr) actually return candidates - especially on the
 * titles where the embed-entry crack provably works?
 *
 * The embed probe showed vidly.pro/embed/tv/94664/1/1 carrying a Prism payload
 * with 6 streams of real HLS on dash-hls-bridge.johndoesdmc.workers.dev, while
 * movie/550 only carried a single "Edge" 1080p entry. So a blanket "bingr is
 * broken" or "bingr is fine" is wrong either way: it depends on the title.
 *
 * This runs OUR adapter unmodified on that same matrix, so the verdict is about
 * what we ship rather than what the cipher can do. Counts, hosts, qualities and
 * the adapter's own diag trace only.
 */
import { createSource4Adapter } from '../dist/backend/sources/source4.js';

const log = (t, v) => console.log(`[s4] ${t} :: ${v}`);

const adapter = createSource4Adapter(() => true);
log('adapter', `${adapter.id} (${adapter.label})`);

const CASES = (process.env.S4_TITLES || 'movie:550,tv:1399/1/1,tv:94664/1/1,movie:693134')
  .split(',')
  .map((t) => {
    const [type, rest] = t.trim().split(':');
    return { type, rest };
  });

let totalCandidates = 0;

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
  let out;
  try {
    out = await adapter.resolve(query);
  } catch (error) {
    log(`${type}/${rest}`, `THREW ${error.message}`);
    continue;
  }
  const ms = Date.now() - started;
  totalCandidates += out.candidates.length;

  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '?'; } };
  const hosts = [...new Set(out.candidates.map((c) => hostOf(c.url)))];
  const types = [...new Set(out.candidates.map((c) => c.type))];
  const quals = out.candidates.map((c) => c.quality).slice(0, 8);
  const langs = [...new Set(out.candidates.map((c) => c.audioLang).filter(Boolean))];

  log(
    `${type}/${rest}`,
    `candidates=${out.candidates.length} types=${types.join(',') || '-'} ` +
    `quals=${quals.join(',') || '-'} langs=${langs.join(',') || '-'} ` +
    `hosts=${hosts.join('|') || '-'} ${ms}ms`
  );
  for (const d of query.diag) log(`  diag ${type}/${rest}`, `${d.lane} ok=${d.ok} ${d.detail} (${d.ms}ms)`);
}

log('summary', `totalCandidates=${totalCandidates} over ${CASES.length} titles`);
console.log('[s4:done]');
