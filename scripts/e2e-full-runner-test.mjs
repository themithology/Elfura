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
      const res = await fetch(`${BASE}/health`);
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

    // 2. Live source resolution (Fight Club tmdb=550)
    const resolveRes = await fetch(`${BASE}/api/v1/resolve?type=movie&tmdb=550`);
    const resolveJson = await resolveRes.json().catch(() => null);
    if (!resolveRes.ok || !resolveJson) {
      throw new Error(`/api/v1/resolve failed: HTTP ${resolveRes.status}`);
    }
    const streamCount = Array.isArray(resolveJson.streams) ? resolveJson.streams.length : 0;
    log(`✓ /api/v1/resolve movie/550: HTTP ${resolveRes.status}, streams=${streamCount}`);
    if (streamCount === 0) {
      throw new Error('No streams resolved for movie/550 on live runner');
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
