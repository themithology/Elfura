#!/usr/bin/env node
/**
 * Lane survey — for every one of nxsha's own scrapers, what does it return, and
 * which of them are Google Drive?
 *
 * ---------------------------------------------------------------
 * Before an nxsha adapter is worth writing, the lane list has to be known. The
 * repo currently has 30 names and no measured state for 27 of them: the previous
 * probe measured three, and `research/all-source-upstream-audit.md` says "keep"
 * for most of the rest without a measurement.
 *
 * The specific question here is Google Drive. The board already refused six
 * sources for being Drive pipelines:
 *
 *   KatMovieHD / SSRMovies / KDMaza / PikaHD / KatDrama / Movies4u
 *   "rejected - Google Drive pipelines: quota-throttled, non-seekable,
 *    materially worse exposure"
 *
 * If nxsha's `moviesdrive` / `hdhub4u` / `filmyfly` lanes resolve to
 * drive.google.com, then adding those lanes would re-admit exactly what was
 * rejected - through a back door, which is worse than rejecting it openly.
 *
 * So each lane is measured on:
 *   1. does it answer at all (status)
 *   2. what media HOST it resolves to, and whether that host is Drive
 *   3. whether the URL is something a player can seek in (a .m3u8 vs a Drive page)
 *   4. its declared language label
 *
 * Writes research/nxsha-lanes.json. Registers nothing. Builds nothing.
 */
import fs from 'node:fs/promises';
import { scrapers, laneSources, ORIGIN } from './nxsha-client.mjs';

const OUT = 'research/nxsha-lanes.json';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TITLES = [
  { key: 'fight-club', type: 'movie', tmdbId: '550' },
  { key: 'naruto-s1e1', type: 'tv', tmdbId: '46260', season: 1, episode: 1 },
];

/** Hosts that mean this row is a Drive pipeline, or a relay in front of one. */
const DRIVE = /(?:^|\.)(?:drive|docs)\.google\.com$|drive\.usercontent\.google\.com$|googleusercontent\.com$/i;
/** A relay-shaped host, which this board refuses however the media behaves. */
const RELAY = /(?:^|[.-])(?:proxy|relay|transcode|bridge|worker|workers|gateway|mirror|edge)\d*(?:[.-]|$)|workers\.dev$/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** How a row would behave in a player, which decides whether it is worth having. */
function shapeOf(url) {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (/\.m3u8$/.test(path)) return 'hls';
  if (/\.mpd$/.test(path)) return 'dash';
  if (/\.mp4$/.test(path)) return 'mp4';
  if (DRIVE.test(hostOf(url) ?? '')) return 'drive-page';
  if (/\/file\/d\/|uc\?|usercontent/.test(url)) return 'drive-page';
  return 'other';
}

async function main() {
  console.log('nxsha lane survey,', new Date().toISOString(), `origin=${ORIGIN}`);

  const listed = await scrapers({ type: 'movie', tmdbId: '550' });
  if (listed.error) {
    console.error(`could not list scrapers: ${listed.error}`);
    process.exit(2);
  }
  const own = listed.names.filter((name) => !/^rive-/i.test(name));
  console.log(`${listed.names.length} scraper(s) listed, ${own.length} not RiveStream, key ${listed.pass}`);

  const lanes = [];
  for (const name of own) {
    const row = { lane: name, titles: [] };
    for (const title of TITLES) {
      // Serial, three seconds apart: this is a survey of 30 lanes on somebody
      // else's API, and a burst is how you get 429s that look like dead lanes.
      await sleep(3000);
      try {
        const { rows, error } = await laneSources(title, name);
        const hosts = [...new Set(rows.map((r) => hostOf(r.url)).filter(Boolean))];
        const shapes = [...new Set(rows.map((r) => shapeOf(r.url)))];
        const languages = [...new Set(rows.map((r) => r.audioLang).filter(Boolean))].slice(0, 6);
        row.titles.push({
          title: title.key,
          rows: rows.length,
          hosts,
          shapes,
          languages,
          drive: hosts.filter((h) => DRIVE.test(h)),
          relay: hosts.some((h) => RELAY.test(h)),
          error: error ?? null,
        });
      } catch (error) {
        row.titles.push({ title: title.key, rows: 0, error: String(error?.message ?? error).slice(0, 120) });
      }
    }
    const total = row.titles.reduce((sum, t) => sum + (t.rows ?? 0), 0);
    const isDrive = row.titles.some((t) => t.drive?.length);
    const isRelay = row.titles.some((t) => t.relay);
    row.total = total;
    row.kind = isDrive ? 'google-drive' : isRelay ? 'relay-shaped' : total > 0 ? 'media' : 'nothing';
    lanes.push(row);

    const hosts = [...new Set(row.titles.flatMap((t) => t.hosts ?? []))].slice(0, 3);
    console.log(
      `  ${name.padEnd(20)} ${String(total).padStart(2)} row(s)  ${row.kind.padEnd(12)} ${hosts.join(', ') || '-'}`,
    );
  }

  const summary = {
    listed: listed.names.length,
    own: own.length,
    media: lanes.filter((l) => l.kind === 'media').map((l) => l.lane),
    drive: lanes.filter((l) => l.kind === 'google-drive').map((l) => l.lane),
    relay: lanes.filter((l) => l.kind === 'relay-shaped').map((l) => l.lane),
    nothing: lanes.filter((l) => l.kind === 'nothing').map((l) => l.lane),
  };

  const measured = lanes.some((l) => l.total > 0);
  if (!measured) {
    console.error('\nrefusing to write a report: no lane returned a row. A burst block, or the API is down.');
    process.exit(2);
  }

  await fs.writeFile(
    OUT,
    `${JSON.stringify({ measuredAt: new Date().toISOString(), origin: ORIGIN, summary, lanes }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nwrote ${OUT}`);
  console.log(`  media ${summary.media.length}: ${summary.media.join(', ') || '-'}`);
  console.log(`  google-drive ${summary.drive.length}: ${summary.drive.join(', ') || '-'}`);
  console.log(`  relay-shaped ${summary.relay.length}: ${summary.relay.join(', ') || '-'}`);
  console.log(`  nothing ${summary.nothing.length}: ${summary.nothing.join(', ') || '-'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
