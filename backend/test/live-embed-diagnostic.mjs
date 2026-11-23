import { chromium } from 'playwright-core';
import chromiumPkg from '@sparticuz/chromium';

const url = 'https://embed.theogpiratebot.to/embed/movie/550';
const executablePath = await chromiumPkg.executablePath();
const browser = await chromium.launch({ executablePath, args: chromiumPkg.args, headless: true });
const page = await browser.newPage();

const events = [];
const log = line => { console.log(line); events.push(line); };
page.on('console', msg => {
  if (msg.type() === 'error' || /fatal|error|fail|503|403|404|hls|dash/i.test(msg.text())) {
    log(`[console.${msg.type()}] ${msg.text()}`);
  }
});
page.on('response', res => {
  const s = res.status();
  if (s >= 400 || res.url().includes('/api/v1/')) {
    log(`[http ${s}] ${res.url().slice(0, 140)}`);
  }
});
page.on('requestfailed', req => {
  log(`[req-failed] ${req.url().slice(0, 140)} :: ${req.failure()?.errorText}`);
});

log(`Navigating to ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(20000);
log(`Title=${await page.title()} BodyLen=${(await page.evaluate(() => document.body?.innerText || '')).length}`);
await browser.close();
console.log(`::notice::${events.slice(0, 25).join(' | ')}`);
