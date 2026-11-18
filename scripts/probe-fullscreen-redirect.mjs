#!/usr/bin/env node
/**
 * Why can't viewers who arrive through the domain redirect go fullscreen?
 *
 * The redirect answers 301 to a different host. Inside an iframe that is a
 * cross-origin navigation the parent page did not initiate, so the frame's
 * permissions can be different from a direct load - and requestFullscreen is
 * gated on exactly those permissions.
 *
 * This builds the real situation instead of reasoning about it:
 *   parent page on 127.0.0.1:portA
 *     - iframe src points at 127.0.0.2:portB/embed/movie/550  (direct)
 *     - iframe src points at 127.0.0.2:portB/go/embed/movie/550 (redirects)
 * 127.0.0.1 and 127.0.0.2 are genuinely different origins, so this is the same
 * cross-origin shape as a real partner site.
 *
 * For each variant it records what the browser says when the player's own
 * fullscreen path runs, plus what it does when the same element asks directly.
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

// Parent page. The iframe markup is what a partner site writes.
const parent = http.createServer((req, res) => {
  const variant = new URL(req.url || '/', 'http://x').searchParams.get('v') || 'direct';
  const src =
    variant === 'redirect'
      ? `http://127.0.0.2:${backendPort}/go/embed/movie/550`
      : `http://127.0.0.2:${backendPort}/embed/movie/550`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body style="margin:0">
<iframe id="f" src="${src}" width="800" height="450" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen
        style="border:0"></iframe>
</body></html>`);
});
await new Promise((resolve) => parent.listen(0, '127.0.0.1', resolve));
const parentPort = parent.address().port;

const browser = await chromium.launch({
  args: chromiumBinary.args,
  executablePath: await chromiumBinary.executablePath(),
});

const runVariant = async (variant) => {
  const page = await browser.newPage();
  const notes = [];
  page.on('console', (m) => notes.push(`${m.type()}: ${m.text()}`.slice(0, 200)));
  await page.goto(`http://127.0.0.1:${parentPort}/?v=${variant}`, { waitUntil: 'load' });

  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) return { variant, error: 'no iframe' };
  await frame.waitForLoadState('load').catch(() => {});

  // What the frame document actually is, after any redirect.
  const landed = frame.url();

  const result = await frame.evaluate(async () => {
    const shell = document.querySelector('.elf-shell');
    const video = document.querySelector('video');
    const out = {
      landedFromFrame: location.href,
      hasShell: !!shell,
      fullscreenElementBefore: String(document.fullscreenElement),
      // The player's own gate for showing the button at all.
      shellHasRequest: typeof (shell || {}).requestFullscreen === 'function',
      // Does the browser think it may go fullscreen at all?
      fullscreenEnabled: document.fullscreenEnabled,
      // The element the player would actually fullscreen.
      target: shell ? 'elf-shell' : 'none',
    };
    const attempt = async (el, label) => {
      if (!el || typeof el.requestFullscreen !== 'function') return { label, skipped: true };
      try {
        await el.requestFullscreen();
        const ok = document.fullscreenElement === el;
        if (ok) await document.exitFullscreen().catch(() => {});
        return { label, ok, error: null };
      } catch (err) {
        return { label, ok: false, error: `${err.name}: ${err.message}` };
      }
    };
    out.attemptShell = await attempt(shell, 'elf-shell');
    out.attemptVideo = await attempt(video, 'video');
    // Does the app's own fullscreen() do anything different?
    const btn = document.querySelector('.elf-fs-btn');
    out.fsButtonPresent = !!btn;
    out.fsButtonHidden = btn ? btn.hidden : null;
    return out;
  });

  await page.close();
  return { variant, landed, ...result, notes: notes.slice(-6) };
};

const direct = await runVariant('direct');
const redirect = await runVariant('redirect');

console.log('[fs] direct  :', JSON.stringify(direct, null, 2));
console.log('[fs] redirect:', JSON.stringify(redirect, null, 2));

await browser.close();
server.close();
parent.close();
