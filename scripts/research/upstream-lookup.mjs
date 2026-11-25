#!/usr/bin/env node
/**
 * "What does this upstream carry?" — asked of a lane that keeps an index.
 *
 * ---------------------------------------------------------------
 * The board keeps no catalogue (zero disk: every resolve asks the providers
 * afresh), so "what titles does X have" cannot be answered by querying the
 * board. It has to be answered by whatever index the provider still exposes.
 *
 * Vidly is exactly that index. Its subtitle catalogue is TMDB-keyed, does not
 * need a session, and answers one title at a time — which makes it useful for
 * more than subtitles: a TMDB id that returns tracks is a title Vidly knows
 * about, and the language set on it is a hint at what its catalogue covers.
 *
 * That is a lead generator, not proof. Vidly's subtitle index and its gated
 * stream API are different endpoints, and a row here does not mean a stream
 * exists. This probe reports what the INDEX says and nothing more.
 *
 * Bingr is handled differently, because bingr.one answered 403 to the old
 * harness. On the board's rule that "a 403 is a Cloudflare challenge, not a dead
 * site", it gets the same treatment videasy/hexa needed: a real browser UA, a
 * Referer from the site itself, and — if that fails — a check of whether the
 * refusal is an IP gate or a page gate.
 *
 * Writes research/upstream-lookup.json. Registers nothing.
 */
import fs from 'node:fs/promises';

const OUT = 'research/upstream-lookup.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A spread of TMDB ids, not a random sample: the titles this board had trouble
 * serving, the ones it serves best, and recent/old, movie/TV. If Vidly's index
 * has the Indic set on the hard ones, that is a real coverage signal.
 */
const TITLES = [
  { key: 'fight-club', type: 'movie', tmdbId: '550' },
  { key: 'inception', type: 'movie', tmdbId: '27205' },
  { key: 'dune-2', type: 'movie', tmdbId: '693134' },
  { key: 'rrr', type: 'movie', tmdbId: '579974' },
  { key: 'pathaan', type: 'movie', tmdbId: '823999' },
  { key: 'got-s1e1', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
  { key: 'naruto-s1e1', type: 'tv', tmdbId: '46260', season: 1, episode: 1 },
  { key: 'breaking-bad-s1e1', type: 'tv', tmdbId: '1396', season: 1, episode: 1 },
];

async function get(url, headers = {}, timeout = 15_000) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      contentType: response.headers.get('content-type')?.slice(0, 60) ?? null,
    };
  } catch (error) {
    return { status: null, text: '', error: `${error?.name}: ${error?.message}`.slice(0, 120) };
  }
}

/* ── Vidly: the index ──────────────────────────────────────────────────────── */

async function probeVidly() {
  const out = { site: 'vidly.pro', kind: 'subtitle-index', titles: [], steps: [] };

  // Is the stream API gated, and does the index answer without a session? Both
  // are asked so the report can say which part of the site is open.
  const home = await get('https://vidly.pro/');
  out.steps.push({ step: 'home', status: home.status, bytes: home.text.length, error: home.error });

  for (const title of TITLES) {
    await sleep(1200);
    const query =
      title.type === 'movie'
        ? `kind=movie&tmdb=${title.tmdbId}`
        : `kind=tv&tmdb=${title.tmdbId}&season=${title.season}&episode=${title.episode}`;
    const url = `https://vidly.pro/api/subtitles?${query}`;
    const answer = await get(url, { Accept: 'application/json', Referer: 'https://vidly.pro/' });
    let tracks = [];
    if (answer.status === 200) {
      try {
        tracks = JSON.parse(answer.text)?.subtitles ?? [];
      } catch {
        tracks = [];
      }
    }
    const langs = [...new Set(tracks.map((t) => String(t?.lang ?? '').toLowerCase()).filter(Boolean))];
    const hi = langPresent(langs, ['hi']);
    const indic = langs.filter((l) => ['hi', 'ta', 'te', 'ml', 'bn', 'pa', 'ur', 'kn'].includes(l));
    out.titles.push({
      title: title.key,
      status: answer.status,
      tracks: tracks.length,
      languages: langs,
      hasHindi: hi,
      indic,
      error: answer.error ?? null,
    });
    console.log(
      `  vidly ${title.key.padEnd(18)} ${String(answer.status).padEnd(4)} ${String(tracks.length).padStart(3)} track(s) ` +
        `${langs.length} lang(s)${indic.length ? ` indic=${indic.join(',')}` : ''}`,
    );
  }
  return out;
}

