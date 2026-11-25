#!/usr/bin/env node
/**
 * Vidly, in more detail than the first pass.
 *
 * ---------------------------------------------------------------
 * The first probe concluded "no Hindi" from the `lang` CODE alone, and printed
 * only the first ten codes for a title. Both were shortcuts, and the second one
 * was indefensible: a title with 14 tracks showed 8 codes, and the console hid
 * the rest. The stored JSON had the full list, so the conclusion happened to
 * hold - but it held by luck, not by method.
 *
 * A subtitle row carries more than a code:
 *
 *   { url, lang, label, group, source }
 *
 * `group` is what the site displays, and `label` carries the variant - including
 * the "(HI)" suffix the retired adapter had to special-case because it means
 * HEARING IMPAIRED, not Hindi. A code-only reading cannot tell those apart, and
 * cannot see a language the site files under an unexpected code.
 *
 * So this probe records every field of every row, and asks three separate
 * questions the first pass did not:
 *
 *   1. RAW — what is actually in the rows, labels and groups included
 *   2. BREADTH — does the index cover Indian titles at all, or only Western ones
 *   3. STREAMS — is the stream API still gated, or does it answer now
 *
 * Writes research/vidly-deep.json. Registers nothing.
 */
import fs from 'node:fs/promises';

const OUT = 'research/vidly-deep.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deliberately weighted toward Indian and regional titles.
 *
 * The first pass used mostly Western films and found no Hindi, which is not
 * surprising if the index simply does not cover Indian cinema well. The question
 * worth asking is the reverse: pick the titles a Hindi viewer would search for,
 * and see what comes back.
 */
const TITLES = [
  { key: 'rrr', type: 'movie', tmdbId: '579974' },
  { key: 'pathaan', type: 'movie', tmdbId: '823999' },
  { key: 'jawan', type: 'movie', tmdbId: '913290' },
  { key: 'animal', type: 'movie', tmdbId: '1041613' },
  { key: 'dangal', type: 'movie', tmdbId: '360814' },
  { key: '3-idiots', type: 'movie', tmdbId: '20453' },
  { key: 'bahubali-2', type: 'movie', tmdbId: '348350' },
  { key: 'kalki-2898', type: 'movie', tmdbId: '801688' },
  { key: 'leo', type: 'movie', tmdbId: '990851' },
  { key: 'salaar', type: 'movie', tmdbId: '870358' },
  { key: 'mirzapur-s1e1', type: 'tv', tmdbId: '89829', season: 1, episode: 1 },
  { key: 'sacred-games-s1e1', type: 'tv', tmdbId: '79744', season: 1, episode: 1 },
  { key: 'money-heist-s1e1', type: 'tv', tmdbId: '71446', season: 1, episode: 1 },
  { key: 'panchayat-s1e1', type: 'tv', tmdbId: '96162', season: 1, episode: 1 },
];

async function get(url, headers = {}, timeout = 15_000) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    const text = await response.text();
    return { status: response.status, text, contentType: response.headers.get('content-type') };
  } catch (error) {
    return { status: null, text: '', error: `${error?.name}: ${error?.message}`.slice(0, 100) };
  }
}

/**
 * Every field of every row, and every distinct value per field.
 *
 * The point is to be able to answer "is Hindi here under another name" from the
 * data alone, without another round trip.
 */
function analyse(tracks) {
  const rows = tracks.map((t) => ({
    lang: typeof t?.lang === 'string' ? t.lang : null,
    label: typeof t?.label === 'string' ? t.label : null,
    group: typeof t?.group === 'string' ? t.group : null,
    source: typeof t?.source === 'string' ? t.source : null,
    // A host is enough to show where tracks come from; not the whole URL.
    host: (() => {
      try {
        return new URL(String(t?.url)).hostname;
      } catch {
        return null;
      }
    })(),
  }));

  const unique = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort();
  const langs = unique('lang');
  const groups = unique('group');

  // A language named in a LABEL or GROUP that the `lang` codes never mention.
  // This is the check the first pass could not make: it only read `lang`.
  const NAMES = {
    hindi: 'hi',
    tamil: 'ta',
    telugu: 'te',
    malayalam: 'ml',
    kannada: 'kn',
    bengali: 'bn',
    punjabi: 'pa',
    urdu: 'ur',
    marathi: 'mr',
    gujarati: 'gu',
  };
  const named = new Set();
  for (const row of rows) {
    for (const field of [row.label, row.group]) {
      if (!field) continue;
      for (const [name, code] of Object.entries(NAMES)) {
        if (new RegExp(`\\b${name}\\b`, 'i').test(field)) named.add(code);
      }
    }
  }
  // A "(HI)" suffix means HEARING IMPAIRED. It must never be read as Hindi, and
  // the retired adapter had a bug risk precisely here.
  const hearingImpaired = rows.filter((r) => r.label && /\(hi\)/i.test(r.label)).length;
  const hiAsHindi = rows.filter(
    (r) => r.lang === 'hi' || (r.group && /\bhindi\b/i.test(r.group)),
  ).length;

  return {
    rows,
    langs,
    groups,
    sources: unique('source'),
    hosts: unique('host'),
    namedInLabels: [...named].sort(),
    hearingImpairedLabels: hearingImpaired,
    hindiRows: hiAsHindi,
  };
}

