/**
 * Elfura Player — Cue parsing
 * ===========================
 * WebVTT, SubRip (.srt) and a useful subset of SSA/ASS, normalised to one Cue
 * shape. Supported inline font tags and basic emphasis are represented as
 * safe styling data, not injected as HTML.
 */

export interface CueSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Font tags are rendered as safe CSS, never as subtitle HTML. */
  fontFamily?: string;
  /** Pixel-like source size at the 720p baseline, scaled by the user's size setting. */
  fontSize?: number;
  color?: string;
}

export interface Cue {
  id: string;
  start: number;
  end: number;
  spans: CueSpan[];
  /** Plain text, for search / a11y / the transcript panel. */
  text: string;
  /** ASS \an / VTT line position hints, if present. */
  align?: 'left' | 'center' | 'right';
}

export type CueFormat = 'vtt' | 'srt' | 'ass' | 'unknown';

const TIME_RE =
  /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,2}):(\d{2})[.,](\d{1,3})/;

export function parseTimestamp(raw: string): number | null {
  const s = raw.trim();
  const m = s.match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/) ?? s.match(/^(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (m) {
    const parts = m.slice(1).filter((x) => x !== undefined);
    let secs = 0;
    if (parts.length === 4) secs = Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3].padEnd(3, '0')) / 1000;
    else secs = Number(parts[0]) * 60 + Number(parts[1]) + Number(parts[2].padEnd(3, '0')) / 1000;
    return secs;
  }
  const bare = Number(s);
  return Number.isFinite(bare) ? bare : null;
}

export function detectFormat(body: string, url?: string): CueFormat {
  const head = body.slice(0, 400);
  if (/^\uFEFF?\s*WEBVTT/i.test(head)) return 'vtt';
  if (/\[Script Info\]/i.test(head) || /^\s*Dialogue:\s*\d/i.test(head)) return 'ass';
  if (/^\s*1\s*\r?\n\s*\d{1,2}:\d{2}/.test(head)) return 'srt';
  if (url) {
    const q = url.split('?')[0].toLowerCase();
    if (q.endsWith('.vtt')) return 'vtt';
    if (q.endsWith('.srt')) return 'srt';
    if (q.endsWith('.ass') || q.endsWith('.ssa')) return 'ass';
  }
  // Fall back: a VTT-ish timing line anywhere in the first chunk.
  return TIME_RE.test(head) ? 'srt' : 'unknown';
}

/* ------------------------------------------------------------------ */
/* Inline markup                                                       */
/* ------------------------------------------------------------------ */

const ESCAPES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&lrm;': '',
  '&rlm;': '',
};

function unescape(s: string): string {
  return s.replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (m) => ESCAPES[m] ?? m);
}

type InlineFont = Pick<CueSpan, 'fontFamily' | 'fontSize' | 'color'>;
const SAFE_COLORS: Record<string, string> = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00', aqua: '#00ffff',
  fuchsia: '#ff00ff', silver: '#c0c0c0', gray: '#808080', grey: '#808080', maroon: '#800000',
  olive: '#808000', purple: '#800080', teal: '#008080', navy: '#000080', orange: '#ffa500',
};

/** Only data we understand is used; untrusted subtitle markup is never HTML. */
function fontAttributes(raw: string): InlineFont {
  const out: InlineFont = {};
  const attrs = /(?:^|\s)(face|size|color)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = attrs.exec(raw))) {
    const value = unescape(match[2] ?? match[3] ?? match[4] ?? '').trim();
    const key = match[1].toLowerCase();
    if (key === 'face' && /^[\p{L}\p{N} _.'-]{1,80}$/u.test(value)) out.fontFamily = value;
    if (key === 'size' && /^\d+(?:\.\d+)?(?:px)?$/i.test(value)) {
      const size = Number.parseFloat(value);
      // HTML's legacy 1–7 sizes are steps; larger values in SRT exports are
      // conventionally pixel-like values (such as size="24").
      const legacy = [0, 10, 13, 16, 18, 24, 32, 48];
      if (size > 0) out.fontSize = Math.max(8, Math.min(120, !/px$/i.test(value) && Number.isInteger(size) && size <= 7 ? legacy[size] : size));
    }
    if (key === 'color') {
      const color = value.toLowerCase();
      if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color)) out.color = color;
      else if (Object.hasOwn(SAFE_COLORS, color)) out.color = SAFE_COLORS[color];
    }
  }
  return out;
}

