/**
 * Elfura Player — Subtitle renderer
 * =================================
 * DOM overlay driven by the parsed cue list and a SubtitleStyle.
 *
 * Why not <track>::cue — no per-property opacity, no free positioning, no
 * reliable font control, no drag-to-move, and styling differs per browser.
 *
 * Performance notes:
 *  - cues are sorted; lookup is a binary search + a small active window, so
 *    cost per frame is O(active cues), not O(all cues).
 *  - style is applied via CSS custom properties on the root, so a style change
 *    touches one element's style attribute and never re-renders cue text.
 *  - text nodes are only rebuilt when the cue set actually changes.
 */

import type { Cue } from './parser';
import { DEFAULT_SUB_STYLE, type SubtitleStyle } from './style';

export interface RendererOptions {
  /** Element the overlay is positioned inside (the video surface, not the shell). */
  host: HTMLElement;
  /** Baseline player height that fontSizePct 100 corresponds to. */
  baselineHeight?: number;
  onStyleChange?: (style: SubtitleStyle) => void;
  /** Let the user drag captions to a new position. */
  draggable?: boolean;
}

const BASELINE = 720;

export class SubtitleRenderer {
  private root: HTMLElement;
  private box: HTMLElement;
  private cues: Cue[] = [];
  private active: Cue[] = [];
  private style: SubtitleStyle;
  private enabled = true;
  private hostHeight = BASELINE;
  private ro?: ResizeObserver;
  private rafId = 0;
  private getTime: () => number = () => 0;
  private opts: RendererOptions;

  constructor(opts: RendererOptions, initial?: Partial<SubtitleStyle>) {
    this.opts = opts;
    this.style = { ...DEFAULT_SUB_STYLE, ...initial };

    this.root = document.createElement('div');
    this.root.className = 'elf-sub-root';
    this.root.setAttribute('aria-live', 'polite');
    this.root.setAttribute('aria-atomic', 'false');

    this.box = document.createElement('div');
    this.box.className = 'elf-sub-box';
    this.root.appendChild(this.box);

    opts.host.appendChild(this.root);

    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(opts.host);
    this.measure();
    this.applyStyle();

    if (opts.draggable !== false) this.enableDrag();
  }

  /* -------------------------------------------------------------- */
  /* Data                                                            */
  /* -------------------------------------------------------------- */

  setCues(cues: Cue[]): void {
    this.cues = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
    this.active = [];
    this.render(true);
  }

  clear(): void {
    this.cues = [];
    this.active = [];
    this.render(true);
  }

