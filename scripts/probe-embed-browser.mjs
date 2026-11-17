#!/usr/bin/env node
/**
 * Reproduce "works on the main site, 'couldn't reach sources' inside an embed"
 * in a real browser, with a real cross-origin iframe.
 *
 * The previous attempts tested the API with hand-written headers, which was the
 * wrong layer: from inside an embed the playback call is SAME-ORIGIN (the iframe
 * document is our own origin), so CORS and Referer never applied to it. Reason
 * about it however I liked, a synthetic fetch could not show the failure.
 *
 * So: serve a parent page from a genuinely different origin, iframe our embed
 * inside it, and watch the network. Every failed request and its status is
 * printed, plus any console error. Counts and paths only.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import { createBackendServer } from '../dist/backend/index.js';

const log = (t, v) => console.log(`[emb] ${t} :: ${v}`);

// --- our backend -----------------------------------------------------------
const { server: elfura } = createBackendServer({
  host: '127.0.0.1',
  port: 0,
  isProd: true,
  secret: crypto.createHash('sha256').update('embed-browser-audit').digest(),
  // Deliberately restrictive: this is what every VPS install ends up with, and
  // it is the configuration the user reports. It must not matter any more.
  allowedOrigins: ['https://elfura.example'],
  requireToken: true,
  bindTokenIp: false,
  resolveTimeoutMs: 25_000,
  rateLimitPerMin: 1000,
});
await new Promise((r) => elfura.listen(0, '127.0.0.1', r));
const elfuraPort = elfura.address().port;
const ELFURA = `http://127.0.0.1:${elfuraPort}`;
log('backend', ELFURA);

// --- a parent site on a DIFFERENT origin -----------------------------------
// Each of these is a way a real partner site embeds us. The query form is what
// the deployed site's own player page uses, so it has to be exercised too.
const VARIANTS = {
  path: `${ELFURA}/embed/tv/94605/1/1`,
  query: `${ELFURA}/embed?type=tv&id=94605&s=1&e=1`,
  queryPlayer: `${ELFURA}/player?type=tv&id=94605&s=1&e=1`,
  moviePath: `${ELFURA}/embed/movie/1368337`,
};
let VARIANT = process.env.EMB_VARIANT || 'path';

const parent = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body style="margin:0;background:#111">
<h1 style="color:#0f0;font:14px monospace">third-party site / ${VARIANT}</h1>
<iframe id="f" src="${VARIANTS[VARIANT]}"
        allow="autoplay; fullscreen; encrypted-media"
        allowfullscreen
        style="width:900px;height:520px;border:0"></iframe>
</body></html>`);
});
await new Promise((r) => parent.listen(0, '127.0.0.1', r));
const PARENT = `http://127.0.0.1:${parent.address().port}`;
log('parent site', PARENT);

// --- browser ---------------------------------------------------------------
const browser = await chromium.launch({
  args: [...chromiumBinary.args, '--autoplay-policy=no-user-gesture-required'],
  executablePath: await chromiumBinary.executablePath(),
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
});

const requests = [];
const failures = [];
page.on('requestfailed', (r) => failures.push({ url: r.url(), err: r.failure()?.errorText }));
page.on('response', async (res) => {
  const u = new URL(res.url());
  requests.push({ path: u.pathname, status: res.status(), host: u.host, full: res.url() });
});
page.on('console', (m) => {
  if (m.type() === 'error') log('console error', m.text().slice(0, 160));
});
page.on('pageerror', (e) => log('page error', String(e).slice(0, 160)));

for (const variant of Object.keys(VARIANTS)) {
  VARIANT = variant;
  requests.length = 0;
  failures.length = 0;
  log(`=== variant ${variant}`, VARIANTS[variant].replace(ELFURA, ''));
  await page.goto(PARENT, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(28_000);

  const state = await page.evaluate(() => {
    const f = document.getElementById('f');
    try {
      const d = f.contentDocument || f.contentWindow.document;
      const t = (sel) => (d.querySelector(sel) || {}).textContent || '';
      return {
        unavailableShown: !!d.querySelector('[data-unavailable="true"]'),
        title: t('.elf-unavailable-title'),
        message: t('.elf-unavailable-message'),
        videoSet: !!d.querySelector('video')?.currentSrc,
      };
    } catch (e) {
      return { crossOriginBlocked: true, error: String(e).slice(0, 80) };
    }
  });
  log(`  ${variant} state`, JSON.stringify(state));

  const bad = requests.filter((r) => !['/api/v1/playback', '/api/v1/stream'].includes(r.path));
  const non200 = bad.filter((r) => r.status >= 400);
  if (non200.length) {
    const tally = new Map();
    for (const r of non200) {
      const key = `${r.status} ${r.host} ${r.path}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    for (const [k, n] of tally) log(`  ${variant} non-200`, `${n}x ${k}`);
  }
  const playbacks = requests.filter((r) => r.path === '/api/v1/playback');
  log(
    `  ${variant} playback`,
    `${playbacks.length} calls, statuses ${[...new Set(playbacks.map((r) => r.status))].join(',') || 'none'}`,
  );
}

await browser.close();
elfura.close();
parent.close();
console.log('[emb:done]');
