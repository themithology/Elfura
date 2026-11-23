import { chromium } from 'playwright-core';
import chromiumPkg from '@sparticuz/chromium';

const url = 'https://embed.theogpiratebot.to/embed/movie/550';
const executablePath = await chromiumPkg.executablePath();
const browser = await chromium.launch({ executablePath, args: chromiumPkg.args, headless: true });
const page = await browser.newPage();

page.on('console', msg => {
  if (msg.type() === 'error' || /fatal|error|fail|503|403|404|hls|dash/i.test(msg.text())) {
    console.log(`[console.${msg.type()}] ${msg.text()}`);
  }
});
page.on('response', res => {
  const s = res.status();
  if (s >= 400 || res.url().includes('/api/v1/')) {
    console.log(`[http ${s}] ${res.url()}`);
  }
});
page.on('requestfailed', req => {
  console.log(`[req-failed] ${req.url()} :: ${req.failure()?.errorText}`);
});

console.log(`Navigating to ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(20000);
console.log('Done waiting 20s');
await browser.close();
