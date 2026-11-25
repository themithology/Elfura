#!/usr/bin/env node
/**
 * Does vidly's stream actually play, and whose media is it?
 *
 * ---------------------------------------------------------------
 * The previous probe found a real media URL sitting in the watch page HTML, with
 * no token and no decryption:
 *
 *   https://img.rousav.tech/media/84ba08366bab854da1bf/index.m3u8
 *
 * That is not the "same upstream as citadel and the Workers bridge" the retired
 * adapter assumed. `rousav.tech` appears nowhere on the current board:
 *
 *   source-1  hscow.com, fcxmb.com
 *   source-2  greyboxtv.duckdns.org
 *   source-3  itsnitrox.tech, nxstreamhub.workers.dev, 97bf1.com
 *
 * So the assumption that made vidly's streams "not worth it" may simply be
 * wrong. This probe answers three questions, in this order, and the order
 * matters because a failure at (1) makes (2) and (3) irrelevant for now:
 *
 *   1. BYTES — fetch the manifest, follow a variant, pull a segment. A URL in
 *      HTML is not a stream.
 *   2. AUDIO — does the manifest declare audio langs, and are they real
 *      renditions rather than labels?
 *   3. COVERAGE — is the URL embedded for other titles, or was one page a fluke?
 *
 * Writes research/vidly-stream-bytes.json. Registers nothing.
 */
import fs from 'node:fs/promises';

const OUT = 'research/vidly-stream-bytes.json';
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
    return { status: null, text: '', error: `${error?.name}: ${error?.message}`.slice(0, 100) };
  }
}

