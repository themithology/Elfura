/**
 * Elfura Player — Subtitle Style Model
 * ====================================
 *
 * Native <track> + ::cue cannot express most of what users ask for: per-property
 * opacity, free vertical positioning, outline/shadow control, font selection and
 * drag-to-move. So the renderer parses VTT/SRT/ASS itself and paints a DOM overlay.
 *
 * Everything here is serialisable so it can round-trip through:
 *   localStorage  (persistSubs)   |   ?substyle= URL param   |   postMessage
 *
 * Units:
 *   fontSizePct  — % of a 720p baseline, scaled to the actual player height so
 *                  captions look identical at 480px and 4K fullscreen.
 *   verticalPct  — % of player height, measured from the anchored edge.
 *   horizontalPct— % of player width, measured from the aligned edge.
 *   *Opacity     — 0 (invisible) .. 1 (solid). Exposed to users as "transparency"
 *                  inverted in the UI, because people think in transparency.
 */

export interface SubtitleStyle {
  /* ---- typeface ---- */
  fontFamily: string;
  fontSizePct: number; // 40..220, 100 == baseline
  fontWeight: number; // 100..900 (700 == bold)
  italic: boolean;
  uppercase: boolean;
  letterSpacingEm: number; // -0.05..0.4
  lineHeight: number; // 1..2

  /* ---- colour & transparency ---- */
  color: string; // #rrggbb
  textOpacity: number; // 0..1
  backgroundColor: string; // #rrggbb
  backgroundOpacity: number; // 0..1
  outline: boolean;
  outlineColor: string;
  outlineWidth: number; // 0..4 px at baseline
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number; // 0..12

  /* ---- box ---- */
  paddingPx: number; // 0..24
  radiusPx: number; // 0..24
  maxWidthPct: number; // 40..100 of player width

  /* ---- position ---- */
  edge: 'bottom' | 'top';
  verticalPct: number; // 0..45 from `edge`
  horizontalAlign: 'left' | 'center' | 'right';
  horizontalPct: number; // -40..40 nudge from the aligned position
}

/**
 * Bold white text with a thick crisp black stroke and no box.
 *
 * This is the broadcast/anime look (and what a well-authored ASS file renders
 * as): it stays readable over both a white sky and a dark night scene, which a
 * translucent box cannot do - the box helps on bright frames and muddies dark
 * ones. The stroke does the work, so the box is off by default and the caption
 * floats over the picture the way viewers of fansubbed anime expect.
 */
export const DEFAULT_SUB_STYLE: SubtitleStyle = {
  // Trebuchet MS is the look the official anime services use, and the one the
  // reference frame is set in. The stack keeps a humanist fallback for systems
  // without it - Arial/Helvetica last, because the fallback should still read
  // as a plain sans, never a serif.
  fontFamily:
    '"Trebuchet MS", "Trebuchet", Tahoma, "Segoe UI", Arial, Helvetica, system-ui, sans-serif',
  // The renderer paints (fontSizePct/100 * 26)px at a 720 baseline, scaled by
  // player height. At 125% that is 48.8px at 1080p - 4.51% of frame height,
  // the lower end of the 4.5-5% band measured off the reference frame.
  fontSizePct: 125,
  fontWeight: 700,
  italic: false,
  uppercase: false,
  letterSpacingEm: 0.005,
  // Tight leading: broadcast subtitles stack lines closely, and the stroke needs
  // the lines to be near each other to read as one block.
  lineHeight: 1.2,

  color: '#ffffff',
  textOpacity: 1,
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  outline: true,
  outlineColor: '#000000',
  outlineWidth: 2.5,
  // A soft dark shadow sits under the stroke, so the caption still separates
  // from a white coat or a bright sky. The stroke alone handles the edges; this
  // handles the body.
  shadow: true,
  shadowColor: '#000000',
  shadowBlur: 3,

  paddingPx: 0,
  radiusPx: 0,
  // Narrow to force the pyramid wrap: two balanced lines instead of one long
  // line that runs under the characters' faces.
  maxWidthPct: 62,

  edge: 'bottom',
  // 5.5% up from the bottom edge, inside the TV/player safe margin.
  verticalPct: 5.5,
  horizontalAlign: 'center',
  horizontalPct: 0,
};

