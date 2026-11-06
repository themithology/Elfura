// Optional browser smoke test: npm install --no-save --no-package-lock playwright-core @sparticuz/chromium
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import { createBackendServer } from '../../dist/backend/index.js';
const dir=await mkdtemp(path.join(os.tmpdir(),'roxy-browser-'));process.env.ROXY_DATA_DIR=dir;process.env.ELFURA_SECRET='roxy-browser-test';
const {server}=createBackendServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
let browser; let step='launch';
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:chromiumBinary.args});const page=await browser.newPage();
 step='login'; await page.goto(base+'/roxy');await page.fill('#password','roxy-browser-test');await page.click('#loginForm button');await page.waitForSelector('#dashboard:not(.hidden)');
 assert.equal(await page.locator('#watching').textContent(),'0');assert.equal(await page.locator('#chart .bar').count(),72);
 step='telemetry'; const embed=await browser.newPage();await embed.goto(base+'/embed/movie/872585',{referer:'https://example.com/'});await embed.waitForFunction(()=>!!window.__elfura?.player?.video);await embed.evaluate(()=>window.__elfura.player.video.dispatchEvent(new Event('playing')));
 await page.click('#refresh');await page.waitForFunction(()=>document.querySelector('#plays')?.textContent==='1');assert.equal(await page.locator('#watching').textContent(),'1');assert.match(await page.locator('#sites').innerText(),/example.com/);
 step='ban'; page.on('dialog',d=>d.accept());await page.locator('#sites button').click();await page.waitForFunction(()=>document.querySelector('#sites button')?.textContent==='Unban');
 step='clear'; await page.click('#clear');await page.waitForFunction(()=>document.querySelector('#plays')?.textContent==='0');assert.match(await page.locator('#banned').innerText(),/example.com/);
 console.log('✓ Roxy Chromium login, graph, live playback telemetry, ban and clear smoke test passed.');
} catch(e) {console.log(`::error title=RoxyBrowser::${JSON.stringify({step,error:e.message}).replace(/%/g,'%25').replace(/\n/g,'%0A')}`); process.exitCode=1;} finally {await browser?.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
