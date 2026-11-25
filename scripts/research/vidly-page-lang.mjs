#!/usr/bin/env node
/**
 * What language evidence does a vidly watch page actually carry?
 *
 * The board-live test requires every stream to tell the player what language it
 * is. The adapter's first version did not, and was caught. Before adding any
 * extraction, this measures which attributes exist in the markup - because
 * writing a regex for an attribute the page does not have would "fix" the test
 * by inventing a language, which is worse than failing it.
 */
import fs from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ORIGIN = 'https://vidly.pro';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const report = { measuredAt: new Date().toISOString(), titles: [] };
  const titles = [
    { key: 'inception', path: '/watch/movie/27205' },
    { key: 'govinda-naam-mere', path: '/watch/movie/1118026' },
    { key: 'got-s1e1', path: '/watch/tv/1399/1/1' },
  ];
  for (const t of titles) {
    await sleep(1500);
    let html = '';
    let status = null;
    try {
      const r = await fetch(`${ORIGIN}${t.path}`, {
        headers: { 'User-Agent': UA, Accept: 'text/html', Referer: `${ORIGIN}/` },
        signal: AbortSignal.timeout(20000),
      });
      status = r.status;
      html = await r.text();
    } catch (e) {
      status = `${e?.name}: ${e?.message}`.slice(0, 60);
    }
    const row = { title: t.key, status, bytes: html.length };
    // Every attribute whose NAME mentions language, with the value attached.
    row.langAttrs = [...html.matchAll(/([A-Za-z-]*(?:lang|audio|dub|track)[A-Za-z-]*)\s*[:=]\s*["']([^"']{1,40})["']/gi)]
      .map((m) => `${m[1]}=${m[2]}`)
      .slice(0, 25);
    // The html/body tag's own declared language.
    row.pageLang = html.match(/<html[^>]*\blang=["']([^"']+)["']/i)?.[1] ?? null;
    // Any JSON key whose name mentions language.
    row.jsonKeys = [...new Set([...html.matchAll(/"([A-Za-z_]*(?:lang|audio)[A-Za-z_]*)"\s*:/gi)].map((m) => m[1]))].slice(0, 20);
    // Slugs in the canonical path, which often name the audio track.
    row.canonical = html.match(/rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)?.[1] ?? null;
    // Does the markup name any of the Indian languages in plain text?
    row.namesLanguage = ['hindi', 'tamil', 'telugu', 'kannada', 'malayalam'].filter((n) =>
      new RegExp(n, 'i').test(html),
    );
    report.titles.push(row);
    console.log(`\n${t.key}  status=${status} ${html.length}B  pageLang=${row.pageLang}`);
    console.log(`  langAttrs  ${row.langAttrs.length}: ${row.langAttrs.join(' | ').slice(0, 400)}`);
    console.log(`  jsonKeys   ${row.jsonKeys.join(', ') || '-'}`);
    console.log(`  canonical  ${row.canonical ?? '-'}`);
    console.log(`  names      ${row.namesLanguage.join(',') || '-'}`);
  }
  await fs.writeFile('research/vidly-page-lang.json', JSON.stringify(report, null, 2) + '\n');
  console.log('\nwrote research/vidly-page-lang.json');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
