#!/usr/bin/env node
/**
 * Are TG FROST's five servers actually five different backends?
 *
 * The main player surfaced one backend (hakunaymatata via a cinemaos relay) for
 * all six titles. But the docs also expose fixed-server embeds:
 *
 *   /embed/movie/{server}/{tmdbId}/
 *   /embed/tv/{server}/{tmdbId}/{season}/{episode}/
 *
 * with server 1..5 = TG FROST, TG OUT, TG HUB, HDARK, TGVID. Those are separate
 * embed routes, so each may resolve through a different path. If they do, the
 * lane can multiply how many streams it finds per title. If they do not, adding
 * them only costs time — so this measures before anything is wired in.
 *
 * Runs on a GitHub runner via diagnose-compare.yml. Reports hosts and counts,
 * never stream URLs.
 */
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const BASE = 'https://tgfrost.lovable.app';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MEDIA_RE = /\.(?:m3u8|mpd)(?:[?#]|$)/i;
const SETTLE_MS = Number(process.env.TG_SETTLE_MS || 13_000);

const log = (t, v) => console.log(`[srv] ${t} :: ${v}`);

const TITLES = (process.env.TG_TITLES || 'tv:94664/1/1,movie:550').split(',').map((t) => {
  const [type, rest] = t.trim().split(':');
  return { type, rest };
});
const SERVERS = [1, 2, 3, 4, 5];

function embedUrl(type, rest, server) {
  return type === 'tv'
    ? `${BASE}/embed/tv/${server}/${rest}/`
    : `${BASE}/embed/movie/${server}/${rest}/`;
}

const browser = await chromium.launch({
  executablePath: await chromiumBinary.executablePath(),
  args: [...chromiumBinary.args, '--autoplay-policy=no-user-gesture-required'],
});

/** Capture manifests for one embed URL. Returns {hosts, bodies, ui}. */
async function capture(url) {
  const page = await browser.newPage({ userAgent: UA });
  const found = [];
  page.on('response', (res) => {
    const u = res.url();
    if (MEDIA_RE.test(u)) found.push({ url: u, type: (res.headers()['content-type'] || '').split(';')[0] });
  });
  let ui = '';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS);
    ui = await page.evaluate(() => document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 90) || '').catch(() => '');
  } catch (e) {
    ui = `ERR ${e.name}`;
  } finally {
    await page.close().catch(() => {});
  }
  const hosts = [...new Set(found.map((f) => { try { return new URL(f.url).hostname; } catch { return '?'; } }))];
  const types = [...new Set(found.map((f) => f.type).filter(Boolean))];
  return { hosts, types, n: found.length, ui };
}

try {
  for (const { type, rest } of TITLES) {
    log('title', `${type}/${rest}`);

    // Parallel: five sequential 13s page loads would take over a minute per
    // title and tell us nothing extra.
    const results = await Promise.all(
      [null, ...SERVERS].map(async (server) => {
        const url = server === null
          ? (type === 'tv' ? `${BASE}/embed/tv/${rest}` : `${BASE}/embed/movie/${rest}`)
          : embedUrl(type, rest, server);
        const label = server === null ? 'main' : `server${server}`;
        const r = await capture(url);
        return { label, ...r };
      }),
    );

    for (const r of results) {
      log(
        `  ${type}/${rest} ${r.label.padEnd(8)}`,
        `n=${r.n} types=${r.types.join(',') || '-'} hosts=${r.hosts.join(',') || '-'} ui="${r.ui.slice(0, 60)}"`,
      );
    }

    // The question that decides whether multi-target is worth it: does any
    // server reach a host the main player does not?
    const mainHosts = new Set(results[0].hosts);
    for (const r of results.slice(1)) {
      const extra = r.hosts.filter((h) => !mainHosts.has(h));
      if (extra.length) log(`  NEW via ${r.label}`, extra.join(', '));
    }
  }
} finally {
  await browser.close();
}

console.log('[srv:done]');
