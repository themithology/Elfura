// Real Chromium + dash.js regression for selectable DASH qualities.
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const dist = path.resolve('dist');
const media = path.resolve(process.env.FIXTURE_DIR);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const isMedia = pathname.startsWith('/fixture/');
    const root = isMedia ? media : dist;
    const relative = isMedia ? pathname.slice('/fixture/'.length) : pathname.replace(/^\//, '');
    const file = path.resolve(root, relative || 'embed.html');
    if (!file.startsWith(root + path.sep)) throw new Error('invalid path');
    const bytes = await readFile(file);
    const ext = path.extname(file);
    const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.mpd':'application/dash+xml', '.m4s':'video/iso.segment', '.mp4':'video/mp4' };
    res.writeHead(200, { 'Content-Type':types[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin':'*' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args:['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/embed.html?src=${encodeURIComponent(base+'/fixture/test.mpd')}&autoplay=1&muted=1`);
  await page.waitForFunction(() => window.__elfura?.player?.getQualityLevels().length >= 2, null, {timeout:20000});
  const levels = await page.evaluate(() => window.__elfura.player.getQualityLevels().map(l => l.height));
  assert(levels.includes(180) && levels.includes(360), `missing real DASH levels: ${levels}`);
  await page.getByRole('button', {name:'Quality', exact:true}).click();
  await page.locator('.elf-menu-item').filter({hasText:'180p'}).click();
  assert.equal(await page.evaluate(() => window.__elfura.player.getState().qualityMode), '180');
  assert.equal(await page.evaluate(() => window.__elfura.player.dash.getSettings().streaming.abr.autoSwitchBitrate.video), false);
  await page.waitForFunction(() => window.__elfura.player.video.videoHeight === 180, null, {timeout:20000});
  assert.deepEqual(errors, []);
  console.log(`::notice title=BrowserDash::Chromium listed ${levels.join('/')}p, selected 180p, disabled ABR and rendered 180p`);
} finally {
  await browser.close();
  server.close();
}
