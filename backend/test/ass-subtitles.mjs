// ASS / SSA subtitle support, and the default look.
//
// ASS was advertised but broken in two independent ways, both found by parsing a
// real file rather than by reading the code:
//
//   1. a valid .ass produced ZERO cues. The parser took the first `Format:` line
//      it saw anywhere - which is in the style block - and then, having one,
//      ignored the Events block's own `Format:` too. Every Dialogue line was
//      parsed against the wrong field list and discarded, so the track silently
//      never appeared.
//   2. even once parsed, {\b1} {\i1} were stripped without being applied, so
//      emphasis was lost. The comment above parseInline claimed support.
//
// Also pins the default style to the broadcast/anime look: bold white text with
// a crisp black stroke and no box.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCues, detectFormat, parseInline } from '../../src/subs/parser.ts';
import { DEFAULT_SUB_STYLE, mergeStyle } from '../../src/subs/style.ts';

// ---- detection ------------------------------------------------------------
const assFile = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Bold
Style: Default,Arial,48,&H00FFFFFF,-1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\b1}When the four of you{\\b0}
Dialogue: 0,0:00:03.50,0:00:06.00,Default,,0,0,0,,completed the task, I entrusted,
Dialogue: 0,0:00:06.00,0:00:08.00,Default,,0,0,0,,{\\i1}to you{\\i0}\\Nwith a comma, inside
Dialogue: 0,0:00:08.00,0:00:10.00,Default,,0,0,0,,{\\an8}Top of the screen
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,
`;
assert.equal(detectFormat(assFile, undefined), 'ass');
assert.equal(detectFormat('x', 'https://cdn/x.ass'), 'ass');
assert.equal(detectFormat('x', 'https://cdn/x.ssa'), 'ass');

// ---- the file actually parses --------------------------------------------
const parsed = parseCues(assFile, 'x.ass');
assert.equal(parsed.format, 'ass');
assert.equal(parsed.cues.length, 4, 'a valid .ass must yield its dialogue lines, not zero');

assert.equal(parsed.cues[0].text, 'When the four of you', 'the style Format: line must not win over the Events one');
assert.equal(parsed.cues[0].start, 1);
assert.equal(parsed.cues[0].end, 3.5);
assert.equal(parsed.cues[0].spans[0].bold, true, '{\\b1} must be applied');

// Commas inside the dialogue text survive: only the first N-1 fields are split.
assert.equal(parsed.cues[1].text, 'completed the task, I entrusted,');

// {\i1} ... {\i0} then a hard break: two spans, italic only on the first.
assert.equal(parsed.cues[2].spans[0].italic, true);
assert.equal(parsed.cues[2].text, 'to you\nwith a comma, inside');

// \an8 is a top placement hint.
assert.equal(parsed.cues[3].align, 'center');

// A dialogue with no text is dropped.
assert.equal(parsed.cues.length, 4, 'an empty dialogue line is not a cue');

// ---- inline emphasis, all three syntaxes --------------------------------
const inline = (s) => parseInline(s);
assert.equal(inline('{\\b1}bold{\\b0}')[0].bold, true);
assert.equal(inline('{\\i1}ital{\\i0}')[0].italic, true);
assert.equal(inline('{\\u1}und{\\u0}')[0].underline, true);
assert.equal(inline('<b>vtt</b>')[0].bold, true);
assert.equal(inline('<i>vtt</i>')[0].italic, true);
assert.equal(inline('{\\an8}plain')[0].bold, false, 'positioning tags alone change no styling');
assert.equal(inline('a{\\b1}b{\\b0}c').map((s) => s.bold).join(','), 'false,true,false', 'the toggle applies to what follows it');
assert.equal(inline('no markup at all')[0].text, 'no markup at all');

// SRT/VTT/ASS can contain HTML-style font tags, such as the actual caption
// reported by the viewer. Apply safe styles rather than showing the tags.
const styled = inline('<font face="Trebuchet MS" size="24" color="#ff8800">Mother?!</font>');
assert.equal(styled.map(x => x.text).join(''), 'Mother?!');
assert.equal(styled[0].fontFamily, 'Trebuchet MS');
assert.equal(styled[0].fontSize, 24);
assert.equal(styled[0].color, '#ff8800');
const nested = inline('a <font face="Arial" size="24">one <font color="yellow"><i>two</i></font> three</font> end');
assert.equal(nested.map(x => x.text).join(''), 'a one two three end', 'spaces and dialogue survive tag boundaries');
assert.equal(nested.find(x => x.text === 'two')?.fontFamily, 'Arial');
assert.equal(nested.find(x => x.text === 'two')?.fontSize, 24);
assert.equal(nested.find(x => x.text === 'two')?.color, '#ffff00');
assert.equal(nested.find(x => x.text === 'two')?.italic, true);
assert.equal(nested.find(x => x.text === ' three')?.color, undefined, 'closing a nested font restores the parent');
assert.equal(nested.find(x => x.text === ' end')?.fontFamily, undefined, 'closing the outer font restores the default');
assert.equal(inline('<font SIZE=3 COLOR=red>legacy</font>')[0].fontSize, 16);
assert.equal(inline('<font size=9999>bounded</font>')[0].fontSize, 120);
const unsafe = inline('<font face="Arial; color:red" size="bad" color="url(evil)">safe</font>')[0];
assert.equal(unsafe.text, 'safe');
assert.equal(unsafe.fontFamily, undefined);
assert.equal(unsafe.fontSize, undefined);
assert.equal(unsafe.color, undefined);

// ---- VTT and SRT must not regress ---------------------------------------
const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
Hello <b>world</b>

2
00:00:04.000 --> 00:00:06.000 align:start
Second &amp; last
`;
const v = parseCues(vtt, 'a.vtt');
assert.equal(v.format, 'vtt');
assert.equal(v.cues.length, 2);
assert.equal(v.cues[0].spans.some((s) => s.bold), true);
assert.equal(v.cues[1].text, 'Second & last');
assert.equal(v.cues[1].align, 'left');

