// Real Chromium + dash.js regression for selectable DASH qualities.
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const dist = path.resolve('dist');
const media = path.resolve(process.env.FIXTURE_DIR);
const requested = [];
const server = http.createServer(async (req, res) => {
  requested.push(new URL(req.url, 'http://localhost').pathname);
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const isMedia = pathname.startsWith('/fixture/');
    const root = isMedia ? media : dist;
    const relative = isMedia ? pathname.slice('/fixture/'.length) : pathname.replace(/^\//, '');
    const file = path.resolve(root, relative || 'embed.html');
    if (!file.startsWith(root + path.sep)) throw new Error('invalid path');
    const bytes = await readFile(file);
    const ext = path.extname(file);
    const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.mpd':'application/dash+xml', '.m4s':'video/iso.segment', '.mp4':'video/mp4', '.m3u8':'application/vnd.apple.mpegurl', '.ts':'video/mp2t' };
    res.writeHead(200, { 'Content-Type':types[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin':'*' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: await chromiumBinary.executablePath(), args:[...chromiumBinary.args, '--autoplay-policy=no-user-gesture-required'] });
let page;
const errors = [];
try {
  page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/embed.html?src=${encodeURIComponent(base+'/fixture/test.mpd')}&autoplay=1&muted=1`);
  await page.waitForFunction(() => window.__elfura?.player?.getQualityLevels().length >= 2, null, {timeout:20000});
  console.log('::notice title=BrowserDashProgress::quality levels discovered');
  const levels = await page.evaluate(() => window.__elfura.player.getQualityLevels().map(l => l.height));
  assert(levels.includes(180) && levels.includes(360), `missing real DASH levels: ${levels}`);
  await page.getByRole('button', {name:'Quality', exact:true}).click();
  await page.locator('.elf-menu-item').filter({hasText:'180p'}).click();
  console.log('::notice title=BrowserDashProgress::clicked 180p');
  assert.equal(await page.evaluate(() => window.__elfura.player.getState().qualityMode), '180');
  assert.equal(await page.evaluate(() => window.__elfura.player.dash.getSettings().streaming.abr.autoSwitchBitrate.video), false);
  await page.waitForFunction(() => window.__elfura.player.video.videoHeight === 180, null, {timeout:20000});
  assert.deepEqual(errors, []);
  console.log(`::notice title=BrowserDash::Chromium listed ${levels.join('/')}p, selected 180p, disabled ABR and rendered 180p`);
  // Synthetic tones represent two separate audio renditions. This verifies the
  // switching pipeline, not the spoken language of any real provider's dub.
  await page.goto(`${base}/embed.html?src=${encodeURIComponent(base+'/fixture/multi.m3u8')}&autoplay=1&muted=1`);
  await page.waitForFunction(() => window.__elfura?.player?.getAudioTracks().some(t => t.lang === 'hi'), null, {timeout:20000});
  await page.getByRole('button', {name:'Change audio and subtitles'}).click();
  await page.locator('.elf-audio-option').filter({hasText:'Hindi'}).click();
  await page.waitForFunction(() => {
    const p = window.__elfura?.player;
    return p?.getState().audioLang === 'hi' && p.hls?.audioTracks[p.hls.audioTrack]?.lang === 'hi';
  }, null, {timeout:10000});
  await page.waitForTimeout(1500);
  assert(requested.some(p => /\/hi\d+\.ts$/.test(p)), 'Hindi rendition media was not requested');
  console.log('::notice title=BrowserHls::Chromium selected the Hindi-tagged synthetic track and fetched its media segments');
} catch (error) {
  const state = await page?.evaluate(() => ({ ready: document.body.dataset.ready, engine: window.__elfura?.player?.engine, state: window.__elfura?.player?.getState(), levels: window.__elfura?.player?.getQualityLevels(), mediaError: document.querySelector('video')?.error?.code })).catch(() => null);
  const message = JSON.stringify({error: String(error).slice(0, 1000), errors, state});
  console.log(`::error title=BrowserDashFailure::${message.replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
  throw error;
} finally {
  await browser.close();
  server.close();
}
