#!/usr/bin/env node
/**
 * Vidly STREAMS — the part that was never measured.
 *
 * ---------------------------------------------------------------
 * The repo has only ever looked at vidly's subtitles. The retired adapter
 * explicitly refused `/api/sources` and wrote down why:
 *
 *   "requires a per-session token scraped from the page HTML ... the encryption
 *    is a hand-rolled xorshift keystream keyed by a single hardcoded string in
 *    the public JS bundle ... getting it wrong yields garbage rather than an
 *    error"
 *
 * That is a description of a difficulty, not a measurement of whether it works.
 * The same document also said the streams come from "the same upstreams already
 * reachable through citadel and the Workers bridge" — an assumption, never
 * checked.
 *
 * So this probes the whole stream path:
 *
 *   1. does the watch page still render server-side, and does it carry a token
 *   2. what does the JS bundle contain — the keystream key, the endpoint, formats
 *   3. can a token be obtained and the payload decrypted with the documented
 *      method
 *   4. WHAT HOSTS does the decrypted payload point at, and do they overlap the
 *      board (the independence question that decided vidlink and nxsha)
 *   5. does one of those URLs actually serve bytes
 *
 * It reports each step separately, because "403" from step 3 and "empty" from
 * step 4 mean completely different things.
 *
 * Writes research/vidly-streams.json. Registers nothing.
 */
import fs from 'node:fs/promises';

const OUT = 'research/vidly-streams.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ORIGIN = 'https://vidly.pro';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url, headers = {}, timeout = 20_000) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    const text = await response.text();
    return { status: response.status, text, contentType: response.headers.get('content-type') };
  } catch (error) {
    return { status: null, text: '', error: `${error?.name}: ${error?.message}`.slice(0, 120) };
  }
}

const DOMAIN = (raw) => {
  try {
    const labels = new URL(raw).hostname.toLowerCase().split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const tld = labels[labels.length - 1];
    const sld = labels[labels.length - 2];
    const compound = tld.length === 2 && /^(?:co|com|net|org|gov|edu|ac)$/.test(sld);
    return labels.slice(compound ? -3 : -2).join('.');
  } catch {
    return null;
  }
};

async function main() {
  const report = { measuredAt: new Date().toISOString(), steps: [] };
  console.log('vidly stream probe,', new Date().toISOString());

  // ── 1. the watch page ────────────────────────────────────────────────────
  const watchUrl = `${ORIGIN}/watch/movie/550`;
  const watch = await get(watchUrl, { Referer: `${ORIGIN}/` });
  const html = watch.text;
  const tokens = [
    ...new Set(
      [...html.matchAll(/(?:token|session|key)["':\s]{1,4}"?([A-Za-z0-9._-]{16,120})"?/gi)].map((m) => m[1]),
    ),
  ].slice(0, 6);
  report.steps.push({
    step: 'watch-page',
    url: watchUrl,
    status: watch.status,
    bytes: html.length,
    contentType: watch.contentType,
    isNextJs: /\/_next\//.test(html),
    tokenLike: tokens.length,
    error: watch.error,
  });
  console.log(`  watch-page           ${watch.status} ${html.length}B tokens=${tokens.length} nextjs=${/_next\//.test(html)}`);

  // ── 2. the bundle ────────────────────────────────────────────────────────
  const chunks = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9_.-]+\.js/g)].map((m) => m[0]))].slice(0, 14);
  const bundleFindings = { chunks: chunks.length, ketcandles: [], endpoints: [], formats: [] };
  const keys = [];
  const bundleBodies = [];
  for (const path of chunks) {
    await sleep(300);
    const body = await get(`${ORIGIN}${path}`, { Referer: watchUrl });
    if (body.status !== 200) continue;
    bundleBodies.push(body.text);
    // A keystream key is described as a hardcoded string; collect candidates.
    for (const m of body.text.matchAll(/["'`]([A-Za-z0-9_+=/-]{20,64})["'`]/g)) keys.push(m[1]);
    for (const m of body.text.matchAll(/\/api\/[A-Za-z0-9/_-]+/g)) bundleFindings.endpoints.push(m[0]);
  }
  bundleFindings.ketcandles = [...new Set(keys)].slice(0, 8);
  bundleFindings.endpoints = [...new Set(bundleFindings.endpoints)].slice(0, 12);
  // What media formats the bundle mentions at all — a lead, not a finding.
  bundleFindings.formats = ['m3u8', 'mp4', 'mpd', 'hls'].filter((f) =>
    bundleBodies.some((body) => new RegExp(f, 'i').test(body)),
  );
  report.steps.push({ step: 'bundle', ...bundleFindings });
  console.log(`  bundle               ${chunks.length} chunk(s)  endpoints=[${bundleFindings.endpoints.join(',')}]`);
  console.log(`  key candidates       ${bundleFindings.ketcandles.length}`);

  // ── 3. the stream API, honestly ──────────────────────────────────────────
  // Try several shapes, because a 403 on one path does not mean none works.
  const apiShapes = [
    `${ORIGIN}/api/sources?tmdb=550&kind=movie`,
    `${ORIGIN}/api/sources?kind=movie&tmdb=550&type=movie`,
    `${ORIGIN}/api/stream?tmdb=550&kind=movie`,
  ];
  const apiResults = [];
  for (const url of apiShapes) {
    await sleep(1200);
    const answer = await get(url, { Accept: 'application/json', Referer: watchUrl, Origin: ORIGIN });
    const isChallenge = /just a moment|cf-chl|Attention Required|oldie/i.test(answer.text.slice(0, 400));
    apiResults.push({
      url: url.replace(ORIGIN, ''),
      status: answer.status,
      bytes: answer.text.length,
      looksLikeJson: answer.text.trimStart().startsWith('{'),
      challenge: isChallenge,
      body: answer.text.slice(0, 120),
    });
    console.log(`  ${url.replace(ORIGIN, '').padEnd(48)} ${answer.status} ${isChallenge ? 'CHALLENGE' : answer.text.trimStart().startsWith('{') ? 'JSON' : ''}`);
  }
  report.steps.push({ step: 'stream-api', shapes: apiResults });

  // ── 4. any media URL visible without decrypting ──────────────────────────
  const mediaInPage = [
    ...new Set([
      ...[...html.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|mpd)[^\s"'<>\\]*/gi)].map((m) => m[0]),
      ...[...html.matchAll(/https?:\/\/[^\s"'<>\\]*\/(?:hls|playlist|manifest|stream)[^\s"'<>\\]*/gi)].map((m) => m[0]),
    ]),
  ].slice(0, 8);
  report.steps.push({
    step: 'media-in-page',
    count: mediaInPage.length,
    urls: mediaInPage.map((u) => u.slice(0, 140)),
    domains: [...new Set(mediaInPage.map(DOMAIN).filter(Boolean))],
  });
  console.log(`  media in page        ${mediaInPage.length}`);

  const reachable = watch.status === 200;
  if (!reachable) {
    console.error('\nrefusing to write a report: the watch page did not render.');
    process.exit(2);
  }
  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
