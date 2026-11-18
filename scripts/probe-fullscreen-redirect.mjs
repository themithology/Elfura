#!/usr/bin/env node
/**
 * Why can't viewers who arrive through the domain redirect go fullscreen?
 *
 * Shape of the real situation, reproduced with two genuinely different origins:
 *   parent page on 127.0.0.1:portA  (stands in for the partner site)
 *     variant "direct"   -> iframe src = 127.0.0.2:portB/embed/movie/550
 *     variant "redirect" -> iframe src = 127.0.0.2:portB/go/embed/movie/550
 *                           which answers 301 to 127.0.0.2:portB/embed/movie/550
 *
 * The difference between the two is only that one is a cross-origin redirect
 * inside the frame. Fullscreen needs a real user gesture, so this clicks the
 * player's own fullscreen button with a trusted mouse event - evaluating
 * requestFullscreen() from script would be refused for the wrong reason and
 * would prove nothing.
 *
 * Also records what the server actually sees on those two requests, because the
 * fix may well be "do not redirect a framed navigation".
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const { createBackendServer } = await import('../dist/backend/index.js');

const secret = crypto.createHash('sha256').update('fullscreen-probe').digest();
const { server } = createBackendServer({
  host: '0.0.0.0',
  port: 0,
  isProd: false,
  secret,
  allowedOrigins: ['*'],
  requireToken: false,
  bindTokenIp: false,
  resolveTimeoutMs: 2500,
  rateLimitPerMin: 2000,
});
await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
const backendPort = server.address().port;

// A redirect host of its own. It is the thing under test, so it must not be
// mixed up with the backend: an absolute Location is built from the request's
// own Host header, which is what a real reverse proxy does.
const redirectSeen = [];
const redirectHost = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://placeholder');
  const target = url.pathname.replace(/^\/go/, '') + (url.search || '');
  redirectSeen.push({
    path: req.url,
    host: req.headers.host ?? null,
    dest: req.headers['sec-fetch-dest'] ?? null,
    site: req.headers['sec-fetch-site'] ?? null,
    referer: req.headers.referer ?? null,
  });
  res.writeHead(301, { Location: `http://127.0.0.2:${url.searchParams.get('p')}${target}` });
  res.end();
});

// What the embed request looks like to the server, per variant.
const seen = { direct: null, redirect: null };
server.on('request', (req) => {
  const url = req.url || '';
  if (!url.includes('/embed/movie/550')) return;
  const entry = {
    path: url,
    dest: req.headers['sec-fetch-dest'] ?? null,
    mode: req.headers['sec-fetch-mode'] ?? null,
    site: req.headers['sec-fetch-site'] ?? null,
    host: req.headers.host ?? null,
    referer: req.headers.referer ?? null,
  };
  if (url.includes('/go/')) seen.redirect ??= entry;
  else seen.direct ??= entry;
});

// The stand-in partner page: exactly what a site writes to embed us.
const parent = http.createServer((req, res) => {
  const variant = new URL(req.url || '/', 'http://x').searchParams.get('v') || 'direct';
  const src =
    variant === 'redirect'
      ? `http://127.0.0.3:${redirectPort}/go/embed/movie/550?p=${backendPort}`
      : `http://127.0.0.2:${backendPort}/embed/movie/550`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body style="margin:0;background:#111">
<iframe id="f" src="${src}" width="800" height="450"
        allow="autoplay; fullscreen; picture-in-picture" allowfullscreen
        style="border:0"></iframe>
</body></html>`);
});
await new Promise((resolve) => redirectHost.listen(0, '0.0.0.0', resolve));
const redirectPort = redirectHost.address().port;

await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve));
const parentPort = parent.address().port;

// @sparticuz/chromium ships --single-process, which does not survive two page
// contexts in one browser. Drop it and launch per variant.
const args = chromiumBinary.args.filter((a) => a !== '--single-process' && a !== '--no-zygote');
const executablePath = await chromiumBinary.executablePath();

const runVariant = async (variant) => {
  const browser = await chromium.launch({ args, executablePath });
  try {
    const page = await browser.newPage();
    const notes = [];
    page.on('console', (m) => {
      const t = m.text();
      if (/fullscreen|postMessage|Permissions|denied/i.test(t)) notes.push(t.slice(0, 220));
    });
    await page.goto(`http://127.0.0.1:${parentPort}/?v=${variant}`, { waitUntil: 'load' });

    const frame = page.frames().find((f) => f !== page.mainFrame());
    if (!frame) return { variant, error: 'no iframe' };
    await frame.waitForLoadState('load').catch(() => {});
    // Give the bundle a moment to build the shell.
    await frame.waitForSelector('.elf-shell', { timeout: 20_000 }).catch(() => {});

    const before = await frame.evaluate(() => ({
      url: location.href,
      hasShell: !!document.querySelector('.elf-shell'),
      fullscreenEnabled: document.fullscreenEnabled,
      fsButton: !!document.querySelector('.elf-fs-btn'),
      fsButtonHidden: document.querySelector('.elf-fs-btn')?.hidden ?? null,
    }));

    // 1. A control: a button of our own, clicked with a trusted event, calling
    //    requestFullscreen on the player's shell. This isolates "the browser
    //    forbids this frame from going fullscreen" from "the app's handler
    //    never got there". Headless cannot enter real fullscreen, so the signal
    //    is the error text: a permissions-policy refusal names the policy, a
    //    headless limitation only complains about the user gesture.
    await frame.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'probe-fs';
      b.textContent = 'probe';
      b.style.cssText = 'position:fixed;left:0;top:0;z-index:999999;width:40px;height:40px';
      b.onclick = async () => {
        const shell = document.querySelector('.elf-shell') || document.body;
        try {
          await shell.requestFullscreen();
          window.__probe = { ok: document.fullscreenElement === shell, error: null };
          if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
        } catch (err) {
          window.__probe = { ok: false, error: `${err.name}: ${err.message}` };
        }
      };
      document.body.appendChild(b);
    });
    await frame.click('#probe-fs', { force: true });
    const control = (await frame.evaluate(() => window.__probe)) ?? { ok: false, error: 'no result' };

    // 2. The player's own button, clicked for real.
    let appResult = { skipped: true };
    const fsButton = await frame.$('.elf-fs-btn');
    if (fsButton) {
      await frame.click('.elf-fs-btn', { force: true }).catch(() => {});
      await page.waitForTimeout(800);
      appResult = await frame.evaluate(() => {
        const shell = document.querySelector('.elf-shell');
        return {
          fullscreenElementIsShell: document.fullscreenElement === shell,
          fullscreenElement: document.fullscreenElement ? document.fullscreenElement.className : null,
          datasetFullscreen: shell?.dataset.fullscreen ?? null,
        };
      });
      await frame.evaluate(() => document.exitFullscreen?.().catch(() => {})).catch(() => {});
    }

    return { variant, before, control, appResult, notes: notes.slice(-5) };
  } finally {
    await browser.close().catch(() => {});
  }
};

const results = [];
for (const variant of ['direct', 'redirect']) {
  try {
    results.push(await runVariant(variant));
  } catch (err) {
    results.push({ variant, error: String(err).slice(0, 300) });
  }
}

for (const r of results) console.log('[fs]', JSON.stringify(r));
console.log('[fs] requests', JSON.stringify(seen));
console.log('[fs] redirectHop', JSON.stringify(redirectSeen));

server.close();
parent.close();
redirectHost.close();
