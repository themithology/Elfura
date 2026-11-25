#!/usr/bin/env node
/**
 * Breaking Bad S1E1 — every nxsha row, every field, every fetch style.
 *
 * ---------------------------------------------------------------
 * This exists because of a claim that was not good enough. After probing TWO
 * titles (Fight Club, a Game of Thrones episode) it was concluded that "the rows
 * labelled Hindi are dead". Two titles is not a board, and the conclusion was
 * drawn with the same weakness that already produced two wrong answers on this
 * branch: a small sample, read through one method.
 *
 * So this asks the question the owner actually asked, on the title they named:
 *
 *   Breaking Bad, TMDB 1395, season 1, episode 1
 *
 * and it fetches every row from every allowlisted lane FOUR ways, because a
 * single fetch style cannot tell these apart:
 *
 *   immediate      — no sleep after the API call, so a short-lived signed token
 *                    is still valid. If this works and a delayed fetch does not,
 *                    the row is fine and the probing was the problem.
 *   delayed        — the same URL 8s later. A difference here means expiry.
 *   row-headers    — the headers the API itself ships with the row.
 *   browser-like   — Referer + Origin + Accept + Range, the way a player asks.
 *
 * Every URL is printed in full and written to JSON, so any stream this probe
 * calls dead can be opened by hand from a residential IP. That is the test that
 * settles it: a runner is a datacenter address, and a CDN that bot-blocks
 * datacenter IPs looks exactly like a dead lane from here.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not touch APPROVED_SOURCES, the adapter, or any lane's admission. A
 * measurement is not a verdict on the board, and no lane is being reduced on the
 * strength of this file.
 */
import fs from 'node:fs/promises';
import { call, scrapers } from './nxsha-client.mjs';

const OUT = 'research/nxsha-breaking-bad.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ORIGIN = 'https://nxsha.space';

/** Every lane the adapter is allowed to request. */
const LANES = ['nitro', 'castle', 'watchout', 'awsind', 'vixolity', 'purstream', 'ophim', 'zoko'];

