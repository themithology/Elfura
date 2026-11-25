#!/usr/bin/env node
/**
 * Which field actually names the language on an nxsha row?
 *
 * ---------------------------------------------------------------
 * The adapter reads `row.language`. The lane survey read
 * `s.language ?? s.label`, so the recorded evidence cannot say which of those
 * two the API actually populates — and both of the survey's sample values
 * ("hguider | 1080P") look like a `label`, not a language.
 *
 * This was found the expensive way. A rule was added that refuses any row
 * without `row.language`, and source-3 immediately went to 0 candidates on the
 * contract — either every row is genuinely unlabelled, or the field is simply
 * not the one that carries the language, and the rule threw away the lane.
 * Those are opposite conclusions and the difference decides whether source-3
 * stays on the board.
 *
 * So: dump EVERY field of EVERY row, verbatim, for the lanes that serve media.
 * No summary, no `??` chain, no first-ten. That is what "measure, do not guess"
 * has to mean in a probe.
 */
import fs from 'node:fs/promises';
import { call, scrapers } from './nxsha-client.mjs';

const OUT = 'research/nxsha-row-fields.json';
const MEDIA_LANES = ['nitro', 'watchout', 'awsind', 'purstream', 'ophim'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const report = { measuredAt: new Date().toISOString(), titles: [], fields: {} };
  const listed = await scrapers({ type: 'movie', tmdbId: '550' });
  if (listed.error) {
    console.error(`could not list scrapers: ${listed.error}`);
    process.exit(2);
  }
  const lanes = MEDIA_LANES.filter((name) => listed.names.includes(name));
  console.log(`lanes on offer: ${lanes.join(', ') || 'none'}`);

  const titles = [
    { key: 'fight-club', type: 'movie', tmdbId: '550' },
    { key: 'naruto-s1e1', type: 'tv', tmdbId: '46260', season: 1, episode: 1 },
    { key: 'got-s1e1', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
  ];

  // Every key seen on any row, and how often it was non-empty. This is the
  // answer to "which field carries the language" without guessing.
  const seen = new Map();

  for (const title of titles) {
    for (const lane of lanes) {
      await sleep(2500);
      // RAW payload only. laneSources() projects each row onto {url,type,quality,
      // audioLang} and would drop exactly the field this probe exists to find.
      const answer = await call('sources', {
        tmdbId: title.tmdbId,
        imdb_id: '',
        type: title.type,
        season: title.type === 'tv' ? (title.season ?? 1) : 0,
        episode: title.type === 'tv' ? (title.episode ?? 1) : 0,
        ex_lang: true,
        provider: lane,
      });
      if (answer.error) {
        report.titles.push({ title: title.key, lane, error: answer.error, rows: [] });
        console.log(`  ${title.key.padEnd(13)} ${lane.padEnd(10)} ERROR ${answer.error}`);
        continue;
      }
      const raw = Array.isArray(answer.payload?.sources) ? answer.payload.sources : [];
      report.titles.push({ title: title.key, lane, rows: raw });
      console.log(`  ${title.key.padEnd(13)} ${lane.padEnd(10)} ${raw.length} row(s)`);
      for (const row of raw) {
        for (const [key, value] of Object.entries(row)) {
          if (value === undefined || value === null || value === '') continue;
          const entry = report.fields[key] ?? { nonEmpty: 0, samples: [] };
          entry.nonEmpty += 1;
          if (entry.samples.length < 5) entry.samples.push(String(value).slice(0, 40));
          report.fields[key] = entry;
        }
      }
    }
  }

  console.log('\nfields present on real rows (non-empty count, samples):');
  for (const [key, entry] of Object.entries(report.fields).sort((a, b) => b[1].nonEmpty - a[1].nonEmpty)) {
    console.log(`  ${key.padEnd(14)} ${String(entry.nonEmpty).padStart(3)}  ${entry.samples.join(' | ')}`);
  }

  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
