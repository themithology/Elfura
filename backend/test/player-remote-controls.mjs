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

// Keep the latest-main dynamic audio/server UX intact during visual restyles.
assert.match(controls, /el\('button', 'elf-btn elf-audio-quick'\)/);
assert.match(controls, /private syncAudioQuickLabel\(\): void \{[\s\S]*?this\.player\.getAudioTracks\(\)[\s\S]*?this\.player\.getSources\(\)/);
assert.match(controls, /`Audio: \$\{label\}\. Change audio and subtitles`/);
assert.match(controls, /row\.classList\.add\('elf-audio-option'\)/);
assert.match(styles, /\.elf-menu-item\.elf-audio-option\[data-selected='true'\][\s\S]*?border-color: #fff/);

assert.match(controls, /import \{ solarIcon \} from '\.\/solar-icons'/);
assert.match(controls, /button\.dataset\.twist = direction/);
assert.match(controls, /e\.key === 'ArrowRight'\) this\.skipAndTwist\('fwd', step\)/);
assert.match(controls, /new ResizeObserver\(syncGliderPosition\)/);
assert.match(controls, /group\.appendChild\(glider\)/);
assert.match(controls, /drawerHeading\('Audio', I\.headphonesDuotone\)/);
assert.match(controls, /drawerHeading\('Subtitles', I\.subtitlesDuotone\)/);
assert.match(styles, /\.elf-skip10-btn\[data-twist='back'\] svg/);
assert.match(styles, /\.elf-pill-glider/);

console.log('✓ TV remote navigation, Solar controls, skip twists, and in-place segmented gliders hold.');
