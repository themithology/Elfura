#!/usr/bin/env node
/**
 * Does source-25 (Greybox) produce playable candidates through our own adapter?
 *
 * The raw API is already proven: 12-21 JSON sources per title, and both the
 * absolute CDN URLs and the relative /api/media proxy URLs return real #EXTM3U.
 * What is not proven is our adapter: language normalisation, relative-URL
 * resolution, subtitle extraction and segment mapping all sit between that
 * payload and a candidate the registry will accept.
 *
 * Six titles across movies, US TV, anime and a non-English series, so one lucky
 * title cannot carry the verdict.
 */
import { createSource25Adapter } from '../dist/backend/sources/source25.js';

const log = (t, v) => console.log(`[gb25] ${t} :: ${v}`);

const adapter = createSource25Adapter({
  enabled: true,
  origin: 'https://greyboxtv.duckdns.org',
  timeoutMs: 15_000,
  rank: 50,
});

log('adapter', `${adapter.id} (${adapter.label}) enabled=${adapter.enabled()}`);

const CASES = (process.env.GB_TITLES || 'movie:1368337,tv:71446/1/1,movie:550,tv:1399/1/1,tv:94664/1/1,movie:693134')
  .split(',')
  .map((t) => {
    const [type, rest] = t.trim().split(':');
    return { type, rest };
  });

let total = 0;

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
  total += out.candidates.length;

  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '?'; } };
  const hosts = [...new Set(out.candidates.map((c) => hostOf(c.url)))];
  const quals = [...new Set(out.candidates.map((c) => c.quality))];
  const langs = [...new Set(out.candidates.flatMap((c) => c.availableAudioLangs ?? []))];
  const claimed = [...new Set(out.candidates.map((c) => c.claimedAudioLang).filter(Boolean))];
  const types = [...new Set(out.candidates.map((c) => c.type))];
  const subCount = out.candidates.reduce((n, c) => n + (c.subtitles?.length ?? 0), 0);
  const seg = out.segments
    ? `seg=${Object.entries(out.segments).map(([k, v]) => `${k}[${v?.join('-')}]`).join(',')}`
    : 'seg=none';

  log(
    `${type}/${rest}`,
    `candidates=${out.candidates.length} types=${types.join(',')} quals=${quals.slice(0, 6).join(',')} ` +
    `claimed=${claimed.slice(0, 8).join(',') || '-'} availLangs=${langs.length} subs=${subCount} ` +
    `${seg} hosts=${hosts.join('|')} ${ms}ms`
  );
  for (const d of query.diag) log(`  diag ${type}/${rest}`, `${d.lane} ok=${d.ok} ${d.detail} (${d.ms}ms)`);
}

log('summary', `totalCandidates=${total} over ${CASES.length} titles`);
console.log('[gb25:done]');