function langPresent(langs, want) {
  return langs.some((l) => want.includes(l.split('-')[0]));
}

/* ── Bingr: the refused lane ───────────────────────────────────────────────── */

async function probeBingr() {
  const out = { site: 'bingr', kind: 'watch-page-api', steps: [] };
  // Both known hosts: bingr.st is the one the retired adapter used, bingr.one
  // is the one the old harness recorded as 403.
  for (const host of ['https://bingr.st', 'https://bingr.one']) {
    const home = await get(`${host}/`, {}, 15_000);
    out.steps.push({
      step: `home:${host}`,
      status: home.status,
      bytes: home.text.length,
      contentType: home.contentType,
      // Cloudflare's interstitial is distinctive and worth naming, because
      // "403" alone cannot tell a challenge from a refusal.
      challenge: /just a moment|cf-chl|__cf_chl|Attention Required/i.test(home.text),
      error: home.error,
    });
    // A watch page, which is where the old adapter started. If the host answers
    // HTML here, the API path is worth trying; if it answers a challenge, no
    // header combination will help.
    await sleep(2500);
    const watch = await get(`${host}/watch/movie/550`, {}, 15_000);
    out.steps.push({
      step: `watch:${host}`,
      status: watch.status,
      bytes: watch.text.length,
      contentType: watch.contentType,
      challenge: /just a moment|cf-chl|__cf_chl|Attention Required/i.test(watch.text),
      error: watch.error,
    });
    const step = out.steps[out.steps.length - 1];
    console.log(`  bingr ${host} home=${home.status} watch=${watch.status}${step.challenge ? ' CHALLENGE' : ''}`);
    await sleep(3000);
  }

  const answered = out.steps.filter((s) => s.status === 200 && s.bytes > 2000);
  const challenged = out.steps.filter((s) => s.challenge);
  out.verdict = answered.length
    ? `reachable — ${answered.length} step(s) returned a real page; the old 403 was not universal`
    : challenged.length
      ? 'Cloudflare challenge — same class as videasy/hexa: the page never renders without a JS challenge'
      : 'refused without a challenge — an IP or geo gate, not a page gate';
  return out;
}

async function main() {
  console.log('upstream lookup,', new Date().toISOString());

  console.log('\n— vidly (index, not streams)');
  const vidly = await probeVidly();

  console.log('\n— bingr');
  const bingr = await probeBingr();

  const reachable = vidly.titles.some((t) => t.status === 200) || bingr.steps.some((s) => s.status === 200);
  if (!reachable) {
    console.error('\nrefusing to write a report: neither upstream answered.');
    process.exit(2);
  }

  const summary = {
    vidly: {
      titlesIndexed: vidly.titles.filter((t) => t.tracks > 0).length,
      ofTitles: vidly.titles.length,
      withHindi: vidly.titles.filter((t) => t.hasHindi).map((t) => t.title),
      withIndic: vidly.titles.filter((t) => t.indic.length > 0).map((t) => `${t.title}:${t.indic.join('+')}`),
      minTracks: Math.min(...vidly.titles.map((t) => t.tracks)),
      maxTracks: Math.max(...vidly.titles.map((t) => t.tracks)),
    },
    bingr: { verdict: bingr.verdict, steps: bingr.steps.length },
  };

  await fs.writeFile(OUT, `${JSON.stringify({ measuredAt: new Date().toISOString(), summary, vidly, bingr }, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
  console.log(`  vidly indexed ${summary.vidly.titlesIndexed}/${summary.vidly.ofTitles} titles, ${summary.vidly.minTracks}-${summary.vidly.maxTracks} tracks each`);
  console.log(`  vidly hindi on: ${summary.vidly.withHindi.join(', ') || 'none'}`);
  console.log(`  bingr: ${bingr.verdict}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
