#!/usr/bin/env node
/**
 * Does the Hindi on this board actually play Hindi?
 *
 * ---------------------------------------------------------------
 * The board can list a dozen streams for a Hindi request. What it has never
 * checked is whether any of them carries a Hindi audio rendition, or whether the
 * word "Hindi" appears only in a provider's label.
 *
 * That distinction is the whole product. A viewer asking for Hindi and getting an
 * English dub with a Hindi badge is worse than being told "not available", because
 * they have to discover it themselves.
 *
 * This takes every row the board has that names Hindi, fetches the manifest the
 * way the adapter would (per-host headers), and reports what the manifest ACTUALLY
 * declares:
 *
 *   VERIFIED     a TYPE=AUDIO rendition with LANGUAGE="hi" / "hin" / NAME="Hindi"
 *   NOT HINDI    audio renditions that do not include Hindi
 *   SINGLE-TRACK no audio renditions at all; one audio stream, language unknown
 *   NO BYTES     the manifest or the first segment did not come back
 *
 * Labels are recorded next to the verdict so a labelled-Hindi row that turns out
 * to be single-track is visible as exactly that.
 */
import fs from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const REFERER_HOSTS = /(?:^|\.)nxstreamhub\.workers\.dev$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headersFor(url) {
  const h = { 'User-Agent': UA };
  try {
    if (REFERER_HOSTS.test(new URL(url).hostname)) h.Referer = 'https://nxsha.space/';
  } catch {
    /* ignore */
  }
  return h;
}

const HINDI = /\b(hi|hin|hindi)\b/i;

async function get(url, extra = {}) {
  const r = await fetch(url, {
    headers: { ...headersFor(url), ...extra },
    signal: AbortSignal.timeout(25_000),
    redirect: 'follow',
  });
  return { status: r.status, text: await r.text(), type: r.headers.get('content-type') };
}

/** What audio renditions does this manifest declare? */
function audioOf(text) {
  const rows = (text.match(/^#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*/gim) ?? []).map((l) => l.trim());
  return rows.map((line) => ({
    language: line.match(/LANGUAGE="([^"]+)"/i)?.[1] ?? null,
    name: line.match(/NAME="([^"]+)"/i)?.[1] ?? null,
    default: /DEFAULT=YES/i.test(line),
  }));
}

async function classify(url) {
  const out = { url, verdict: null, renditions: [], kinds: {} };
  let manifest;
  try {
    manifest = await get(url);
  } catch (error) {
    out.verdict = 'NO BYTES';
    out.reason = `${error?.name}: ${error?.message}`.slice(0, 70);
    return out;
  }
  out.status = manifest.status;
  if (manifest.status !== 200 || !/^\s*#EXTM3U/i.test(manifest.text)) {
    out.verdict = 'NO BYTES';
    out.reason = `http=${manifest.status} first=${manifest.text.slice(0, 40).replace(/\s+/g, ' ')}`;
    return out;
  }

  out.renditions = audioOf(manifest.text);
  out.kinds = {
    isMaster: /#EXT-X-STREAM-INF/i.test(manifest.text),
    bytes: manifest.text.length,
  };

  // A master names renditions. A media playlist names none — it IS one track.
  if (out.renditions.length === 0) {
    out.verdict = out.kinds.isMaster ? 'SINGLE-TRACK (master, no audio group)' : 'SINGLE-TRACK';
  } else if (out.renditions.some((r) => HINDI.test(`${r.language ?? ''} ${r.name ?? ''}`))) {
    const hindi = out.renditions.find((r) => HINDI.test(`${r.language ?? ''} ${r.name ?? ''}`));
    out.verdict = 'VERIFIED HINDI';
    out.hindiRendition = hindi;
  } else {
    out.verdict = 'NOT HINDI';
  }

  // Whatever the verdict, prove bytes exist: follow to a variant/segment.
  try {
    const lines = manifest.text.split(/\r?\n/).map((l) => l.trim());
    const child = out.kinds.isMaster
      ? lines.find((l) => l && !l.startsWith('#') && /\.m3u8(\?|$)/i.test(l))
      : null;
    let segUrl = null;
    if (child) {
      const childUrl = new URL(child, url).href;
      await sleep(800);
      const v = await get(childUrl);
      const seg = v.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (seg) segUrl = new URL(seg, childUrl).href;
      out.variantStatus = v.status;
    } else {
      const seg = lines.find((l) => l && !l.startsWith('#'));
      if (seg) segUrl = new URL(seg, url).href;
    }
    if (segUrl) {
      await sleep(600);
      const seg = await fetch(segUrl, { headers: headersFor(segUrl), signal: AbortSignal.timeout(20_000) });
      const buf = await seg.arrayBuffer().catch(() => new ArrayBuffer(0));
      out.segment = { status: seg.status, bytes: buf.byteLength, type: seg.headers.get('content-type') };
    }
  } catch (error) {
    out.segment = { error: `${error?.name}: ${error?.message}`.slice(0, 60) };
  }
  return out;
}

async function main() {
  const survey = JSON.parse(await fs.readFile('research/nxsha-all-lanes.json', 'utf8'));
  const rows = [];
  for (const lane of survey.nxsha) {
    for (const hit of lane.hits) {
      for (const row of hit.rows) {
        if (HIin(row.label)) rows.push({ lane: lane.lane, title: hit.title, ...row });
      }
    }
  }
  console.log(`rows naming Hindi: ${rows.length}\n`);

  const report = { measuredAt: new Date().toISOString(), rows: [] };
  const tally = {};
  for (const row of rows) {
    await sleep(1200);
    const result = await classify(row.url);
    result.lane = row.lane;
    result.title = row.title;
    result.label = row.label;
    report.rows.push(result);
    tally[result.verdict] = (tally[result.verdict] ?? 0) + 1;
    const audio = result.renditions.map((r) => `${r.language ?? r.name}${r.default ? '*' : ''}`).join(',');
    console.log(
      `  ${row.lane.slice(0, 14).padEnd(14)} ${String(row.title).slice(0, 10).padEnd(10)} ` +
        `${String(result.verdict).padEnd(30)} ${audio || '—'}  ${result.segment?.bytes ?? 0}B`,
    );
  }

  console.log('\n──────── tally ────────');
  for (const [verdict, count] of Object.entries(tally)) console.log(`  ${verdict.padEnd(32)} ${count}`);

  await fs.writeFile('research/nxsha-hindi-verify.json', JSON.stringify(report, null, 2) + '\n');
  console.log('\nwrote research/nxsha-hindi-verify.json');
}

function HIin(label) {
  return /hindi/i.test(String(label ?? ''));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
