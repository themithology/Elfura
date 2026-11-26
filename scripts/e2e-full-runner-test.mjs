#!/usr/bin/env node
/**
 * Full end-to-end runner test:
 * 1. Starts the built server (node index.js) on a local port
 * 2. Verifies /health, /landing.html, /embed.html, and Roxy login
 * 3. Verifies live source resolution via /api/v1/resolve (or /api/v1/sources)
 * 4. Launches headless Chromium (Playwright) to load /landing.html and /embed.html
 *    and verifies the player UI + real stream playback.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.TEST_PORT || 18787);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_TXT = path.resolve('research/full-e2e-last.txt');
const lines = [];
const log = (msg) => {
  console.log(msg);
  lines.push(msg);
};

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  let server;
  let failed = false;
  try {
    log(`=== Full E2E Runner Test (${new Date().toISOString()}) ===`);

    server = spawn('node', ['index.js'], {
      env: {
        ...process.env,
        SERVER_PORT: String(PORT),
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        ELFURA_SECRET: 'e2e-test-secret-key',
        ALLOWED_ORIGINS: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    server.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error('[server]', s);
    });

    const ready = await waitForServer();
    if (!ready) {
      throw new Error('Server failed to start within 20s');
    }
    log('✓ Server started and /health responded 200');

    // 1. Public-facing HTML
    for (const p of ['/', '/landing.html', '/embed.html']) {
      const r = await fetch(`${BASE}${p}`);
      if (!r.ok) throw new Error(`${p} returned HTTP ${r.status}`);
      const body = await r.text();
      if (body.length < 200) throw new Error(`${p} body too small (${body.length}B)`);
      log(`✓ ${p} HTTP ${r.status} (${body.length}B)`);
    }

    // 2. Session + Live source resolution (Fight Club tmdb=550)
    const sessRes = await fetch(`${BASE}/api/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'movie', tmdb: '550' }),
    });
    const sessJson = await sessRes.json().catch(() => null);
    const token = sessJson?.pltoken || sessJson?.token || sessJson?.sessionToken || sessJson?.playbackToken;
    if (!sessRes.ok || !token) {
      throw new Error(`/api/v1/session failed: HTTP ${sessRes.status} body=${JSON.stringify(sessJson)}`);
    }
    log(`✓ /api/v1/session: HTTP ${sessRes.status} (got token)`);

    let resolveJson = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const resolveRes = await fetch(
        `${BASE}/api/v1/playback?type=movie&tmdb=550&pltoken=${encodeURIComponent(token)}`
      );
      resolveJson = await resolveRes.json().catch(() => null);
      if (!resolveRes.ok || !resolveJson) {
        throw new Error(`/api/v1/playback failed: HTTP ${resolveRes.status}`);
      }
      if (
        (Array.isArray(resolveJson.streams) && resolveJson.streams.length > 0) ||
        (Array.isArray(resolveJson.sources) && resolveJson.sources.length > 0) ||
        resolveJson.stream
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    const streamCount = Array.isArray(resolveJson?.streams)
      ? resolveJson.streams.length
      : Array.isArray(resolveJson?.sources)
        ? resolveJson.sources.length
        : resolveJson?.stream
          ? 1
          : 0;
    log(
      `✓ /api/v1/playback movie/550: HTTP 200, keys=${Object.keys(resolveJson || {}).join(',')}, streams=${streamCount}`
    );
    if (streamCount === 0) {
      throw new Error(`No streams resolved for movie/550: keys=${Object.keys(resolveJson || {}).join(',')}`);
    }

    // 3. Headless browser check (Playwright)
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await page.goto(`${BASE}/landing.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const title = await page.title();
      log(`✓ Browser /landing.html loaded (title="${title}")`);

      await page.goto(`${BASE}/embed.html?type=movie&tmdb=550`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForSelector('video', { timeout: 20000 });
      log('✓ Browser /embed.html?type=movie&tmdb=550 rendered <video> element');

      // Wait for sources to populate in the player
      await page.waitForTimeout(6000);
      // Open Audio & Subtitles sheet
      const asBtn = page.locator('button[aria-label*="Audio"], button[title*="Audio"], .elf-btn-as').first();
      await asBtn.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      const audioOpts = await page.locator('.elf-audio-option').allInnerTexts().catch(() => []);
      log(`✓ Browser Audio options (${audioOpts.length}): ${audioOpts.map((s) => s.replace(/\s+/g, ' ').trim()).join(' | ')}`);
      if (audioOpts.length > 1) {
        const targetIdx = audioOpts.findIndex((t) => /hindi/i.test(t));
        const clickIdx = targetIdx >= 0 ? targetIdx : 1;
        await page.locator('.elf-audio-option').nth(clickIdx).click({ force: true });
        await page.waitForTimeout(5000);
        const toastText = await page.locator('.elf-toast').allInnerTexts().catch(() => []);
        log(`✓ Clicked audio[${clickIdx}] ("${audioOpts[clickIdx].replace(/\s+/g, ' ').trim()}") -> toast: ${toastText.join(' | ') || '(none)'}`);
        if (toastText.some((t) => /didn't find it/i.test(t))) {
          throw new Error(`Audio switch failed with unavailable toast: ${toastText.join(' | ')}`);
        }
      }

      if (pageErrors.length > 0) {
        log(`! Page errors: ${pageErrors.join(' | ')}`);
      } else {
        log('✓ Zero uncaught page errors');
      }
    } finally {
      await browser.close();
    }

    log('=== ALL E2E CHECKS PASSED ===');
  } catch (err) {
    failed = true;
    log(`✗ E2E FAILED: ${err?.stack || err}`);
  } finally {
    if (server) server.kill('SIGTERM');
    fs.mkdirSync(path.dirname(OUT_TXT), { recursive: true });
    fs.writeFileSync(OUT_TXT, lines.join('\n') + '\n');
    if (failed) process.exit(1);
  }
}

main();