const srt = `1
00:00:01,000 --> 00:00:02,500
First line here

2
00:00:03,000 --> 00:00:04,000
Second
`;
const s = parseCues(srt, 'a.srt');
assert.equal(s.format, 'srt');
assert.equal(s.cues.length, 2);
assert.equal(s.cues[0].text, 'First line here');
const taggedSrt = parseCues('1\n00:00:01,000 --> 00:00:02,500\n<font face="Trebuchet MS" size="24">Mother?!</font>', 'x.srt');
assert.equal(taggedSrt.cues[0].text, 'Mother?!');
assert.equal(taggedSrt.cues[0].spans[0].fontFamily, 'Trebuchet MS');
assert.equal(taggedSrt.cues[0].spans[0].fontSize, 24);
const taggedVtt = parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<font color="cyan">VTT</font>', 'x.vtt');
assert.equal(taggedVtt.cues[0].spans[0].color, '#00ffff');
const taggedAss = parseCues('[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,<font face="Trebuchet MS" size="24">ASS</font>', 'x.ass');
assert.equal(taggedAss.cues[0].text, 'ASS');
assert.equal(taggedAss.cues[0].spans[0].fontSize, 24);

// ---- the default look ----------------------------------------------------
// Bold white text, crisp black stroke, no box: the broadcast/anime style the
// operator asked for, and what a well-authored ASS file looks like.
assert.equal(DEFAULT_SUB_STYLE.color, '#ffffff', 'pure white fill');
assert.match(DEFAULT_SUB_STYLE.fontFamily, /Trebuchet MS/, 'the reference is set in Trebuchet MS');
assert.equal(DEFAULT_SUB_STYLE.fontWeight, 700, 'Trebuchet MS Bold');
assert.equal(DEFAULT_SUB_STYLE.outline, true, 'the stroke is what makes it readable on bright frames');
assert.equal(DEFAULT_SUB_STYLE.outlineColor, '#000000', 'uniform black border');
assert.ok(DEFAULT_SUB_STYLE.outlineWidth >= 2, 'a thick stroke, not a hairline');
assert.equal(DEFAULT_SUB_STYLE.backgroundOpacity, 0, 'no box: the caption floats over the picture');
// A soft dark shadow under the stroke, so the caption separates from white
// clothing and light hair - the reference frame has one.
assert.equal(DEFAULT_SUB_STYLE.shadow, true);
assert.ok(DEFAULT_SUB_STYLE.shadowBlur > 0, 'the shadow is soft, not a hard offset');