/** Media URLs embedded in a page, without any decryption. */
function embeddedMedia(html) {
  return [
    ...new Set([
      ...[...html.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd|mp4)[^\s"'<>\\]*/gi)].map((m) => m[0]),
    ]),
  ];
}

/**
 * Walk a master playlist to a real segment and count the bytes.
 *
 * This is the only step that constitutes proof. Everything upstream of it is a
 * claim: a URL in HTML, a manifest that parses, a label that says Hindi.
 */
async function provePlayable(manifestUrl, referer) {
  const result = { manifestUrl: manifestUrl.slice(0, 160), steps: [] };
  const headers = { Referer: referer, Origin: ORIGIN };

  const master = await get(manifestUrl, headers);
  result.steps.push({ step: 'master', status: master.status, bytes: master.text.length });
  if (master.status !== 200) return { ...result, playable: false, reason: `master ${master.status}` };

  const lines = master.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // A master names variants; a media playlist names segments directly.
  const childUris = lines.filter((l) => !l.startsWith('#') && /\.m3u8(?:[?#]|$)/i.test(l));
  const mediaUri = lines.find((l) => !l.startsWith('#'));
  result.isMaster = childUris.length > 0;

  // Audio renditions, if declared. This is where a real multi-audio stream shows.
  const audioLangs = [...new Set([...master.text.matchAll(/TYPE=AUDIO[^\n]*?LANGUAGE="([^"]+)"/gi)].map((m) => m[1]))];
  const audioNames = [...new Set([...master.text.matchAll(/#EXT-X-MEDIA:[^\n]*?NAME="([^"]+)"/gi)].map((m) => m[1]))];
  result.audioLangs = audioLangs;
  result.audioNames = audioNames.slice(0, 8);
  result.variants = childUris.length;

  let mediaUrl = manifestUrl;
  if (childUris.length > 0) {
    await sleep(500);
    mediaUrl = new URL(childUris[0], manifestUrl).href;
    const child = await get(mediaUrl, headers);
    result.steps.push({ step: 'variant', status: child.status, bytes: child.text.length });
    if (child.status !== 200) return { ...result, playable: false, reason: `variant ${child.status}` };
    const childLines = child.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const seg = childLines.find((l) => !l.startsWith('#'));
    if (!seg) return { ...result, playable: false, reason: 'variant has no segment line' };
    mediaUrl = new URL(seg, mediaUrl).href;
  } else if (mediaUri) {
    mediaUrl = new URL(mediaUri, manifestUrl).href;
  } else {
    return { ...result, playable: false, reason: 'no segment line at all' };
  }

  // The proof: a bounded byte range of real media.
  await sleep(500);
  let bytes = 0;
  let status = null;
  try {
    const segment = await fetch(mediaUrl, {
      headers: { 'User-Agent': UA, ...headers, Range: 'bytes=0-131071' },
      signal: AbortSignal.timeout(20_000),
    });
    status = segment.status;
    if (segment.ok || segment.status === 206) bytes = (await segment.arrayBuffer()).byteLength;
    await segment.body?.cancel().catch(() => {});
  } catch (error) {
    result.steps.push({ step: 'segment', error: String(error?.message ?? error).slice(0, 80) });
  }
  result.steps.push({ step: 'segment', status, bytes });
  result.playable = bytes > 0;
  result.reason = result.playable ? null : `segment ${status} with no bytes`;
  return result;
}

async function main() {
  const report = { measuredAt: new Date().toISOString(), titles: [], plays: [] };
  console.log('vidly stream bytes,', new Date().toISOString());

  // One movie, a second movie, and a TV episode — the media path may differ.
  const titles = [
    { key: 'fight-club', path: '/watch/movie/550', type: 'movie' },
    { key: 'inception', path: '/watch/movie/27205', type: 'movie' },
    { key: 'got-s1e1', path: '/watch/tv/1399/1/1', type: 'tv' },
    { key: 'naruto-s1e1', path: '/watch/tv/46260/1/1', type: 'tv' },
  ];

  for (const title of titles) {
    await sleep(2000);
    const page = await get(`${ORIGIN}${title.path}`, { Referer: `${ORIGIN}/` });
    const urls = page.status === 200 ? embeddedMedia(page.text) : [];
    const domains = [...new Set(urls.map((u) => new URL(u).hostname))];
    const row = {
      title: title.key,
      pageStatus: page.status,
      embedded: urls.map((u) => u.slice(0, 140)),
      hosts: domains,
    };
    console.log(
      `  ${title.key.padEnd(14)} page=${page.status} ${urls.length} embedded url(s)` +
        (domains.length ? ` on ${domains.join(',')}` : ''),
    );

    // Prove the first one, if there is one.
    if (urls.length > 0) {
      await sleep(1500);
      const proof = await provePlayable(urls[0], `${ORIGIN}${title.path}`);
      row.proof = proof;
      if (proof.playable) {
        report.plays.push({ title: title.key, host: new URL(urls[0]).hostname, bytes: proof.steps.at(-1).bytes });
      }
      console.log(
        `  ${''.padEnd(14)} playable=${proof.playable}` +
          (proof.playable
            ? ` ${proof.steps.at(-1).bytes}B variants=${proof.variants ?? '?'} audio=[${(proof.audioLangs ?? []).join(',')}]`
            : ` (${proof.reason})`),
      );
    }
    report.titles.push(row);
  }

  const anyPage = report.titles.some((t) => t.pageStatus === 200);
  if (!anyPage) {
    console.error('\nrefusing to write a report: no watch page rendered.');
    process.exit(2);
  }

  const hosts = [...new Set(report.titles.flatMap((t) => t.hosts ?? []))];
  report.summary = {
    pagesRendered: report.titles.filter((t) => t.pageStatus === 200).length,
    ofTitles: report.titles.length,
    embeddedTotal: report.titles.reduce((n, t) => n + (t.embedded?.length ?? 0), 0),
    mediaHosts: hosts,
    playable: report.plays,
    verdict:
      report.plays.length > 0
        ? `PLAYS — ${report.plays.length} of ${report.titles.length} titles served real bytes from ${hosts.join(', ')}`
        : report.titles.some((t) => (t.embedded?.length ?? 0) > 0)
          ? 'EMBEDDED BUT DEAD — URLs are in the page and none of them served a byte'
          : 'NO MEDIA IN PAGE — the stream needs the gated API after all',
  };

  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
  console.log(`verdict: ${report.summary.verdict}`);
  console.log(`hosts: ${hosts.join(', ') || 'none'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
