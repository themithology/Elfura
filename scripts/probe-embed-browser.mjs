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
const parent = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body style="margin:0;background:#111">
<h1 style="color:#0f0;font:14px monospace">third-party site</h1>
<iframe id="f" src="${ELFURA}/embed/tv/94605/1/1"
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
  requests.push({ path: u.pathname, status: res.status(), host: u.host });
});
page.on('console', (m) => {
  if (m.type() === 'error') log('console error', m.text().slice(0, 160));
});
page.on('pageerror', (e) => log('page error', String(e).slice(0, 160)));

await page.goto(PARENT, { waitUntil: 'domcontentloaded' });
log('loaded parent', 'waiting for the embed to resolve');
await page.waitForTimeout(30_000);

// What did the player end up showing?
const state = await page.evaluate(() => {
  const f = document.getElementById('f');
  let inner = null;
  try {
    const d = f.contentDocument || f.contentWindow.document;
    const shell = d.querySelector('.elf-shell') || d.body;
    inner = {
      unavailable: d.querySelector('[data-unavailable="true"]') ? true : false,
      title: (d.querySelector('.elf-unavailable-title') || {}).textContent || '',
      message: (d.querySelector('.elf-unavailable-message') || {}).textContent || '',
      videoSrc: d.querySelector('video')?.currentSrc ? 'set' : 'none',
      text: (shell?.innerText || '').slice(0, 200),
    };
  } catch (e) {
    inner = { crossOriginBlocked: true, error: String(e).slice(0, 80) };
  }
  return inner;
});
log('iframe state', JSON.stringify(state));

// The network, in order, for the endpoints that matter.
const interesting = requests.filter((r) =>
  ['/api/v1/playback', '/api/v1/session', '/api/v1/health', '/api/v1/stream'].includes(r.path) ||
  r.path.startsWith('/embed'),
);
for (const r of interesting) log('request', `${r.status} ${r.path}`);
if (failures.length) for (const f of failures.slice(0, 8)) log('FAILED', `${f.err} ${new URL(f.url).pathname}`);

await browser.close();
elfura.close();
parent.close();
console.log('[emb:done]');
