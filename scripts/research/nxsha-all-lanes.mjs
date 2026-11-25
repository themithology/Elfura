#!/usr/bin/env node
/**
 * Every lane of both multi-lane sources, measured — not sampled.
 *
 * ---------------------------------------------------------------
 * The board was built on a survey that tested TWO titles (Fight Club, a Hollywood
 * film; Naruto, an anime) against 30 nxsha lanes. Twenty-two returned nothing and
 * were treated as dead.
 *
 * That sample was indefensible. Look at what it discarded:
 *
 *   tamilblasters, hdhub4u, hdhub4u-direct, k4khdhub, k4khdhub-direct,
 *   filmyfly, filmyfly-direct, moviesdrive, yomovies, mhbox, movone
 *
 * Those are Indian-catalogue scrapers. They were asked for an American film and
 * an anime, and their silence was recorded as "nothing". A lane that serves only
 * Tamil or only Bollywood titles is exactly the lane a viewer asking for Hindi
 * needs, and it was never asked for a title it plausibly carries.
 *
 * And source-1 has the same shape: `scrapper.rivestream.app` publishes SIX
 * providers (citadel, primevids, flowcast, quasar, guru, hindicast) and the
 * adapter asks one. The attic notes that quasar/guru/hindicast "answer only from
 * some regions (an India-hosted box sees more of them than a US runner)" — so a
 * runner test that reports them silent is a region result, not a dead lane.
 *
 * WHAT THIS PROBE DOES
 * --------------------
 *   - nxsha: all 30 non-RiveStream lanes, against eight Indian-weighted titles,
 *     two titles per lane, so a lane that serves nothing is actually answered.
 *   - rive: all six providers against the same title set.
 *   - it prints every row's host and label, and counts per lane.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It changes no adapter and no allowlist. Widening a surface on the strength of
 * one probe is how the old board got thirty adapters and no streams. The lanes
 * that answer here get added, and the contract is what admits them.
 */
import fs from 'node:fs/promises';
import { call, scrapers } from './nxsha-client.mjs';


