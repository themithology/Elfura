#!/usr/bin/env node
/**
 * Does vidlink's media host actually serve bytes, and is a 429 a block or a burst?
 *
 * ---------------------------------------------------------------
 * Every probe so far has been refused with HTTP 429 at the media host, so this
 * lane has never been credited a single byte. That refusal has three possible
 * causes and they lead to opposite decisions:
 *
 *   a) HOTLINK PROTECTION — the host wants a Referer/Origin it recognises. Fixable
 *      in the adapter's headers, and the lane is real.
 *   b) DATACENTER BLOCK — the host refuses cloud IPs outright (AniVortex answers
 *      426 the same way). Not fixable from here; the lane would be dead in
 *      production, which is exactly what a runner CANNOT see but a user can.
 *   c) A BURST LIMIT — four titles times three files within a second is a spike.
 *      Respected by waiting, and the lane is fine.
 *
 * So this probe fetches ONE file at a time, waits between attempts, honours
 * Retry-After, and records the response HEADERS alongside the status: a
 * `cf-ray` + `retry-after` says throttle, a bare 403/426 says block, and a 200
 * after a pause says burst.
 *
 * It also tries the same URL with and without the adapter's headers, because a
 * 429 that becomes a 200 when the Referer is present is (a) and is a bug in the
 * adapter, not a verdict on the source.
 *
 * Writes research/vidlink-bytes.json. Registers nothing.
 */
import fs from 'node:fs/promises';

const OUT = 'research/vidlink-bytes.json';
const TITLES = [
  { key: 'fight-club', type: 'movie', tmdbId: '550' },
  { key: 'inception', type: 'movie', tmdbId: '27205' },
  { key: 'got-s1e1', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
  { key: 'naruto-s1e1', type: 'tv', tmdbId: '46260', season: 1, episode: 1 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Header names worth keeping. The rest is noise and can carry a session. */
const INTERESTING = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'retry-after',
  'server',
  'cf-ray',
  'cf-cache-status',
  'x-cache',
  'date',
  'vary',
  'access-control-allow-origin',
];

function interestingHeaders(headers) {
  const out = {};
  for (const [name, value] of headers.entries()) {
    if (INTERESTING.includes(name.toLowerCase())) out[name.toLowerCase()] = String(value).slice(0, 120);
  }
  return out;
}

/**
 * Fetch one URL and report exactly what came back.
 *
 * Bounded: 128 KiB is enough to prove a media file is being served, and small
 * enough that a probe cannot pull a whole film by accident.
 */
async function attempt(url, headers, label) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { ...headers, Range: 'bytes=0-131071' },
      signal: AbortSignal.timeout(20_000),
    });
    const reported = interestingHeaders(response.headers);
    let bytes = 0;
    if (response.ok || response.status === 206) {
      try {
        const buffer = await response.arrayBuffer();
        bytes = buffer.byteLength;
      } catch {
        /* body refused after headers */
      }
    }
    await response.body?.cancel().catch(() => {});
    return {
      label,
      status: response.status,
      bytes,
      ms: Date.now() - started,
      headers: reported,
      retryAfterSec: Number(reported['retry-after']) || null,
    };
  } catch (error) {
    return {
      label,
      status: null,
      bytes: 0,
      ms: Date.now() - started,
      headers: {},
      error: error?.name ?? String(error),
    };
  }
}

async function main() {
  console.log('vidlink bytes probe,', new Date().toISOString());

  // The adapter is archived, and attic is not compiled by design - a file that
  // ships nothing should not sit in dist/ looking like a lane. Re-testing is a
  // deliberate act: move it back, run this.
  let createVidlinkAdapter;
  try {
    ({ createVidlinkAdapter } = await import('../../dist/backend/sources/vidlink.js'));
  } catch {
    console.error(
      'The vidlink adapter is archived at backend/attic/sources/source3-vidlink.ts.\n' +
        'To re-test the source:\n' +
        '  git mv backend/attic/sources/source3-vidlink.ts backend/src/sources/vidlink.ts\n' +
        '  npm run build:backend && node scripts/research/vidlink-bytes.mjs',
    );
    process.exit(2);
  }
  const adapter = createVidlinkAdapter();

  const rows = [];
  for (const title of TITLES) {
    // One title in flight at a time. The whole point is to not look like a burst.
    await sleep(6000);
    let result;
    try {
      result = await adapter.resolve({
        type: title.type,
        tmdbId: title.tmdbId,
        season: title.season,
        episode: title.episode,
        signal: AbortSignal.timeout(25_000),
      });
    } catch (error) {
      rows.push({ title: title.key, error: `resolve: ${error?.message ?? error}` });
      continue;
    }
    const first = result?.candidates?.[0];
    if (!first) {
      rows.push({ title: title.key, error: 'no candidate', candidates: 0 });
      continue;
    }

    const row = { title: title.key, candidates: result.candidates.length, url: first.url };

    // 1. As the adapter would send it.
    const withHeaders = await attempt(first.url, first.headers ?? {}, 'adapter-headers');
    row.withHeaders = withHeaders;

    // 2. Without any headers: if this succeeds where (1) failed, the adapter is
    //    sending something the host dislikes.
    if (!withHeaders.bytes) {
      await sleep(6000);
      row.bare = await attempt(first.url, { 'User-Agent': 'Mozilla/5.0' }, 'bare');
    }

    // 3. After the wait the host itself asked for. A 429 that clears here is a
    //    throttle and nothing more.
    if (!withHeaders.bytes && !row.bare?.bytes) {
      const wait = Math.min(withHeaders.retryAfterSec ?? 0, 30) || 15;
      console.log(`  ${title.key}: waiting ${wait}s before one retry, as asked`);
      await sleep(wait * 1000);
      row.retry = await attempt(first.url, first.headers ?? {}, 'after-wait');
    }

    rows.push(row);
    const summary = [row.withHeaders, row.bare, row.retry]
      .filter(Boolean)
      .map((a) => `${a.label}=${a.status ?? a.error}${a.bytes ? `/${a.bytes}B` : ''}`)
      .join(' ');
    console.log(`  ${title.key}: ${summary}`);
  }

  const anyBytes = rows.some((row) => [row.withHeaders, row.bare, row.retry].some((a) => a?.bytes > 0));
  const statuses = rows.flatMap((row) => [row.withHeaders, row.bare, row.retry].filter(Boolean).map((a) => a.status));
  const saw429 = statuses.includes(429);
  const saw403or426 = statuses.some((s) => s === 403 || s === 426);

  const verdict = anyBytes
    ? 'SERVES BYTES — the media host delivered real data; the lane is provable'
    : saw403or426
      ? 'BLOCKED — 403/426 with no bytes: the host refuses this client, not just this burst'
      : saw429
        ? 'THROTTLED THROUGHOUT — 429 on every attempt including a delayed retry; nothing credits this lane'
        : 'NO BYTES — the host answered but never with media';

  const report = {
    measuredAt: new Date().toISOString(),
    rows,
    verdict,
    // A producer that never serves bytes cannot pass the contract gate, whatever
    // its independence looks like.
    contractGate: anyBytes ? 'available' : 'cannot be registered — no measured bytes',
  };

  const measured = rows.some((row) => row.url);
  if (!measured) {
    console.error('\nrefusing to write a report: the adapter produced no URL at all.');
    process.exit(2);
  }

  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
  console.log(`verdict: ${verdict}`);
  console.log(`gate: ${report.contractGate}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
