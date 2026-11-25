#!/usr/bin/env node
/**
 * WHICH header unblocks castle? One at a time, not four at once.
 *
 * ---------------------------------------------------------------
 * The Breaking Bad probe found castle answering 403 to a bare fetch and 200 to a
 * fetch carrying Referer + Origin + Accept + Range. That is a real lead and it is
 * useless as evidence, because four things changed at once. "Add some headers and
 * it works" is how a lane ends up in production returning 403 for the player but
 * 200 in a test.
 *
 * So this holds everything constant and adds ONE header per attempt, using the
 * exact URL that answered 200, then re-verifies that the winning combination
 * still fetches a child playlist and a real segment.
 *
 * If it turns out to be Referer, the adapter needs that header on the candidate.
 * If it is Accept, the adapter is fine and my probe was the problem. Those are
 * opposite fixes, which is exactly why the confound has to be resolved before
 * anything is changed.
 */
import fs from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ORIGIN = 'https://nxsha.space';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, headers) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    const text = await response.text();
    return {
      status: response.status,
      ms: Date.now() - started,
      isManifest: /^\s*#EXTM3U/i.test(text),
      bytes: text.length,
      first: text.slice(0, 70).replace(/\s+/g, ' '),
    };
  } catch (error) {
    return { status: null, error: `${error?.name}: ${error?.message}`.slice(0, 70) };
  }
}

async function main() {
  const source = JSON.parse(await fs.readFile('research/nxsha-breaking-bad.json', 'utf8'));
  // The exact URL that answered 200 to the four-header fetch.
  const castle = source.rows.find((r) => r.lane === 'castle' && r.browserLike?.status === 200);
  if (!castle) {
    console.error('no castle row answered 200 in the Breaking Bad probe — nothing to isolate');
    process.exit(2);
  }
  const url = castle.url;
  const rowHeaders = castle.rowHeaders ?? {};

  const attempts = [
    ['bare (User-Agent only)', {}],
    ['+ Referer', { Referer: `${ORIGIN}/` }],
    ['+ Origin', { Origin: ORIGIN }],
    ['+ Accept: */*', { Accept: '*/*' }],
    ['+ Range', { Range: 'bytes=0-1023' }],
    ['+ Referer + Origin', { Referer: `${ORIGIN}/`, Origin: ORIGIN }],
    ['+ row headers only', rowHeaders],
    ['+ browser set, NO Range', { Referer: `${ORIGIN}/`, Origin: ORIGIN, Accept: '*/*' }],
    ['+ full browser set (4)', { Referer: `${ORIGIN}/`, Origin: ORIGIN, Accept: '*/*', Range: 'bytes=0-1023' }],
  ];

  const results = [];
  console.log('isolating the 403 -> 200 change, one header at a time\n');
  for (const [name, headers] of attempts) {
    await sleep(1500);
    const r = await get(url, headers);
    results.push({ name, headers, ...r });
    console.log(
      `  ${name.padEnd(26)} ${String(r.status ?? r.error).padEnd(6)} ${r.isManifest ? 'M3U8' : ''} ${r.bytes ?? ''}B`,
    );
  }

  // Prove the winner end to end, not just that a master came back.
  const winner = results.filter((r) => r.isManifest).sort((a, b) => a.name.length - b.name.length)[0];
  let proof = null;
  if (winner) {
    console.log(`\nshortest winning set: ${winner.name}`);
    await sleep(1500);
    const master = await fetch(url, {
      headers: { 'User-Agent': UA, ...winner.headers },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await master.text();
    const child = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (child) {
      const childUrl = new URL(child, url).href;
      await sleep(1200);
      const variant = await fetch(childUrl, {
        headers: { 'User-Agent': UA, ...winner.headers },
        signal: AbortSignal.timeout(20_000),
      });
      const vText = await variant.text();
      const seg = vText.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (seg) {
        const segUrl = new URL(seg, childUrl).href;
        await sleep(1200);
        const r = await fetch(segUrl, {
          headers: { 'User-Agent': UA, ...winner.headers, Range: 'bytes=0-131071' },
          signal: AbortSignal.timeout(20_000),
        });
        const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
        proof = { variantStatus: variant.status, segmentStatus: r.status, bytes: buf.byteLength };
        console.log(`  variant ${variant.status}, segment ${r.status}, ${buf.byteLength} bytes`);
      }
    }
  }

  await fs.writeFile(
    'research/nxsha-castle-headers.json',
    JSON.stringify({ measuredAt: new Date().toISOString(), url, attempts: results, proof }, null, 2) + '\n',
  );
  console.log('\nwrote research/nxsha-castle-headers.json');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