const OUT = 'research/nxsha-all-lanes.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const RIVE_API = 'https://scrapper.rivestream.app/api/provider';
const NXSHA_ORIGIN = 'https://nxsha.space';
const RIVE_PROVIDERS = ['citadel', 'primevids', 'flowcast', 'quasar', 'guru', 'hindicast'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Eight titles weighted to the catalogues the 22 untested lanes are named for.
 * A Hindi/Tamil/Punjabi audience is the reason those lanes exist, so a probe that
 * only asks for Fight Club is not testing them.
 */
const TITLES = [
  { key: 'rrr', type: 'movie', tmdbId: '579974', why: 'Telugu/Hindi blockbuster' },
  { key: 'kalki-2898', type: 'movie', tmdbId: '1117737', why: 'pan-India' },
  { key: 'jawan', type: 'movie', tmdbId: '872906', why: 'Hindi' },
  { key: 'baahubali-2', type: 'movie', tmdbId: '316726', why: 'Telugu/Tamil' },
  { key: 'pathaan', type: 'movie', tmdbId: '872585', why: 'Hindi' },
  { key: 'mirzapur-s1e1', type: 'tv', tmdbId: '89197', season: 1, episode: 1, why: 'Hindi series' },
  { key: 'sacred-games-s1e1', type: 'tv', tmdbId: '85737', season: 1, episode: 1, why: 'Hindi series' },
  { key: 'fight-club', type: 'movie', tmdbId: '550', why: 'control: the old sample' },
];

function hostOf(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function nxshaLane(lane, title) {
  const answer = await call('sources', {
    tmdbId: title.tmdbId,
    imdb_id: '',
    type: title.type,
    season: title.type === 'tv' ? (title.season ?? 1) : 0,
    episode: title.type === 'tv' ? (title.episode ?? 1) : 0,
    ex_lang: true,
    provider: lane,
  });
  if (answer.error) return { error: answer.error, rows: [] };
  const rows = Array.isArray(answer.payload?.sources) ? answer.payload.sources : [];
  return {
    rows: rows
      .filter((r) => typeof r?.url === 'string' && /^https:\/\//i.test(r.url))
      .map((r) => ({
        host: hostOf(r.url),
        label: r.label ?? r.quality ?? null,
        type: r.type ?? null,
        isEmbed: r.isEmbed ?? null,
        // the URL is kept so a lane that answers can be contract-tested later
        url: r.url,
      })),
  };
}

/** The RiveStream API takes the provider key in the query. */
async function riveCall(provider, title) {
  const url = new URL(RIVE_API);
  url.searchParams.set('provider', provider);
  url.searchParams.set('id', title.tmdbId);
  if (title.type === 'tv') {
    url.searchParams.set('season', String(title.season ?? 1));
    url.searchParams.set('episode', String(title.episode ?? 1));
  }
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: 'https://www.rivestream.app/',
        Origin: 'https://www.rivestream.app',
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) return { status: response.status, rows: [], error: `http=${response.status}` };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { status: response.status, rows: [], error: 'not-json' };
    }
    const list = body?.data?.sources ?? body?.sources ?? [];
    return {
      status: response.status,
      rows: (Array.isArray(list) ? list : [])
        .filter((r) => typeof r?.url === 'string' && /^https:\/\//i.test(r.url))
        .map((r) => ({
          host: hostOf(r.url),
          label: r.label ?? r.quality ?? null,
          language: r.language ?? null,
          type: r.format ?? r.type ?? null,
          isEmbed: r.isEmbed ?? null,
        })),
    };
  } catch (error) {
    return { rows: [], error: `${error?.name}: ${error?.message}`.slice(0, 70) };
  }
}

async function main() {
  const report = { measuredAt: new Date().toISOString(), titles: TITLES, nxsha: [], rive: [] };

  // ── which lanes does nxsha actually offer right now ────────────────────────
  const listed = await scrapers({ type: 'movie', tmdbId: '550' });
  if (listed.error) {
    console.error(`could not list scrapers: ${listed.error}`);
    process.exit(2);
  }
  const own = listed.names.filter((n) => !/^rive-/i.test(n));
  console.log(`${listed.names.length} scraper(s) listed, ${own.length} not RiveStream`);
  console.log(`titles: ${TITLES.map((t) => t.key).join(', ')}\n`);

  // ── nxsha: every own lane, until it has answered on two titles ─────────────
  for (const lane of own) {
    const entry = { lane, hits: [], tried: [] };
    for (const title of TITLES) {
      if (entry.hits.length >= 2) break;
      await sleep(2200);
      const result = await nxshaLane(lane, title);
      entry.tried.push(title.key);
      if (result.error) {
        entry.error = result.error;
        continue;
      }
      if (result.rows.length > 0) {
        entry.hits.push({ title: title.key, rows: result.rows });
      }
    }
    const total = entry.hits.reduce((n, h) => n + h.rows.length, 0);
    const hosts = [...new Set(entry.hits.flatMap((h) => h.rows.map((r) => r.host)).filter(Boolean))];
    report.nxsha.push(entry);
    console.log(
      `  ${lane.padEnd(17)} ${String(total).padStart(3)} row(s) on ${entry.hits.length}/${entry.tried.length} title(s)  ` +
        (hosts.length ? hosts.join(',') : entry.error ? `ERROR ${entry.error}` : '—'),
    );
    for (const hit of entry.hits) {
      for (const row of hit.rows.slice(0, 3)) {
        console.log(`      ${hit.title.padEnd(16)} ${JSON.stringify(row.label).slice(0, 42).padEnd(44)} ${row.host}`);
      }
    }
  }

  // ── rive: all six providers ──────────────────────────────────────────────
  console.log('\nRiveStream providers (source-1 asks ONE of these):');
  for (const provider of RIVE_PROVIDERS) {
    const entry = { provider, hits: [] };
    for (const title of TITLES) {
      if (entry.hits.length >= 2) break;
      await sleep(2000);
      const result = await riveCall(provider, title);
      if (result.error) {
        entry.error = result.error;
        continue;
      }
      if (result.rows.length > 0) entry.hits.push({ title: title.key, rows: result.rows });
    }
    const total = entry.hits.reduce((n, h) => n + h.rows.length, 0);
    const hosts = [...new Set(entry.hits.flatMap((h) => h.rows.map((r) => r.host)).filter(Boolean))];
    report.rive.push(entry);
    console.log(
      `  ${provider.padEnd(12)} ${String(total).padStart(3)} row(s) on ${entry.hits.length} title(s)  ` +
        (hosts.length ? hosts.join(',') : entry.error ? `ERROR ${entry.error}` : '—'),
    );
  }

  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);

  // ── the summary that decides what gets added ─────────────────────────────
  const alive = report.nxsha.filter((l) => l.hits.length > 0).map((l) => l.lane);
  const silent = report.nxsha.filter((l) => l.hits.length === 0).map((l) => l.lane);
  console.log(`\nnxsha lanes that ANSWERED on an Indian-weighted title: ${alive.length}`);
  console.log(`  ${alive.join(', ')}`);
  console.log(`nxsha lanes still silent after 8 titles: ${silent.length}`);
  console.log(`  ${silent.join(', ')}`);
  const riveAlive = report.rive.filter((p) => p.hits.length > 0).map((p) => p.provider);
  console.log(`\nRiveStream providers that answered: ${riveAlive.join(', ') || 'none'}`);
  const riveDead = report.rive.filter((p) => p.hits.length === 0).map((p) => p.provider);
  console.log(`RiveStream providers silent: ${riveDead.join(', ') || 'none'}`);
  console.log(`\nwrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
