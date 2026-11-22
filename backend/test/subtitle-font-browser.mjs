// Browser regression for subtitle font styling, resizing and safe text rendering.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const built = await build({
  stdin: {
    contents: `import {SubtitleRenderer} from './src/subs/renderer.ts';
      import {parseCues} from './src/subs/parser.ts';
      window.subtitleTest = {SubtitleRenderer, parseCues};`,
    resolveDir: process.cwd(), sourcefile: 'subtitle-font-fixture.ts', loader: 'ts',
  },
  bundle: true, write: false, format: 'iife', platform: 'browser',
});
const browser = await chromium.launch({executablePath: await chromiumBinary.executablePath(), args: chromiumBinary.args});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.setContent('<div id="host" style="position:relative;width:1280px;height:720px"></div>');
  await page.addStyleTag({content: await readFile('src/ui/styles.css', 'utf8')});
  await page.addScriptTag({content: built.outputFiles[0].text});
  await page.evaluate(() => {
    const {SubtitleRenderer, parseCues} = window.subtitleTest;
    const renderer = new SubtitleRenderer({host: document.getElementById('host'), draggable: false});
    renderer.bindClock(() => 1.5);
    renderer.setCues(parseCues('1\n00:00:01,000 --> 00:00:02,500\n<font face="Trebuchet MS" size="24" color="#ff8800">Mother?!</font> plain &lt;img src=x&gt;', 'x.srt').cues);
    window.testRenderer = renderer;
  });
  const style = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.elf-sub-span')];
    const styled = getComputedStyle(spans[0]);
    return {text: document.querySelector('.elf-sub-cue').textContent, font: styled.fontFamily,
      size: parseFloat(styled.fontSize), color: styled.color, count: spans.length,
      imgCount: document.querySelectorAll('.elf-sub-cue img').length};
  });
  assert.equal(style.text, 'Mother?! plain <img src=x>');
  assert.equal(style.imgCount, 0, 'subtitle content is text, not executable HTML');
  assert.match(style.font, /Trebuchet MS/);
  assert.ok(Math.abs(style.size - 30) < 0.1, `tagged size scales with default control: ${style.size}`);
  assert.equal(style.color, 'rgb(255, 136, 0)');
  assert.ok(style.count >= 2, 'font styling does not leak onto the following text');
  await page.evaluate(() => window.testRenderer.setStyle({fontSizePct: 200, textOpacity: 0.5}));
  const updated = await page.evaluate(() => {const s=getComputedStyle(document.querySelector('.elf-sub-span'));return {size:parseFloat(s.fontSize),color:s.color};});
  assert.ok(Math.abs(updated.size - 48) < 0.1, 'viewer size control still scales tagged text');
  assert.match(updated.color, /^rgba\(255, 136, 0, 0\.5\)$/, 'viewer text opacity applies to tagged colors');
  await page.evaluate(() => {document.getElementById('host').style.height = '360px';});
  await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.querySelector('.elf-sub-span')).fontSize) - 24) < 0.1);
  console.log('subtitle fonts: browser applies face, size, color; user controls and resize work; content remains inert');
} finally {
  await browser.close();
}