/**
 * Reduce inline markup to safe spans. Supports basic emphasis, nested HTML
 * font face/size/color and SSA emphasis overrides plus \N hard breaks.
 */
export function parseInline(raw: string): CueSpan[] {
  const spans: CueSpan[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  const fonts: InlineFont[] = [{}];
  let buf = '';

  const flush = () => {
    const text = unescape(buf);
    if (text.length) spans.push({ text, bold, italic, underline, ...fonts[fonts.length - 1] });
    buf = '';
  };

  // One pass over every construct that changes state, in source order:
  //   {\b1} {\i1} {\u1}   SSA toggles ({\b0} etc. turn them off, {\b700} is on)
  //   <b> </b> <i> </i> <u> </u>   WebVTT inline tags
  //   <font face="..." size="..." color="...">   legacy subtitle styles
  //   \N \n   hard and soft line breaks
  // ASS positioning, colours and karaoke remain outside this simple renderer.
  const TOKEN =
    /\{([^}]*)\}|<(\/?)([biu])\s*>|\\([Nn])|<\s*(\/?)font(?=\s|\/?>)((?:"[^"]*"|'[^']*'|[^'">])*)>|<\s*\/?\s*(?:lang|c|v|ruby|rt)[^>]*>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(raw)) !== null) {
    buf += raw.slice(last, m.index);
    last = m.index + m[0].length;

    if (m[1] !== undefined) {
      // SSA override block, e.g. {\b1}, {\i0}, {\an8}. Flush FIRST so the text
      // before the block keeps the old state, then apply the toggles it carries
      // and drop the rest (positioning, colours, karaoke).
      flush();
      for (const tag of m[1].match(/\\[biu][^\\]*/gi) ?? []) {
        const which = tag[1].toLowerCase();
        const value = tag.slice(2).trim();
        const on = value === '' ? true : Number.parseInt(value, 10) !== 0;
        if (which === 'b') bold = on;
        if (which === 'i') italic = on;
        if (which === 'u') underline = on;
      }
      continue;
    }
    if (m[3] !== undefined) {
      // WebVTT <b> / </b> etc. Flush with the old state, then switch it.
      flush();
      const on = m[2] !== '/';
      const which = m[3].toLowerCase();
      if (which === 'b') bold = on;
      if (which === 'i') italic = on;
      if (which === 'u') underline = on;
      continue;
    }
    if (m[4] !== undefined) {
      // \N and \n are both hard breaks for our purposes.
      buf += '\n';
      continue;
    }
    if (m[5] !== undefined) {
      flush();
      if (m[5] === '/') {
        if (fonts.length > 1) fonts.pop();
      } else {
        fonts.push({ ...fonts[fonts.length - 1], ...fontAttributes(m[6]) });
      }
      continue;
    }
    // Other inline tags (positioning, classes): drop, keeping span order.
    flush();
  }
  buf += raw.slice(last);
  flush();

  return spans.some((s) => s.text.trim().length > 0 || s.text.includes('\n')) ? spans : [];
}

const textOf = (spans: CueSpan[]) => spans.map((s) => s.text).join('');

/* ------------------------------------------------------------------ */
/* VTT / SRT                                                           */
/* ------------------------------------------------------------------ */