  /** Supply the clock so the renderer can drive itself from rAF. */
  bindClock(getTime: () => number): void {
    this.getTime = getTime;
    cancelAnimationFrame(this.rafId);
    const loop = () => {
      this.render(false);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.hidden = !on;
    if (!on) this.clearBox();
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  getStyle(): SubtitleStyle {
    return { ...this.style };
  }

  setStyle(patch: Partial<SubtitleStyle>, opts?: { silent?: boolean }): void {
    this.style = { ...this.style, ...patch };
    this.applyStyle();
    this.render(true);
    if (!opts?.silent) this.opts.onStyleChange?.(this.getStyle());
  }

  replaceStyle(style: SubtitleStyle): void {
    this.style = { ...style };
    this.applyStyle();
    this.render(true);
    this.opts.onStyleChange?.(this.getStyle());
  }

  /* -------------------------------------------------------------- */
  /* Rendering                                                       */
  /* -------------------------------------------------------------- */

  private measure(): void {
    const h = this.opts.host.clientHeight || BASELINE;
    if (h !== this.hostHeight) {
      this.hostHeight = h;
      this.applyStyle();
    }
  }

  private applyStyle(): void {
    const s = this.style;
    const scale = this.hostHeight / (this.opts.baselineHeight ?? BASELINE);
    const px = (v: number) => `${Math.max(1, v * scale).toFixed(2)}px`;
    const root = this.root.style;

    // Geometry
    root.setProperty('--elf-sub-inset', `${(s.verticalPct / 100) * this.hostHeight}px`);
    root.setProperty('--elf-sub-hshift', `${(s.horizontalPct / 100) * (this.opts.host.clientWidth || this.hostHeight * 1.78)}px`);
    root.setProperty('--elf-sub-maxw', `${s.maxWidthPct}%`);
    this.root.dataset.edge = s.edge;
    this.root.dataset.align = s.horizontalAlign;

    // Type
    root.setProperty('--elf-sub-font', s.fontFamily);
    root.setProperty('--elf-sub-size', px((s.fontSizePct / 100) * 26));
    root.setProperty('--elf-sub-weight', String(s.fontWeight));
    root.setProperty('--elf-sub-italic', s.italic ? 'italic' : 'normal');
    root.setProperty('--elf-sub-transform', s.uppercase ? 'uppercase' : 'none');
    root.setProperty('--elf-sub-tracking', `${s.letterSpacingEm}em`);
    root.setProperty('--elf-sub-leading', String(s.lineHeight));

    // Colour + separate transparencies
    root.setProperty('--elf-sub-color', hexToRgba(s.color, s.textOpacity));
    root.setProperty('--elf-sub-bg', hexToRgba(s.backgroundColor, s.backgroundOpacity));
    root.setProperty('--elf-sub-pad', px(s.paddingPx));
    root.setProperty('--elf-sub-radius', px(s.radiusPx));
    root.setProperty(
      '--elf-sub-outline',
      s.outline && s.outlineWidth > 0
        ? `0 0 ${px(s.outlineWidth)} ${s.outlineColor}, 0 0 ${px(s.outlineWidth)} ${s.outlineColor}`
        : 'none',
    );
    root.setProperty(
      '--elf-sub-shadow',
      s.shadow && s.shadowBlur > 0 ? `0 ${px(1)} ${px(s.shadowBlur)} ${s.shadowColor}` : 'none',
    );

    // A fully transparent box should not swallow pointer events or paint a rect.
    this.box.classList.toggle('elf-sub-box--bare', s.backgroundOpacity <= 0.01 && s.paddingPx <= 0);
  }

  private clearBox(): void {
    if (this.box.childElementCount) this.box.replaceChildren();
  }

  /** Binary search for the first cue whose end >= t. */
  private firstCandidate(t: number): number {
    const c = this.cues;
    let lo = 0;
    let hi = c.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].end < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private render(force: boolean): void {
    if (!this.enabled) return;
    const t = this.getTime();
    const next: Cue[] = [];
    const startIdx = this.firstCandidate(t);
    for (let i = startIdx; i < this.cues.length; i++) {
      const cue = this.cues[i];
      if (cue.start > t) break;
      if (cue.end >= t && cue.start <= t) next.push(cue);
    }

    const changed =
      force ||
      next.length !== this.active.length ||
      next.some((c, i) => c !== this.active[i]);
    if (!changed) return;

    this.active = next;
    if (!next.length) {
      this.clearBox();
      this.root.dataset.state = 'empty';
      return;
    }
    this.root.dataset.state = 'showing';
    this.box.replaceChildren(...next.map((c) => this.buildCueEl(c)));
  }

  private buildCueEl(cue: Cue): HTMLElement {
    const el = document.createElement('div');
    el.className = 'elf-sub-cue';
    if (cue.align) el.dataset.align = cue.align;

    for (const span of cue.spans) {
      // Preserve embedded newlines as separate lines.
      const parts = span.text.split('\n');
      parts.forEach((part, idx) => {
        if (idx > 0) el.appendChild(document.createElement('br'));
        if (!part) return;
        const node = document.createElement('span');
        node.className = 'elf-sub-span';
        if (span.bold) node.dataset.bold = '';
        if (span.italic) node.dataset.italic = '';
        if (span.underline) node.dataset.underline = '';
        node.textContent = part;
        el.appendChild(node);
      });
    }
    return el;
  }

  /* -------------------------------------------------------------- */
  /* Drag to reposition                                              */
  /* -------------------------------------------------------------- */

  private enableDrag(): void {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originV = 0;
    let originH = 0;

    const down = (e: PointerEvent) => {
      if (!this.enabled || !this.active.length) return;
      if (!(e.target as HTMLElement).closest('.elf-sub-box')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      originV = this.style.verticalPct;
      originH = this.style.horizontalPct;
      this.root.dataset.dragging = '';
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const rect = this.opts.host.getBoundingClientRect();
      const dyPct = ((e.clientY - startY) / rect.height) * 100;
      const dxPct = ((e.clientX - startX) / rect.width) * 100;
      // Dragging down from the bottom edge must reduce the inset.
      const vDir = this.style.edge === 'bottom' ? -1 : 1;
      this.setStyle({
        verticalPct: clamp(originV + vDir * dyPct, 0, 45),
        horizontalPct: clamp(originH + dxPct, -40, 40),
      });
    };

    const up = () => {
      if (!dragging) return;
      dragging = false;
      delete this.root.dataset.dragging;
    };

    this.root.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.ro?.disconnect();
    this.root.remove();
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return hex;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}
