import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const controls = readFileSync(new URL('../../src/ui/controls.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

assert.match(controls, /shell\.addEventListener\('focusin',\s*\(\)\s*=>\s*this\.showUI\(\)\)/);
assert.match(controls, /document\.activeElement !== this\.player\.shell/);
assert.match(controls, /'arrowup',\s*'arrowdown',\s*'arrowleft',\s*'arrowright',\s*'enter',\s*'select',\s*'tab',\s*' ',\s*'mediaplaypause'/);
assert.match(controls, /shell\.querySelectorAll<HTMLElement>\([\s\S]*?button:not\(\[disabled\]\)[\s\S]*?input\[type="range"\]/);
assert.match(controls, /controls\[next\]\.focus\(\)/);
assert.match(styles, /\.elf-shell button:focus-visible,[\s\S]*?outline: 2px solid #fff/);

console.log('✓ TV remote navigation reveals controls, moves focus, and keeps focused controls visible.');