// Size: the reference measures 4.5-5% of frame height (48-54px at 1080p).
// The renderer paints (fontSizePct/100 * 26)px at a 720 baseline, scaled by the
// player height, so this is the real number, not an assumption.
const paintedAt1080 = (DEFAULT_SUB_STYLE.fontSizePct / 100) * 26 * (1080 / 720);
assert.ok(
  paintedAt1080 >= 48 && paintedAt1080 <= 54,
  `at 1080p the caption must paint 48-54px; it paints ${paintedAt1080.toFixed(1)}px`,
);
const framePct = (paintedAt1080 / 1080) * 100;
assert.ok(framePct >= 4.5 && framePct <= 5, `${framePct.toFixed(2)}% of frame height must be 4.5-5%`);
// The operator asked for 125% specifically.
assert.equal(DEFAULT_SUB_STYLE.fontSizePct, 125, 'the default size is 125%, as requested');

// Position: the bottom baseline sits 5-6% up from the bottom edge.
assert.ok(
  DEFAULT_SUB_STYLE.verticalPct >= 5 && DEFAULT_SUB_STYLE.verticalPct <= 6,
  'inside the 5-6% bottom safe margin',
);
assert.equal(DEFAULT_SUB_STYLE.horizontalAlign, 'center', 'center-aligned');
// Narrow enough to wrap into two balanced lines rather than one long line
// running under the characters' faces.
assert.ok(
  DEFAULT_SUB_STYLE.maxWidthPct <= 70,
  'a wide max width keeps the dialogue on one line; the reference wraps',
);

// The stroke must be crisp: equal offsets with zero blur, never a blurred halo.
const renderer = readFileSync(new URL('../../src/subs/renderer.ts', import.meta.url), 'utf8');
assert.match(renderer, /--elf-sub-outline/, 'the renderer paints an outline');
const outlineBlock = renderer.slice(renderer.indexOf("if (s.outline && s.outlineWidth > 0)"));
assert.match(outlineBlock.slice(0, 900), /0 \$\{s\.outlineColor\}/, 'each stroke copy has zero blur radius');
assert.doesNotMatch(
  outlineBlock.slice(0, 300),
  /0 0 \$\{px\(s\.outlineWidth\)\}/,
  'the old blurred-glow form must not come back',
);

// A user's saved style still round-trips and a wide stroke is allowed.
const merged = mergeStyle(DEFAULT_SUB_STYLE, { outlineWidth: 6 });
assert.equal(merged.style.outlineWidth, 6, 'the stroke may be set thick');
assert.deepEqual(merged.issues, [], 'a stroke of 6 is in range, not clamped');

// A saved style is merged OVER the defaults, so a style stored under an old key
// would pin every value and the new defaults would never reach the viewer. The
// store version is what makes a revised look land once.
const source = readFileSync(new URL('../../src/subs/style.ts', import.meta.url), 'utf8');
assert.match(source, /elfura:subtitle-style:v2/, 'a revised default needs a new store key');
assert.match(source, /LEGACY_STORE_KEY/, 'the previous key is still cleared with it');

console.log('ass subtitles: ok');
