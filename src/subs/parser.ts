/**
 * Elfura Player — Cue parsing
 * ===========================
 * WebVTT, SubRip (.srt) and a useful subset of SSA/ASS, normalised to one Cue
 * shape. Inline markup is reduced to three booleans (bold/italic/underline)
 * because that is all a DOM overlay renderer can honour consistently.
 */

export interface CueSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
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

/**
 * Reduce inline markup to spans. Handles VTT <b>/<i>/<u>/<lang>/<c.class> and
 * SSA {\b1}{\i1}{\an8} override blocks plus \N hard breaks.
 */
export function parseInline(raw: string): CueSpan[] {
  const line = raw
    .replace(/\{\\[^}]*\}/g, '') // SSA override blocks
    .replace(/\\N/gi, '\n') // SSA hard break
    .replace(/\\n/g, '\n') // soft break
    .replace(/<\s*(?:lang|c|v|ruby|rt)[^>]*>/gi, '')
    .replace(/<\s*\/\s*(?:lang|c|v|ruby|rt)\s*>/gi, '');

  const spans: CueSpan[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  let buf = '';

  const flush = () => {
    const text = unescape(buf);
    if (text.trim().length || text.includes('\n')) {
      spans.push({ text, bold, italic, underline });
    }
    buf = '';
  };

  const tagRe = /<(\/?)([biu])\s*>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(line)) !== null) {
    buf += line.slice(last, m.index);
    flush();
    const closing = m[1] === '/';
    const which = m[2].toLowerCase();
    const val = !closing;
    if (which === 'b') bold = val;
    if (which === 'i') italic = val;
    if (which === 'u') underline = val;
    last = m.index + m[0].length;
  }
  buf += line.slice(last);
  flush();

  return spans.filter((s) => s.text.length > 0);
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

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Format:/i.test(trimmed) && !format) {
      format = trimmed.slice(trimmed.indexOf(':') + 1).split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed)) continue;
    const payload = trimmed.slice(trimmed.indexOf(':') + 1);
    const fields = payload.split(',');
    if (!format) format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const idxText = format.indexOf('text');
    if (idxText < 0) continue;
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
