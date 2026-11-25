#!/usr/bin/env node
/**
 * Is the awsind row dead, or is the way it is fetched wrong?
 *
 * ---------------------------------------------------------------
 * The contract probes movie/550. After the language rule was corrected, exactly
 * one nxsha row survives for that title — `awsind`, labelled "Hindi" — and its
 * manifest came back 502 through the board's own proxy. Everything else for that
 * title is labelled with a LANE name ("hguider", "watchout"), and a row that
 * names no language is refused on purpose.
 *
 * So the lane now stands or falls on one row on one host, and "502" does not say
 * which side failed. It could be:
 *
 *   - the host is dead,
 *   - the host needs the row's own headers (nxsha sends them, 23/23 rows carry
 *     a `headers` object) and the proxy dropped them,
 *   - the URL is a page rather than a manifest, i.e. not fetchable as a playlist,
 *   - or `org_uri` is the address that actually serves, and `url` is rewritten.
 *
 * This fetches every row for both probe titles four ways — plain, with the row's
 * headers, with a range request, and `org_uri` — and reports what came back.
 * It does not touch the board's proxy, so a 502 here is the upstream's.
 */
import fs from 'node:fs/promises';
import { call, scrapers } from './nxsha-client.mjs';

const OUT = 'research/nxsha-row-liveness.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const LANES = ['nitro', 'watchout', 'awsind', 'purstream', 'ophim'];
const TITLES = [
  { key: 'fight-club', type: 'movie', tmdbId: '550' },
  { key: 'got-s1e1', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url, headers, extra = {}) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...(headers ?? {}), ...extra },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes: text.length,
      // A manifest starts with #EXTM3U; a page starts with <
      first: text.slice(0, 40).replace(/\s+/g, ' '),
      isManifest: /^\s*#EXTM3U/i.test(text),
      isMarkup: /^\s*</.test(text),
      finalHost: (() => {
        try {
          return new URL(response.url).hostname;
        } catch {
          return null;
        }
      })(),
    };
  } catch (error) {
    return { status: null, error: `${error?.name}: ${error?.message}`.slice(0, 80) };
  }
}

async function main() {
  const report = { measuredAt: new Date().toISOString(), rows: [] };
  const listed = await scrapers({ type: 'movie', tmdbId: '550' });
  if (listed.error) {
    console.error(`could not list scrapers: ${listed.error}`);
    process.exit(2);
  }

  for (const title of TITLES) {
    for (const lane of LANES.filter((l) => listed.names.includes(l))) {
      await sleep(2500);
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
        console.log(`  ${title.key.padEnd(12)} ${lane.padEnd(10)} rows ERROR ${answer.error}`);
        continue;
      }
      const rows = Array.isArray(answer.payload?.sources) ? answer.payload.sources : [];
      for (const row of rows) {
        const entry = {
          title: title.key,
          lane,
          label: row.label ?? null,
          url: row.url,
          orgUriSame: row.org_uri === row.url,
          headers: row.headers ?? null,
        };
        await sleep(800);
        entry.plain = await probe(row.url, null);
        await sleep(800);
        entry.withRowHeaders = await probe(row.url, row.headers);
        if (row.org_uri && row.org_uri !== row.url) {
          await sleep(800);
          entry.orgUri = await probe(row.org_uri, row.headers);
        }
        report.rows.push(entry);
        const p = entry.plain;
        console.log(
          `  ${title.key.padEnd(12)} ${lane.padEnd(9)} label=${String(row.label ?? '').slice(0, 26).padEnd(26)} ` +
            `plain=${p.status ?? p.error} ${p.isManifest ? 'M3U8' : p.isMarkup ? 'MARKUP' : ''} ` +
            `hdr=${entry.withRowHeaders.status ?? entry.withRowHeaders.error}`,
        );
      }
    }
  }

  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${OUT}`);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