function parseTimedText(body: string): Cue[] {
  const cues: Cue[] = [];
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let n = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines, WEBVTT header, NOTE blocks and STYLE blocks.
    if (!line.trim()) { i++; continue; }
    if (/^WEBVTT/i.test(line) || /^NOTE/i.test(line) || /^STYLE/i.test(line) || /^Region:/i.test(line) || /^Kind:|^Language:|^id:/i.test(line.trim())) {
      i++;
      continue;
    }

    const timingIdx = TIME_RE.test(line) ? i : TIME_RE.test(lines[i + 1] ?? '') ? i + 1 : -1;
    if (timingIdx < 0) { i++; continue; }

    const timingLine = lines[timingIdx];
    const arrow = timingLine.indexOf('-->');
    if (arrow < 0) { i++; continue; }

    const start = parseTimestamp(timingLine.slice(0, arrow));
    const afterArrow = timingLine.slice(arrow + 3);
    // Cue settings (position:50% line:90% align:middle) can follow the end time.
    const endToken = afterArrow.trim().split(/\s+/)[0];
    const settings = afterArrow.slice(afterArrow.indexOf(endToken) + endToken.length);
    const end = parseTimestamp(endToken);
    if (start === null || end === null) { i = timingIdx + 1; continue; }

    const id = timingIdx > i ? lines[i].trim() : `cue-${++n}`;
    let textLines: string[] = [];
    let j = timingIdx + 1;
    while (j < lines.length && lines[j].trim() !== '') {
      textLines.push(lines[j]);
      j++;
    }

    const positional = parseCueSettings(settings);
    const spans = parseInline(textLines.join('\n'));
    if (spans.length) {
      cues.push({
        id: String(id) || `cue-${++n}`,
        start,
        end,
        spans,
        text: textOf(spans),
        align: positional.align,
      });
    }
    i = j + 1;
  }

  return cues;
}

function parseCueSettings(settings: string): { align?: Cue['align'] } {
  const out: { align?: Cue['align'] } = {};
  const align = /align:(start|middle|end|left|right)/i.exec(settings);
  if (align) {
    const v = align[1].toLowerCase();
    out.align = v === 'start' || v === 'left' ? 'left' : v === 'end' || v === 'right' ? 'right' : 'center';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SSA / ASS                                                           */
/* ------------------------------------------------------------------ */

function parseAss(body: string): Cue[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let format: string[] | null = null;
  const cues: Cue[] = [];
  let n = 0;

  // Section-aware: the [Events] block has its OWN Format: line, and so do the
  // style blocks. The old code took the first Format: it saw anywhere in the
  // file - style definitions - and then, having a format, ignored the Events one
  // too. Every dialogue was then parsed against the wrong field list and thrown
  // away, so a perfectly valid .ass produced zero cues and the track silently
  // never appeared. That is why ASS subtitles looked unsupported.
  let section = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    if (/^Format:/i.test(trimmed)) {
      // Only the Events format describes Dialogue lines. Style formats list
      // font fields and must not be mistaken for it.
      if (section === 'events' || (!section && !format)) {
        format = trimmed.slice(trimmed.indexOf(':') + 1).split(',').map((f) => f.trim().toLowerCase());
      }
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed)) continue;
    const payload = trimmed.slice(trimmed.indexOf(':') + 1);
    if (!format) format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const idxText = format.indexOf('text');
    if (idxText < 0) continue;
    const fields = payload.split(',');
    const text = fields.slice(idxText).join(','); // text may contain commas
    const start = parseAssTime(fields[format.indexOf('start')] ?? '');
    const end = parseAssTime(fields[format.indexOf('end')] ?? '');
    if (start === null || end === null || !text.trim()) continue;

    const spans = parseInline(text);
    if (!spans.length) continue;
    const an = /\\an([1-9])/i.exec(text);
    cues.push({
      id: `ass-${++n}`,
      start,
      end,
      spans,
      text: textOf(spans),
      align: an ? ([, , 'center', 'right', 'left', 'center', 'right', 'left', 'center', 'right'][Number(an[1])] as Cue['align']) : undefined,
    });
  }

  return cues;
}

function parseAssTime(raw: string): number | null {
  const m = raw.trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,2})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(2, '0')) / 100;
}

/* ------------------------------------------------------------------ */
/* Public entry                                                        */
/* ------------------------------------------------------------------ */

export function parseCues(body: string, url?: string): { cues: Cue[]; format: CueFormat } {
  const format = detectFormat(body, url);
  let cues: Cue[];
  if (format === 'ass') cues = parseAss(body);
  else cues = parseTimedText(body);

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return { cues, format };
}

/** Load and parse a remote subtitle file with a timeout. */
export async function fetchCues(url: string, timeoutMs = 8000): Promise<{ cues: Cue[]; format: CueFormat; lang?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const body = await res.text();
    return { ...parseCues(body, url) };
  } finally {
    clearTimeout(timer);
  }
}