async function main() {
  console.log('vidly deep probe,', new Date().toISOString());

  const out = { measuredAt: new Date().toISOString(), titles: [], streams: null };
  const hindiSeen = [];
  const namedSeen = new Set();

  for (const title of TITLES) {
    await sleep(1200);
    const query =
      title.type === 'movie'
        ? `kind=movie&tmdb=${title.tmdbId}`
        : `kind=tv&tmdb=${title.tmdbId}&season=${title.season}&episode=${title.episode}`;
    const answer = await get(`https://vidly.pro/api/subtitles?${query}`, {
      Accept: 'application/json',
      Referer: 'https://vidly.pro/',
    });

    let tracks = [];
    if (answer.status === 200) {
      try {
        tracks = JSON.parse(answer.text)?.subtitles ?? [];
      } catch {
        tracks = [];
      }
    }
    const analysis = analyse(Array.isArray(tracks) ? tracks : []);
    if (analysis.hindiRows > 0) hindiSeen.push(`${title.key}(${analysis.hindiRows})`);
    for (const code of analysis.namedInLabels) namedSeen.add(code);

    out.titles.push({
      title: title.key,
      status: answer.status,
      tracks: Array.isArray(tracks) ? tracks.length : 0,
      ...analysis,
    });

    const full = analysis.langs.join(',');
    console.log(
      `  ${title.key.padEnd(20)} ${String(answer.status).padEnd(4)} ${String(tracks.length).padStart(3)} tracks  ` +
        `langs=[${full}]`,
    );
    if (analysis.namedInLabels.length) {
      console.log(`  ${''.padEnd(20)} named in label/group: ${analysis.namedInLabels.join(',')}`);
    }
    if (analysis.hearingImpairedLabels) {
      console.log(`  ${''.padEnd(20)} ${analysis.hearingImpairedLabels} "(HI)" label(s) = hearing-impaired, not Hindi`);
    }
  }

  // 3. Is the stream API still gated?
  await sleep(2000);
  const streamPage = await get('https://vidly.pro/', {}, 15_000);
  const hasBundle = /\/_next\/static\/chunks\/[A-Za-z0-9_.-]+\.js/.test(streamPage.text);
  const streamProbe = await get('https://vidly.pro/api/sources?tmdb=550&kind=movie', {
    Accept: 'application/json',
    Referer: 'https://vidly.pro/',
  });
  out.streams = {
    home: streamPage.status,
    hasBundle,
    apiStatus: streamProbe.status,
    apiBody: streamProbe.text.slice(0, 160),
    gated:
      streamProbe.status !== 200 ||
      /token|unauthor|session|forbid/i.test(streamProbe.text.slice(0, 400)),
  };
  console.log(
    `\n  streams: home=${streamPage.status} bundle=${hasBundle} api=${streamProbe.status} ` +
      `${out.streams.gated ? 'GATED' : 'answered'}`,
  );

  out.summary = {
    titlesIndexed: out.titles.filter((t) => t.tracks > 0).length,
    ofTitles: out.titles.length,
    titlesWithHindi: hindiSeen,
    languagesNamedInLabels: [...namedSeen].sort(),
    unionOfLangs: [...new Set(out.titles.flatMap((t) => t.langs))].sort(),
    totalDistinctLangs: new Set(out.titles.flatMap((t) => t.langs)).size,
  };

  const reachable = out.titles.some((t) => t.status === 200);
  if (!reachable) {
    console.error('\nrefusing to write a report: the index answered nothing.');
    process.exit(2);
  }
  await fs.writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
  console.log(`  indexed ${out.summary.titlesIndexed}/${out.summary.ofTitles}`);
  console.log(`  ${out.summary.totalDistinctLangs} distinct language code(s) across all titles`);
  console.log(`  titled with Hindi: ${hindiSeen.join(', ') || 'NONE'}`);
  console.log(`  languages named in labels/groups: ${out.summary.languagesNamedInLabels.join(',') || 'none'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
