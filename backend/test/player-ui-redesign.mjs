/**
 * The 2026 chrome redesign moved the UI from "playful" to "cinematic".
 *
 * These are contract assertions rather than pixel tests: they pin the decisions
 * that were expensive to get right and easy to undo by accident — no novelty
 * fallback font, no overshoot on ordinary controls, one deliberate spring on the
 * age-rating slip, no third-party quote fetch on startup, and a loading state
 * that tells the truth.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');
const controls = fs.readFileSync(new URL('../../src/ui/controls.ts', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../../src/core/config.ts', import.meta.url), 'utf8');

/* 1. Typography: the system stack, and a real display fallback. */
assert.ok(!/Comic Sans|Chalkboard|Marker Felt|Bubblegum|Fredoka/i.test(css), 'no novelty fallback typefaces');
assert.ok(!/--elf-cartoon-font/.test(css), 'cartoon font token stays removed');
assert.ok(css.includes('.elf-title-fallback {'), 'title has a dedicated display fallback');
assert.ok(controls.includes('elf-title-fallback--'), 'the fallback is used by the UI');
assert.ok(!controls.includes('elf-title-cartoon'), 'legacy cartoon class is gone');

/* 2. Motion: only the rating slip may overshoot. */
assert.ok(!/var\(--elf-spring\)/.test(css), 'ordinary controls never use a spring token');
assert.ok(css.includes('@keyframes elf-rating-in'), 'rating entrance is keyframed');
assert.ok(css.includes('cubic-bezier(0.2, 1.5, 0.36, 1)'), 'rating entrance uses an explicit overshoot');
assert.ok(css.includes('@keyframes elf-rating-out'), 'rating exit is keyframed');
assert.ok(/prefers-reduced-motion: reduce/.test(css), 'reduced motion is respected');
assert.ok(controls.includes('maybeShowRatingBadge'), 'rating card is wired to playback');
assert.ok(/}, 4000\);/.test(controls), 'rating card holds for a readable beat, then leaves');

/* 3. Startup: honest, local, and quiet. */
assert.ok(!css.includes('elf-loading-dvd'), 'DVD bounce styles are gone');
assert.ok(!controls.includes('dvd-bounce'), 'DVD bounce module is not imported');
assert.ok(!controls.includes('zenquotes'), 'startup makes no third-party quote request');
assert.ok(controls.includes('Preparing your stream'), 'startup states what it is doing');
assert.ok(css.includes('.elf-loading-rule') && css.includes('.elf-loading-status'), 'startup shows progress + status');
assert.ok(css.includes('.elf-title-logo--loading'), 'startup uses the title lockup');

/* 4. Menus & states: labelled tabs, sheet surface, terminal retry. */
assert.ok(controls.includes("'elf-tab'"), 'panel tabs are labelled controls');
assert.ok(controls.includes('Audio & Subs') && controls.includes('Quality') && controls.includes('Servers'), 'tab labels exist');
assert.ok(css.includes('.elf-tab[data-on='), 'active tab has a visible state');
assert.ok(css.includes('.elf-panel::before'), 'mobile sheet has a grab handle');
assert.ok(css.includes('.elf-unavailable-kicker'), 'terminal state has an editorial kicker');
assert.ok(controls.includes("Playback didn't start"), 'terminal copy is viewer-facing');
assert.ok(css.includes('.elf-unmute') && controls.includes('syncUnmuteHint'), 'muted autoplay offers a visible unmute');
assert.ok(controls.includes('Tap to unmute'), 'the unmute affordance is a button, not a toast');

/* 5. Data: certification and runtime survive the shared contract. */
assert.ok(fs.readFileSync(new URL('../../src/core/player.ts', import.meta.url), 'utf8').includes('certification?: string'), 'TitleMediaInfo carries certification');
assert.ok(fs.readFileSync(new URL('../../backend/src/tmdb.ts', import.meta.url), 'utf8').includes('release_dates,content_ratings'), 'TMDB request asks for ratings');
assert.ok(!config.includes('bounces this'), 'stale startup comment removed');

/* 6. The public entry still owns the stylesheet, so the redesign ships. */
assert.ok(index.includes("import './ui/styles.css'"), 'stylesheet remains in the player bundle');

console.log('player UI redesign: typography, motion, startup, menus, states and rating metadata passed');