export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: 'Trebuchet MS (default)', value: DEFAULT_SUB_STYLE.fontFamily },
  { label: 'Inter', value: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { label: 'System UI', value: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Courier', value: '"Courier New", monospace' },
  { label: 'Impact', value: 'Impact, Haettenschweiler, sans-serif' },
  { label: 'Comic Sans', value: '"Comic Sans MS", cursive' },
];

export interface StyleClampIssue {
  key: keyof SubtitleStyle;
  from: unknown;
  to: number | string | boolean;
}

const NUM_RANGE: Partial<Record<keyof SubtitleStyle, [number, number]>> = {
  fontSizePct: [40, 220],
  fontWeight: [100, 900],
  letterSpacingEm: [-0.05, 0.4],
  lineHeight: [1, 2],
  textOpacity: [0, 1],
  backgroundOpacity: [0, 1],
  outlineWidth: [0, 6],
  shadowBlur: [0, 12],
  paddingPx: [0, 24],
  radiusPx: [0, 24],
  maxWidthPct: [40, 100],
  verticalPct: [0, 45],
  horizontalPct: [-40, 40],
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Merge a partial (and possibly hostile) style object onto a base.
 * Unknown keys are dropped, out-of-range numbers are clamped, bad colours fall
 * back to the base value. Returns the issues it fixed so the UI can surface them.
 */
export function mergeStyle(
  base: SubtitleStyle,
  patch: Record<string, unknown> | undefined | null,
): { style: SubtitleStyle; issues: StyleClampIssue[] } {
  const style: SubtitleStyle = { ...base };
  const issues: StyleClampIssue[] = [];
  if (!patch) return { style, issues };

  for (const [rawKey, rawVal] of Object.entries(patch)) {
    // Accept a few friendly aliases coming from URL/postMessage.
    const key = normalizeStyleKey(rawKey);
    if (!(key in DEFAULT_SUB_STYLE)) continue;
    const k = key as keyof SubtitleStyle;
    const def = DEFAULT_SUB_STYLE[k];

    if (typeof def === 'boolean') {
      style[k] = (typeof rawVal === 'boolean'
        ? rawVal
        : !(String(rawVal).toLowerCase() === 'false' || rawVal === '0')) as never;
      continue;
    }

    if (typeof def === 'number') {
      let n = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).replace('%', ''));
      if (!Number.isFinite(n)) {
        issues.push({ key: k, from: rawVal, to: def });
        continue;
      }
      const range = NUM_RANGE[k];
      if (range) n = clamp(n, range[0], range[1]);
      if (k === 'fontWeight') n = clamp(Math.round(n / 100) * 100, 100, 900);
      style[k] = n as never;
      continue;
    }

    if (typeof def === 'string') {
      const s = String(rawVal);
      if ((k === 'color' || k === 'backgroundColor' || k === 'outlineColor' || k === 'shadowColor')) {
        const hex = normalizeHex(s);
        if (!hex) {
          issues.push({ key: k, from: rawVal, to: def });
          continue;
        }
        style[k] = hex as never;
      } else {
        style[k] = s as never;
      }
      continue;
    }
  }

  return { style, issues };
}

function normalizeStyleKey(key: string): string {
  const lower = key.toLowerCase().replace(/[-_\s]/g, '');
  const map: Record<string, keyof SubtitleStyle> = {
    size: 'fontSizePct',
    fontsize: 'fontSizePct',
    font: 'fontFamily',
    family: 'fontFamily',
    bold: 'fontWeight',
    weight: 'fontWeight',
    colour: 'color',
    textcolor: 'color',
    opacity: 'textOpacity',
    transparency: 'textOpacity',
    texttransparency: 'textOpacity',
    bg: 'backgroundColor',
    bgcolor: 'backgroundColor',
    background: 'backgroundColor',
    bgopacity: 'backgroundOpacity',
    backgroundopacity: 'backgroundOpacity',
    boxopacity: 'backgroundOpacity',
    position: 'verticalPct',
    offset: 'verticalPct',
    ypos: 'verticalPct',
    xpos: 'horizontalPct',
    align: 'horizontalAlign',
    placement: 'edge',
    maxwidth: 'maxWidthPct',
  };
  return map[lower] ?? (key in DEFAULT_SUB_STYLE ? key : lower);
}

export function normalizeHex(raw: string): string | null {
  let s = raw.trim().replace(/^#/, '');
  if (s.length === 8) s = s.slice(2); // strip alpha
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.toLowerCase()}`;
}

/** Users think "transparency 70%" == opacity 0.3. The UI works in transparency. */
export const opacityToTransparency = (o: number) => Math.round((1 - o) * 100);
export const transparencyToOpacity = (t: number) => clamp(1 - t / 100, 0, 1);

/**
 * Bumped when the shipped defaults change meaningfully.
 *
 * A saved style is merged over DEFAULT_SUB_STYLE, so any viewer who ever
 * touched the subtitle panel pins every value they saw at that moment - the new
 * defaults would never reach them, and the panel would keep showing the old
 * numbers. Keying the version means the revised look lands once, and anything
 * they deliberately set afterwards is stored again under the new key.
 */
const STORE_KEY = 'elfura:subtitle-style:v2';
/** Read-only ancestor, so a v1 style can still be carried over if we ever want it. */
const LEGACY_STORE_KEY = 'elfura:subtitle-style:v1';

export function loadStoredStyle(): SubtitleStyle | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const { style } = mergeStyle(DEFAULT_SUB_STYLE, JSON.parse(raw));
    return style;
  } catch {
    return null;
  }
}

export function saveStoredStyle(style: SubtitleStyle): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(style));
  } catch {
    /* private mode / disabled storage — non-fatal */
  }
}

export function clearStoredStyle(): void {
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(LEGACY_STORE_KEY);
  } catch {
    /* ignore */
  }
}

export const isBold = (style: SubtitleStyle) => style.fontWeight >= 700;