const TITLE = { key: 'breaking-bad-s1e1', type: 'tv', tmdbId: '1395', season: 1, episode: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One fetch, recorded in full.
 *
 * `isManifest` matters more than the status code: a 200 that returns a login
 * page is not a stream, and a 403 that returns an M3U8 is a stream this probe
 * failed to authenticate rather than a dead row. Both have been seen here.
 */
async function probe(url, headers, extra = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...(headers ?? {}), ...extra },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    const text = await response.text();
    return {
      status: response.status,
      ms: Date.now() - started,
      contentType: response.headers.get('content-type'),
      bytes: text.length,
      isManifest: /^\s*#EXTM3U/i.test(text),
      isMarkup: /^\s*</.test(text),
      finalHost: (() => {
        try {
          return new URL(response.url).hostname;
        } catch {
          return null;
        }
      })(),
      first: text.slice(0, 60).replace(/\s+/g, ' '),
      audioLangs: [
        ...new Set(
          [...text.matchAll(/#EXT-X-MEDIA:[^\n]*\bLANGUAGE="([^"]+)"/gi)].map((m) => m[1].toLowerCase()),
        ),
      ],
      audioRenditions: (text.match(/^#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*/gim) ?? []).slice(0, 6),
      // Enough of a master to read, never a whole media playlist.
      body: text.length <= 1600 ? text : undefined,
    };
  } catch (error) {
    return {
      status: null,
      ms: Date.now() - started,
      error: `${error?.name}: ${error?.message}`.slice(0, 90),
      cause: error?.cause?.code ?? null,
    };
  }
}

/** Follow a master to a variant and pull real bytes, so "works" means bytes. */
async function proveBytes(manifestUrl, headers) {
  try {
    const master = await fetch(manifestUrl, {
      headers: { 'User-Agent': UA, ...(headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await master.text();
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const child = lines.find((l) => l && !l.startsWith('#') && /\.m3u8(\?|$)/i.test(l));
    if (!child) {
      const seg = lines.find((l) => l && !l.startsWith('#'));
      if (!seg) return { bytes: 0, reason: 'no child playlist and no segment line' };
      const url = new URL(seg, manifestUrl).href;
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, ...(headers ?? {}), Range: 'bytes=0-131071' },
        signal: AbortSignal.timeout(20_000),
      });
      const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
      return { bytes: buf.byteLength, status: r.status, url: url.slice(0, 120) };
    }
    const childUrl = new URL(child, manifestUrl).href;
    const variant = await fetch(childUrl, {
      headers: { 'User-Agent': UA, ...(headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const variantText = await variant.text();
    const seg = variantText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!seg) return { bytes: 0, reason: `variant ${variant.status} had no segment` };
    const segUrl = new URL(seg, childUrl).href;
    const r = await fetch(segUrl, {
      headers: { 'User-Agent': UA, ...(headers ?? {}), Range: 'bytes=0-131071' },
      signal: AbortSignal.timeout(20_000),
    });
    const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
    return { bytes: buf.byteLength, status: r.status, variantStatus: variant.status };
  } catch (error) {
    return { bytes: 0, reason: `${error?.name}: ${error?.message}`.slice(0, 80) };
  }
}

async function main() {
  const report = {
    measuredAt: new Date().toISOString(),
    title: TITLE,
    note: 'every URL is printed so any "dead" row can be opened by hand from a residential IP',
    rows: [],
    lanesUnavailable: [],
  };

  const listed = await scrapers({ type: TITLE.type, tmdbId: TITLE.tmdbId });
  if (listed.error) {
    console.error(`could not list scrapers: ${listed.error}`);
    process.exit(2);
  }
  const offered = LANES.filter((name) => listed.names.includes(name));
  console.log(`Breaking Bad S1E1 (tmdb ${TITLE.tmdbId}) — ${offered.length}/${LANES.length} lanes on offer`);
  console.log(`lanes: ${offered.join(', ')}`);

  for (const lane of offered) {
    const answer = await call('sources', {
      tmdbId: TITLE.tmdbId,
      imdb_id: '',
      type: TITLE.type,
      season: TITLE.season,
      episode: TITLE.episode,
      ex_lang: true,
      provider: lane,
    });
    if (answer.error) {
      report.lanesUnavailable.push({ lane, error: answer.error });
      console.log(`\n[${lane}] API ERROR ${answer.error}`);
      continue;
    }
    const rows = Array.isArray(answer.payload?.sources) ? answer.payload.sources : [];
    console.log(`\n[${lane}] ${rows.length} row(s)`);

    for (const row of rows) {
      const entry = {
        lane,
        label: row.label ?? null,
        quality: row.quality ?? null,
        type: row.type ?? null,
        url: row.url,
        orgUriSame: row.org_uri === row.url,
        rowHeaders: row.headers ?? null,
        // every other field, so nothing is silently dropped
        otherFields: Object.fromEntries(
          Object.entries(row).filter(
            ([k]) => !['label', 'quality', 'type', 'url', 'org_uri', 'headers'].includes(k),
          ),
        ),
      };

      // 1. immediately — no sleep, so a short-lived token is still valid
      entry.immediate = await probe(row.url, null);
      if (entry.immediate.isManifest) {
        entry.immediate.bytesProof = await proveBytes(row.url, null);
      }

      // 2. delayed — same URL, 8s later; a difference means expiry
      await sleep(8000);
      entry.delayed = await probe(row.url, null);

      // 3. with the headers the API itself shipped with the row
      await sleep(1200);
      entry.rowHeadersFetch = await probe(row.url, row.headers);

      // 4. the way a player asks: site referer, origin, range
      await sleep(1200);
      entry.browserLike = await probe(row.url, row.headers, {
        Referer: `${ORIGIN}/`,
        Origin: ORIGIN,
        Accept: '*/*',
        Range: 'bytes=0-1023',
      });

      const anyManifest = [
        entry.immediate,
        entry.delayed,
        entry.rowHeadersFetch,
        entry.browserLike,
      ].some((p) => p.isManifest);
      const statuses = [
        entry.immediate.status,
        entry.delayed.status,
        entry.rowHeadersFetch.status,
        entry.browserLike.status,
      ];
      entry.verdict = anyManifest
        ? 'SERVES A MANIFEST'
        : statuses.every((s) => s === 403)
          ? 'GATED 403 everywhere'
          : statuses.every((s) => s === 404)
            ? 'DEAD 404 everywhere'
            : statuses.every((s) => s === null)
              ? 'UNREACHABLE from the runner'
              : `MIXED ${JSON.stringify(statuses)}`;

      report.rows.push(entry);
      const langs = entry.immediate.audioLangs?.length
        ? entry.immediate.audioLangs.join('+')
        : '(none declared)';
      console.log(
        `  label=${String(entry.label ?? '').slice(0, 34).padEnd(34)} ` +
          `${String(entry.verdict).padEnd(24)} ` +
          `imm=${entry.immediate.status ?? 'ERR'} del=${entry.delayed.status ?? 'ERR'} ` +
          `audio=${langs}`,
      );
      console.log(`    url: ${row.url}`);
      if (entry.immediate.bytesProof) {
        console.log(`    bytes: ${entry.immediate.bytesProof.bytes} (${entry.immediate.bytesProof.reason ?? 'ok'})`);
      }
    }
    await sleep(2500);
  }

  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);

  // The summary that decides the question: which rows claim a language and how
  // they actually behave. Nothing here is a board change.
  const claimsLanguage = (label) => /\b(hindi|tamil|telugu|kannada|malayalam|english|multi)\b/i.test(label ?? '');
  console.log('\n──────── rows that NAME a language ────────');
  const named = report.rows.filter((r) => claimsLanguage(r.label));
  if (named.length === 0) console.log('  none: no row for this title names a language in its label');
  for (const r of named) {
    console.log(`  [${r.lane}] label=${JSON.stringify(r.label)}`);
    console.log(`    verdict: ${r.verdict}`);
    console.log(`    manifest audio: ${r.immediate.audioLangs?.join(',') || 'none'}`);
    console.log(`    url: ${r.url}`);
  }

  console.log('\n──────── rows that name NO language ────────');
  for (const r of report.rows.filter((x) => !claimsLanguage(x.label))) {
    console.log(`  [${r.lane}] label=${JSON.stringify(r.label)} — ${r.verdict}`);
  }

  console.log(`\nwrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
