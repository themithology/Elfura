#!/usr/bin/env node
/**
 * Watch what the TG FROST player actually loads.
 *
 * The static dissection was conclusive about *where* the work happens but not
 * *what* it produces: the client bundle is only the player UI, the streams are
 * resolved server-side (Supabase + createClientRpc). So the only honest way to
 * learn the real upstreams is to run the player in a real browser and record
 * the requests it makes and the response shapes it gets.
 *
 * Reports hosts, paths (query-less), content-types and statuses only — never a
 * full stream URL, never a token.
 *
 * Runs on a GitHub runner via diagnose-compare.yml:
 *   npm install --no-save --no-package-lock playwright-core @sparticuz/chromium
 *   node scripts/probe-tgfrost-browser.mjs
 */
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const BASE = 'https://tgfrost.lovable.app';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const log = (t, v) => console.log(`[tgb] ${t} :: ${v}`);

// Titles the operator named. Different backends answer different titles, which
// is the whole complaint, so the matrix is the point.
const TITLES = [
  ['movie', '550', 'Fight Club'],
  ['movie', '969681', 'docs example'],
  ['tv', '94605', 'Arcane'],
];
if (process.env.TG_TITLE) TITLES.unshift(['movie', process.env.TG_TITLE, 'override']);

const SKIP = /lovable\.app|lovable\.dev|\.r2\.dev|discord|googleapis|gstatic|fonts\.|w3\.org|schema\.org|jsdelivr|unpkg|cloudflareinsights|sentry|react\.dev|supabase\.co\/(?:rest|auth)\/v1\/|favicon|\.png|\.jpg|\.jpeg|\.svg|\.woff2?|\.css/i;
const MEDIA = /\.(m3u8|mpd|ts|m4s|mp4|key)(\?|$)/i;

const seen = new Map(); // key -> { host, path, status, type, n }
const interesting = [];

function note(kind, url, status, type) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (SKIP.test(url)) return;
  const isMedia = MEDIA.test(u.pathname);
  const key = `${kind}|${u.hostname}|${u.pathname}`;
  const row = seen.get(key) || { kind, host: u.hostname, path: u.pathname, status, type, n: 0, media: isMedia };
  row.n += 1;
  if (status) row.status = status;
  if (type) row.type = type;
  seen.set(key, row);
  if ((!isMedia && seen.size <= 400) || isMedia) interesting.push({ kind, host: u.hostname, path: u.pathname, status, type });
}

const browser = await chromium.launch({
  executablePath: await chromiumBinary.executablePath(),
  args: [...chromiumBinary.args, '--autoplay-policy=no-user-gesture-required'],
});

try {
  // ONE page for all titles. Opening a second page hung on the runner
  // (unsettled top-level await at newPage), and the listeners are global
  // anyway, so reusing the page loses nothing.
  const page = await browser.newPage({ userAgent: UA });
  for (const [type, id, label] of TITLES) {
    page.on('request', (r) => {
      try {
        note('req', r.url(), null, r.resourceType());
      } catch { /* ignore */ }
    });
    page.on('response', (r) => {
      try {
        note('res', r.url(), r.status(), (r.headers()['content-type'] || '').split(';')[0]);
      } catch { /* ignore */ }
    });

    const target = type === 'tv' ? `${BASE}/embed/tv/${id}/1/1` : `${BASE}/embed/movie/${id}`;
    log('open', `${label} ${type}/${id}`);
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (e) {
      log('goto', `ERR ${e.name}`);
    }
    // Give the resolver time to fan out across its five servers plus fallbacks.
    await page.waitForTimeout(18_000);
    // The player names the server it switched to in its status text.
    const statusText = await page
      .evaluate(() => document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 220) || '')
      .catch(() => '');
    log('ui', `${label} :: ${statusText}`);
    // Detach so one title's in-flight requests do not bleed into the next.
    page.removeAllListeners('request');
    page.removeAllListeners('response');
  }

  // ---- report -------------------------------------------------------------
  const rows = [...seen.values()];
  log('distinct endpoints', rows.length);
  const byHost = new Map();
  for (const r of rows) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host).push(r);
  }
  log('hosts', byHost.size);
  for (const [host, list] of [...byHost].sort((a, b) => b[1].length - a[1].length).slice(0, 30)) {
    const paths = [...new Set(list.map((r) => r.path))].slice(0, 5).join(' ');
    const statuses = [...new Set(list.map((r) => r.status).filter(Boolean))].join(',');
    const types = [...new Set(list.map((r) => r.type).filter(Boolean))].slice(0, 4).join(',');
    log('host', `${host} n=${list.length} status=${statuses || '-'} type=${types || '-'} ${paths}`);
  }
  const media = rows.filter((r) => r.media);
  log('media endpoints', media.length);
  for (const m of media.slice(0, 25)) {
    log('  media', `${m.host}${m.path} status=${m.status || '-'}`);
  }
} finally {
  await browser.close();
}

console.log('[tgb:done]');
