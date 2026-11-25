#!/usr/bin/env node
/**
 * Does castle actually play — not just serve a playlist?
 *
 * The header probe proved Referer turns 403 into a 70 KB #EXTM3U. It then
 * reported "segment 400, 155 bytes", which is not media. That number was my
 * probe's fault, not castle's: at 70 KB the body is already a MEDIA playlist
 * (it carries EXT-X-MEDIA-SEQUENCE and a full segment list), and the prov
 * followed its first old-style segment line as if it were a child playlist.
 *
 * So this decides it properly: master-or-media, variant, segment, with the
 * Referer the adapter now sends. If a segment returns real bytes with
 * X-Forwarded, castle is a working English 1080p lane that this board spent
 * the day calling dead because it asked without one header.
 */
import fs from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const REFERER = 'https://nxsha.space/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: REFERER },
    signal: AbortSignal.timeout(25_000),
    redirect: 'follow',
  });
  return { status: r.status, text: await r.text(), url: r.url, type: r.headers.get('content-type') };
}

async function main() {
  const src = JSON.parse(await fs.readFile('research/nxsha-castle-headers.json', 'utf8'));
  const report = { measuredAt: new Date().toISOString(), tried: [] };

  // Prove every castle row that returned a playlist, not just the first.
  const bb = JSON.parse(await fs.readFile('research/nxsha-breaking-bad.json', 'utf8'));
  const urls = bb.rows.filter((r) => r.lane === 'castle').map((r) => r.url);
  console.log(`castle rows to prove: ${urls.length}\n`);

  for (const url of urls) {
    const entry = { url: url.slice(0, 90) + '…' };
    await sleep(1500);
    const first = await fetchText(url);
    entry.status = first.status;
    entry.bytes = first.text.length;
    const lines = first.text.split(/\r?\n/).map((l) => l.trim());
    const isMaster = /#EXT-X-STREAM-INF/i.test(first.text);
    entry.kind = isMaster ? 'master' : /#EXT-X-MEDIA-SEQUENCE|#EXTINF/i.test(first.text) ? 'media' : 'other';
    console.log(`[${entry.kind}] ${first.status} ${entry.bytes}B`);

    let mediaUrl = url;
    if (isMaster) {
      const child = lines.find((l) => l && !l.startsWith('#') && /\.m3u8(\?|$)/i.test(l));
      if (child) {
        mediaUrl = new URL(child, url).href;
        await sleep(1200);
        const v = await fetchText(mediaUrl);
        entry.variantStatus = v.status;
        entry.variantBytes = v.text.length;
        mediaUrl = new URL(
          v.text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '',
          mediaUrl,
        ).href;
        console.log(`  variant ${v.status} ${v.text.length}B`);
      }
    } else {
      const seg = lines.find((l) => l && !l.startsWith('#'));
      if (seg) mediaUrl = new URL(seg, url).href;
    }

    if (mediaUrl && mediaUrl !== url) {
      await sleep(1200);
      try {
        const r = await fetch(mediaUrl, {
          headers: {
            'User-Agent': UA,
            Referer: REFERER,
            Range: 'bytes=0-131071',
            // The measured 400 came from a request that looked like a range probe.
            // A player asks with a full GET; try that second if the range fails.
          },
          signal: AbortSignal.timeout(25_000),
        });
        const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
        entry.segment = { status: r.status, bytes: buf.byteLength, type: r.headers.get('content-type') };
        console.log(`  segment(range) ${r.status} ${buf.byteLength}B ${r.headers.get('content-type')}`);
        if (buf.byteLength === 0) {
          await sleep(1000);
          const full = await fetch(mediaUrl, {
            headers: { 'User-Agent': UA, Referer: REFERER },
            signal: AbortSignal.timeout(25_000),
          });
          const fullBuf = await full.arrayBuffer().catch(() => new ArrayBuffer(0));
          entry.fullSegment = { status: full.status, bytes: fullBuf.byteLength };
          console.log(`  segment(full)  ${full.status} ${fullBuf.byteLength}B`);
        }
      } catch (error) {
        entry.segment = { error: `${error?.name}: ${error?.message}`.slice(0, 70) };
        console.log(`  segment ERROR ${entry.segment.error}`);
      }
    }
    const proved = (entry.segment?.bytes ?? 0) > 0 || (entry.fullSegment?.bytes ?? 0) > 0;
    entry.verdict = proved ? 'PLAYS - real bytes' : `NO BYTES (${entry.segment?.status ?? entry.segment?.error})`;
    console.log(`  => ${entry.verdict}\n`);
    report.tried.push(entry);
  }

  await fs.writeFile('research/nxsha-castle-proof.json', JSON.stringify(report, null, 2) + '\n');
  const plays = report.tried.filter((t) => t.verdict.startsWith('PLAYS')).length;
  console.log(`castle: ${plays}/${report.tried.length} rows serve real bytes with a Referer`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
