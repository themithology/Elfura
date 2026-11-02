/**
 * Elfura Player — chrome
 * ======================
 * Visual target: the reference captures. Tabbed icon settings overlay, quality
 * HUD with the *effective* resolution under Auto, +/-10 seek cluster, thin
 * full-width scrubber, centre state flash.
 *
 * Two rules govern everything here:
 *
 *   NOTHING IS HARDCODED
 *     - quality rows come from the manifest (qualityLevels), never a fixed list
 *     - tabs exist only when the stream offers something: no audio tab with one
 *       track, no subtitle tab with none, no PiP button where PiP is unsupported
 *     - the skip interval, accent, brand and skin all come from the input schema
 *     - time format derives from duration (h:mm:ss only when needed)
 *
 *   IT MUST STAY FAST
 *     - one requestAnimationFrame loop drives time / scrubber / buffer, and it
 *       writes a DOM property only when the value actually changed
 *     - the settings panel is built once per open; switching tabs swaps only the
 *       body container, never the whole tree
 *     - no innerHTML in the hot path; icons are strings injected once at build
 */

import type { ElfuraPlayer } from '../core/player';
import type { SubtitleStyle } from '../subs/style';
import { FONT_CHOICES, opacityToTransparency, transparencyToOpacity } from '../subs/style';
import type { AudioTrack } from '../core/audio';
import { SubtitleRenderer } from '../subs/renderer';

/* ---------------------------------------------------------------------- */
/* Icons (injected once at build time, never in the hot path)              */
/* ---------------------------------------------------------------------- */

const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.1v13.8a1 1 0 0 0 1.5.9l11.2-6.9a1 1 0 0 0 0-1.7L9.5 4.2A1 1 0 0 0 8 5.1z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 4h3.6v16H7zm6.4 0H17v16h-3.6z"/></svg>',
  back10:
    '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/><text x="12" y="16.4" text-anchor="middle" font-size="7.6" font-weight="700" font-family="inherit">10</text></svg>',
  fwd10:
    '<svg viewBox="0 0 24 24"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="16.4" text-anchor="middle" font-size="7.6" font-weight="700" font-family="inherit">10</text></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a3.5 3.5 0 0 0-2-3.2v6.4a3.5 3.5 0 0 0 2-3.2zm-2-7.7v2.1a5.7 5.7 0 0 1 0 11.2v2.1a7.8 7.8 0 0 0 0-15.4z"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm15.5 3 2-2-1.4-1.4-2 2-2-2L14.7 10l2 2-2 2 1.4 1.4 2-2 2 2 1.4-1.4-2-2z"/></svg>',
  phones:
    '<svg viewBox="0 0 24 24"><path d="M12 3a8 8 0 0 0-8 8v6a3 3 0 0 0 3 3h2v-8H6v-1a6 6 0 1 1 12 0v1h-3v8h2a3 3 0 0 0 3-3v-6a8 8 0 0 0-8-8z"/></svg>',
  cc: '<svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8.5 11.5A3.5 3.5 0 0 1 7 12a3.5 3.5 0 0 1 6.3-2.1l-1.4.9A1.9 1.9 0 0 0 8.9 12a1.9 1.9 0 0 0 3 1.2l1.4.9a3.5 3.5 0 0 1-2.8 1.4zm6 0A3.5 3.5 0 0 1 13 12a3.5 3.5 0 0 1 6.3-2.1l-1.4.9A1.9 1.9 0 0 0 14.9 12a1.9 1.9 0 0 0 3 1.2l1.4.9a3.5 3.5 0 0 1-2.8 1.4z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5zm9 3.5-.02-.86 1.7-1.33-1.9-3.3-2.02.8a7.3 7.3 0 0 0-1.5-.86L16.9 4.3h-3.8l-.36 2.15c-.54.2-1.04.5-1.5.86l-2.02-.8-1.9 3.3 1.7 1.33v1.72l-1.7 1.33 1.9 3.3 2.02-.8c.46.36.96.65 1.5.86L13.1 19.7h3.8l.36-2.15c.54-.2 1.04-.5 1.5-.86l2.02.8 1.9-3.3-1.7-1.33z"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><path d="M19 11h-8v6h8zm4-8H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18z"/></svg>',
  fs: '<svg viewBox="0 0 24 24"><path d="M5 5h5V3H3v7h2zm14 0v5h2V3h-7v2zM5 19v-5H3v7h7v-2zm14 0h-5v2h7v-7h-2z"/></svg>',
  fsExit: '<svg viewBox="0 0 24 24"><path d="M8 3v5H3V6h3V3zm8 0h2v3h3v2h-5zm-8 18H6v-3H3v-2h5zm8 0v-5h5v2h-3v3z"/></svg>',
  bars: '<svg viewBox="0 0 24 24"><path d="M4 16h3v5H4zm5-4h3v9H9zm5-4h3v13h-3zm5-5h3v18h-3z"/></svg>',
  gauge:
    '<svg viewBox="0 0 24 24"><path d="M12 4a9 9 0 0 0-9 9h2a7 7 0 0 1 12.6-4.2l1.5-1.3A9 9 0 0 0 12 4zm7.6 5.1-1.5 1.3A7 7 0 0 1 19 13h2a9 9 0 0 0-1.4-3.9zM13 8.6 9.2 12.4a2.7 2.7 0 1 0 3.8 3.8L16.8 12.4z" transform="rotate(0 12 12)"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
};

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

type TabId = 'quality' | 'subs' | 'speed' | 'audio' | 'style';

export class PlayerUI {
  private player: ElfuraPlayer;

  private hud!: HTMLElement;
  private hudMode!: HTMLElement;
  private hudPill!: HTMLElement;
  private flash!: HTMLElement;
  private bigPlay!: HTMLButtonElement;
  private spinner!: HTMLElement;
  private toastEl!: HTMLElement;
  private skipBtn!: HTMLButtonElement;

  private scrub!: HTMLElement;
  private rail!: HTMLElement;
  private fill!: HTMLElement;
  private buffered!: HTMLElement;
  private knob!: HTMLElement;
  private tip!: HTMLElement;
  private segLayer!: HTMLElement;

  private bar!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private back10!: HTMLButtonElement;
  private fwd10!: HTMLButtonElement;
  private volBtn!: HTMLButtonElement;
  private volSlider!: HTMLInputElement;
  private timeEl!: HTMLElement;
  private audioBtn!: HTMLButtonElement;
  private ccBtn!: HTMLButtonElement;
  private gearBtn!: HTMLButtonElement;
  private pipBtn!: HTMLButtonElement;
  private fsBtn!: HTMLButtonElement;

  private panel!: HTMLElement;
  private tabsEl!: HTMLElement;
  private panelBody!: HTMLElement;
  private previewRenderer: SubtitleRenderer | null = null;

  private tab: TabId = 'quality';
  private raf = 0;
  private hideTimer = 0;
  private toastTimer = 0;
  private flashTimer = 0;
  private dragging = false;

  /* last written values — the whole "fast" trick */
  private lastPct = -1;
  private lastBufPct = -1;
  private lastTimeStr = '';
  private lastHudMode = '';
  private lastHudPill = '';

  constructor(player: ElfuraPlayer) {
    this.player = player;
    this.build();
    this.wire();
    this.syncCapabilities();
    this.showUI();
    this.startLoop();
  }

  /* ------------------------------------------------------------------ */
  /* Build once                                                          */
  /* ------------------------------------------------------------------ */

  private build(): void {
    const shell = this.player.shell;
    const cfg = this.player.config;
    shell.dataset.controls = String(cfg.controls !== false);

    /* top bar */
    const top = el('div', 'elf-top');
    if (cfg.back) {
      const b = el('button', 'elf-btn', I.back);
      b.title = 'Back';
      b.setAttribute('aria-label', 'Back');
      b.onclick = () => this.player.bus.emit('back', {});
      top.appendChild(b);
    }
    const title = el('div', 'elf-title');
    title.textContent = cfg.title ?? '';
    top.appendChild(title);
    if (cfg.brand) top.appendChild(el('div', 'elf-brand', esc(String(cfg.brand))));
    shell.appendChild(top);

    /* quality HUD — top right, per reference */
    this.hud = el('div', 'elf-hud');
    this.hud.hidden = true;
    this.hudMode = el('span', 'elf-hud-mode', 'Quality: Auto');
    this.hudPill = el('span', 'elf-hud-pill', '');
    this.hud.append(this.hudMode, this.hudPill);
    shell.appendChild(this.hud);

    /* centre: flash + big play + spinner */
    const center = el('div', 'elf-center');
    this.flash = el('div', 'elf-flash', I.play);
    this.spinner = el('div', 'elf-spinner');
    this.bigPlay = el('button', 'elf-bigplay', I.play) as HTMLButtonElement;
    this.bigPlay.setAttribute('aria-label', 'Play');
    center.append(this.flash, this.spinner, this.bigPlay);
    shell.appendChild(center);

    this.toastEl = el('div', 'elf-toast');
    this.toastEl.dataset.show = 'false';
    shell.appendChild(this.toastEl);

    this.skipBtn = el('button', 'elf-skip');
    this.skipBtn.dataset.visible = 'false';
    shell.appendChild(this.skipBtn);

    /* scrubber */
    this.scrub = el('div', 'elf-scrub');
    this.scrub.setAttribute('role', 'slider');
    this.scrub.setAttribute('aria-label', 'Seek');
    this.scrub.tabIndex = 0;
    this.rail = el('div', 'elf-scrub-rail');
    this.buffered = el('div', 'elf-scrub-buffered');
    this.fill = el('div', 'elf-scrub-fill');
    this.knob = el('div', 'elf-scrub-knob');
    this.segLayer = el('div', 'elf-segments');
    this.tip = el('div', 'elf-scrub-tip');
    this.rail.append(this.buffered, this.fill, this.segLayer, this.knob);
    this.scrub.append(this.rail, this.tip);
    shell.appendChild(this.scrub);

    /* control bar */
    this.bar = el('div', 'elf-bar');
    this.playBtn = this.iconBtn(I.play, 'Play');
    this.back10 = this.iconBtn(I.back10, 'Back 10 seconds');
    this.fwd10 = this.iconBtn(I.fwd10, 'Forward 10 seconds');
    this.volBtn = this.iconBtn(I.vol, 'Mute');
    const volWrap = el('div', 'elf-vol-slider');
    this.volSlider = el('input') as HTMLInputElement;
    this.volSlider.type = 'range';
    this.volSlider.min = '0';
    this.volSlider.max = '1';
    this.volSlider.step = '0.02';
    this.volSlider.value = '1';
    this.volSlider.setAttribute('aria-label', 'Volume');
    volWrap.appendChild(this.volSlider);
    this.timeEl = el('div', 'elf-time', '0:00 / 0:00');

    this.audioBtn = this.iconBtn(I.phones, 'Audio');
    this.ccBtn = this.iconBtn(I.cc, 'Subtitles');
    this.gearBtn = this.iconBtn(I.gear, 'Settings');
    this.pipBtn = this.iconBtn(I.pip, 'Picture in picture');
    this.fsBtn = this.iconBtn(I.fs, 'Fullscreen');

    this.bar.append(
      this.playBtn, this.back10, this.fwd10, this.volBtn, volWrap, this.timeEl,
      el('div', 'elf-spacer'),
      this.audioBtn, this.ccBtn, this.gearBtn, this.pipBtn, this.fsBtn,
    );
    shell.appendChild(this.bar);

    /* settings panel */
    this.panel = el('div', 'elf-panel');
    this.panel.dataset.open = 'false';
    this.tabsEl = el('div', 'elf-tabs');
    this.panelBody = el('div', 'elf-panel-body');
    this.panel.append(this.tabsEl, this.panelBody);
    shell.appendChild(this.panel);
  }

  private iconBtn(icon: string, label: string): HTMLButtonElement {
    const b = el('button', 'elf-btn', icon) as HTMLButtonElement;
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  private wire(): void {
    const v = this.player.video;
    const shell = this.player.shell;
    const bus = this.player.bus;
    const step = Number(this.player.config.skipStep ?? 10);

    this.playBtn.onclick = () => this.player.toggle();
    this.bigPlay.onclick = () => this.player.toggle();
    this.back10.onclick = () => { this.player.skipBy(-step); this.flashIcon(I.back10); };
    this.fwd10.onclick = () => { this.player.skipBy(step); this.flashIcon(I.fwd10); };
    this.volBtn.onclick = () => this.player.setMuted(!v.muted);
    this.volSlider.oninput = () => this.player.setVolume(Number(this.volSlider.value));
    this.audioBtn.onclick = () => this.togglePanel('audio');
    this.ccBtn.onclick = () => this.togglePanel('subs');
    this.gearBtn.onclick = () => this.togglePanel(this.tab);
    this.pipBtn.onclick = () => void this.player.togglePip();
    this.fsBtn.onclick = () => void this.player.fullscreen(document.fullscreenElement !== shell);

    shell.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.elf-bar, .elf-panel, .elf-top, .elf-skip, .elf-scrub')) return;
      this.player.toggle();
    });

    shell.addEventListener('pointermove', () => this.showUI());
    shell.addEventListener('pointerdown', () => this.showUI());
    shell.addEventListener('pointerleave', () => this.scheduleHide());

    v.addEventListener('play', () => { shell.dataset.playing = 'true'; this.flashIcon(I.play); this.scheduleHide(); });
    v.addEventListener('pause', () => { shell.dataset.playing = 'false'; this.flashIcon(I.pause); this.showUI(); });
    v.addEventListener('waiting', () => (shell.dataset.buffering = 'true'));
    v.addEventListener('playing', () => (shell.dataset.buffering = 'false'));

    bus.on('qualityLevels', () => { this.syncCapabilities(); this.rebuildTabsIfOpen(); });
    bus.on('qualityEffective', (d) => this.syncHud(d as { mode?: string; height?: number }));
    bus.on('qualityChange', (d) => this.syncHud(d as { mode?: string; height?: number }));
    bus.on('audioTracks', () => { this.syncCapabilities(); this.rebuildTabsIfOpen(); });
    bus.on('audioChange', (d) => { this.rebuildTabsIfOpen(); this.showToast(`Audio · ${(d as { label?: string })?.label ?? ''}`); });
    bus.on('subtitleTracks', () => { this.syncCapabilities(); this.rebuildTabsIfOpen(); });
    bus.on('subtitleChange', () => { this.rebuildTabsIfOpen(); this.syncCc(); });
    bus.on('volumechange', (d) => this.syncVolume(d as { volume: number; muted: boolean }));
    bus.on('segments:invalidate', () => this.renderSegments());
    bus.on('durationchange', () => this.renderSegments());
    bus.on('server:switch', (d) => this.showToast(`Switched to ${(d as { to?: string })?.to ?? 'another server'}`));
    bus.on('autoplay:blocked', () => this.showToast('Tap to play with sound'));
    bus.on('error', (d) => this.showToast(`Error · ${(d as { code?: string })?.code ?? 'playback'}`));
    bus.on('episode:next', () => this.showToast('Loading next…'));
    bus.on('fullscreen', (d) => { this.fsBtn.innerHTML = (d as { on?: boolean })?.on ? I.fsExit : I.fs; });

    this.wireScrub();
    if (this.player.config.keyboard !== false) this.wireKeyboard();
  }

  /* ------------------------- capability sync ------------------------ */
  /** Hide anything the browser or the stream cannot offer. */
  private syncCapabilities(): void {
    const st = this.player.getState();
    const ql = this.player.getQualityLevels();
    const audio = this.player.getAudioTracks();
    const subs = this.player.getSubtitleTracks();

    this.hud.hidden = ql.length === 0;
    this.pipBtn.hidden = !st.canPip;
    this.fsBtn.hidden = !st.canFullscreen;
    this.audioBtn.hidden = audio.length < 2;
    this.ccBtn.hidden = subs.length === 0;

    const d = st.duration;
    const step = Number(this.player.config.skipStep ?? 10);
    const hideSkip = !Number.isFinite(d) || d <= step * 2;
    this.back10.hidden = hideSkip;
    this.fwd10.hidden = hideSkip;

    // A gear with nothing inside it is dead weight.
    this.gearBtn.hidden = ql.length === 0 && subs.length === 0 && audio.length < 2;

    this.syncHud();
    this.syncCc();
    this.syncVolume({ volume: st.volume, muted: st.muted });
  }

  private syncHud(d?: { mode?: string; height?: number }): void {
    const st = this.player.getState();
    const mode = d?.mode ?? st.qualityMode ?? 'auto';
    const eff = d?.height ?? st.effectiveHeight;
    const modeText = mode === 'auto' ? 'Auto' : `${mode}p`;
    if (modeText !== this.lastHudMode) {
      this.hudMode.textContent = `Quality: ${modeText}`;
      this.lastHudMode = modeText;
    }
    const pill = eff ? `${eff}p` : '';
    if (pill !== this.lastHudPill) {
      this.hudPill.textContent = pill;
      this.hudPill.hidden = !pill;
      this.lastHudPill = pill;
    }
  }

  private syncCc(): void {
    const st = this.player.getState();
    this.ccBtn.dataset.active = String(st.subtitlesOn && !!st.subtitleLang);
  }

  private syncVolume(d: { volume: number; muted: boolean }): void {
    this.volSlider.value = String(d.volume);
    this.volBtn.innerHTML = d.muted || d.volume === 0 ? I.mute : I.vol;
    this.volBtn.dataset.active = String(d.muted || d.volume === 0);
  }

  /* --------------------------- the rAF loop ------------------------- */

  private startLoop(): void {
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const v = this.player.video;
      const d = Number.isFinite(v.duration) ? v.duration : 0;

      const pct = d ? (v.currentTime / d) * 100 : 0;
      if (Math.abs(pct - this.lastPct) > 0.04) {
        this.lastPct = pct;
        if (!this.dragging) {
          this.fill.style.width = `${pct}%`;
          this.knob.style.left = `${pct}%`;
        }
      }

      if (d && v.buffered.length) {
        const bp = (v.buffered.end(v.buffered.length - 1) / d) * 100;
        if (Math.abs(bp - this.lastBufPct) > 0.25) {
          this.lastBufPct = bp;
          this.buffered.style.width = `${bp}%`;
        }
      }

      const str = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
      if (str !== this.lastTimeStr) {
        this.lastTimeStr = str;
        this.timeEl.textContent = str;
        this.scrub.setAttribute('aria-valuenow', String(Math.round(v.currentTime)));
      }

      this.updateSkip();
    };
    this.raf = requestAnimationFrame(tick);
  }

  /* ----------------------------- scrubber --------------------------- */

  private wireScrub(): void {
    const v = this.player.video;
    const ratio = (x: number) => {
      const r = this.scrub.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / (r.width || 1)));
    };
    const preview = (x: number) => {
      const p = ratio(x) * 100;
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      this.fill.style.width = `${p}%`;
      this.knob.style.left = `${p}%`;
      this.tip.style.left = `${p}%`;
      this.tip.textContent = fmtTime(ratio(x) * d);
    };

    this.scrub.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.scrub.dataset.dragging = 'true';
      this.scrub.setPointerCapture(e.pointerId);
      preview(e.clientX);
      e.preventDefault();
    });
    this.scrub.addEventListener('pointermove', (e) => {
      preview(e.clientX);
      if (this.dragging) this.player.seek(ratio(e.clientX) * (Number.isFinite(v.duration) ? v.duration : 0));
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      delete this.scrub.dataset.dragging;
      this.player.seek(ratio(e.clientX) * (Number.isFinite(v.duration) ? v.duration : 0));
    };
    this.scrub.addEventListener('pointerup', end);
    this.scrub.addEventListener('pointercancel', end);
    this.scrub.addEventListener('keydown', (e) => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      const step = Number(this.player.config.skipStep ?? 10);
      if (e.key === 'ArrowRight') this.player.skipBy(step);
      else if (e.key === 'ArrowLeft') this.player.skipBy(-step);
      else if (e.key === 'Home') this.player.seek(0);
      else if (e.key === 'End') this.player.seek(d);
      else return;
      e.preventDefault();
    });
  }

  private renderSegments(): void {
    const cfg = this.player.config;
    const d = Number.isFinite(this.player.video.duration) ? this.player.video.duration : 0;
    const ranges: { kind: string; start: number; end: number; label: string }[] = [];
    const read = (list?: { lang: string; url: string }[]) => {
      const first = list?.[0];
      if (!first) return null;
      const s = Number(first.lang);
      const e = Number(first.url);
      return Number.isFinite(s) && Number.isFinite(e) && e > s ? { start: s, end: e } : null;
    };
    const intro = read(cfg.intro as never);
    if (intro && d) ranges.push({ kind: 'intro', ...intro, label: 'Skip intro' });
    const outro = read(cfg.outro as never);
    if (outro && d) ranges.push({ kind: 'outro', ...outro, label: 'Skip outro' });

    this.segLayer.replaceChildren(
      ...ranges.map((r) => {
        const n = el('div', 'elf-segment');
        n.dataset.kind = r.kind;
        n.style.left = `${(r.start / d) * 100}%`;
        n.style.width = `${((r.end - r.start) / d) * 100}%`;
        n.title = r.label;
        return n;
      }),
    );
    this.skipBtn.dataset.range = ranges.length ? '1' : '';
    this.skipRanges = ranges;
  }
  private skipRanges: { kind: string; start: number; end: number; label: string }[] = [];

  private updateSkip(): void {
    const t = this.player.video.currentTime;
    const hit = this.skipRanges.find((r) => t >= r.start && t < r.end);
    const visible = !!hit;
    if (this.skipBtn.dataset.visible !== String(visible)) this.skipBtn.dataset.visible = String(visible);
    if (hit) {
      if (this.skipBtn.textContent !== hit.label) this.skipBtn.textContent = hit.label;
      this.skipBtn.onclick = () => this.player.seek(hit.end);
    }
  }

  /* ----------------------------- keyboard --------------------------- */

  private wireKeyboard(): void {
    const shell = this.player.shell;
    shell.tabIndex = 0;
    const step = Number(this.player.config.skipStep ?? 10);
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable) return;
      const v = this.player.video;
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      switch (e.key.toLowerCase()) {
        case ' ': case 'k': this.player.toggle(); break;
        case 'arrowright': case 'l': this.player.skipBy(step); this.flashIcon(I.fwd10); break;
        case 'arrowleft': case 'j': this.player.skipBy(-step); this.flashIcon(I.back10); break;
        case 'arrowup': this.player.setVolume(v.volume + 0.05); break;
        case 'arrowdown': this.player.setVolume(v.volume - 0.05); break;
        case 'm': this.player.setMuted(!v.muted); break;
        case 'f': void this.player.fullscreen(document.fullscreenElement !== shell); break;
        case 'c': void this.player.setSubtitle(this.player.getState().subtitleLang ? null : (this.player.getSubtitleTracks()[0]?.id ?? null)); break;
        case 's': this.togglePanel('subs'); break;
        case 'escape': if (this.panel.dataset.open === 'true') { this.closePanel(); return; } return;
        default:
          if (/^[0-9]$/.test(e.key) && d) this.player.seek((Number(e.key) / 10) * d);
          else return;
      }
      e.preventDefault();
      this.showUI();
    });
  }

  /* ------------------------- centre state flash --------------------- */

  private flashIcon(icon: string): void {
    this.flash.innerHTML = icon;
    this.flash.dataset.show = 'true';
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => (this.flash.dataset.show = 'false'), 520);
  }

  /* ------------------------------ panel ----------------------------- */

  private availableTabs(): { id: TabId; icon: string; label: string }[] {
    const tabs: { id: TabId; icon: string; label: string }[] = [];
    if (this.player.getQualityLevels().length) tabs.push({ id: 'quality', icon: I.bars, label: 'Quality' });
    if (this.player.getSubtitleTracks().length) tabs.push({ id: 'subs', icon: I.cc, label: 'Subtitles' });
    tabs.push({ id: 'speed', icon: I.gauge, label: 'Speed' });
    if (this.player.getAudioTracks().length > 1) tabs.push({ id: 'audio', icon: I.phones, label: 'Audio' });
    return tabs;
  }

  private togglePanel(target: TabId): void {
    if (this.panel.dataset.open === 'true' && this.tab === target) this.closePanel();
    else this.openPanel(target);
  }

  private openPanel(target: TabId): void {
    this.tab = this.availableTabs().some((t) => t.id === target) ? target : (this.availableTabs()[0]?.id ?? 'quality');
    this.panel.dataset.open = 'true';
    this.gearBtn.dataset.active = 'true';
    this.buildTabs();
    this.renderTab();
    this.showUI();
  }

  private closePanel(): void {
    this.panel.dataset.open = 'false';
    this.gearBtn.dataset.active = 'false';
    this.previewRenderer?.destroy();
    this.previewRenderer = null;
  }

  private rebuildTabsIfOpen(): void {
    if (this.panel.dataset.open !== 'true') return;
    if (!this.availableTabs().some((t) => t.id === this.tab)) this.tab = this.availableTabs()[0]?.id ?? 'quality';
    this.buildTabs();
    this.renderTab();
  }

  /** Tabs row is rebuilt only when membership changes; body swaps in place. */
  private buildTabs(): void {
    const tabs = this.availableTabs();
    const signature = tabs.map((t) => t.id).join(',');
    if (this.tabsEl.dataset.signature === signature && this.tab !== 'style') return;
    this.tabsEl.dataset.signature = signature;
    this.tabsEl.replaceChildren();

    for (const t of tabs) {
      const b = this.iconBtn(t.icon, t.label);
      b.dataset.tab = t.id;
      b.dataset.on = String(this.tab === t.id || (this.tab === 'style' && t.id === 'subs'));
      b.onclick = () => {
        this.tab = t.id;
        this.buildTabs();
        this.renderTab();
      };
      this.tabsEl.appendChild(b);
    }
    const close = this.iconBtn(I.close, 'Close settings');
    close.onclick = () => this.closePanel();
    this.tabsEl.appendChild(close);
  }

  private renderTab(): void {
    this.previewRenderer?.destroy();
    this.previewRenderer = null;
    this.panelBody.replaceChildren();
    switch (this.tab) {
      case 'quality': this.renderQuality(); break;
      case 'subs': this.renderSubs(); break;
      case 'style': this.renderStyle(); break;
      case 'speed': this.renderSpeed(); break;
      case 'audio': this.renderAudio(); break;
    }
    this.panelBody.scrollTop = 0;
  }

  private row(label: string, sub: string, selected: boolean, onClick: () => void) {
    const b = el('button', 'elf-menu-item');
    b.dataset.selected = String(selected);
    b.innerHTML = `<span class="elf-mi-check">${I.check}</span><span class="elf-mi-label">${esc(label)}${
      sub ? `<span class="elf-mi-sub"> · ${esc(sub)}</span>` : ''
    }</span>`;
    b.onclick = onClick;
    return b;
  }

  private renderQuality(): void {
    const st = this.player.getState();
    this.panelBody.appendChild(this.row('Auto', st.effectiveHeight ? `${st.effectiveHeight}p` : 'recommended', st.qualityMode === 'auto', () => {
      this.player.setQuality('auto');
      this.renderTab();
    }));
    for (const l of this.player.getQualityLevels()) {
      this.panelBody.appendChild(
        this.row(l.label, `${Math.round(l.bitrate / 1000)} kbps`, st.qualityMode === String(l.height), () => {
          this.player.setQuality(l.height);
          this.renderTab();
        }),
      );
    }
  }

  private renderSubs(): void {
    const st = this.player.getState();
    this.panelBody.appendChild(this.row('Off', '', !st.subtitleLang, () => { void this.player.setSubtitle(null); this.renderTab(); }));
    for (const t of this.player.getSubtitleTracks()) {
      this.panelBody.appendChild(
        this.row(t.label, t.kind === 'external' ? 'external' : 'in stream', t.lang === st.subtitleLang, () => {
          void this.player.setSubtitle(t.id);
          this.renderTab();
        }),
      );
    }
    const style = el('button', 'elf-menu-item');
    style.innerHTML = `<span class="elf-mi-label">Customise style<span class="elf-mi-sub"> · colour · size · font · position · transparency</span></span>`;
    style.onclick = () => { this.tab = 'style'; this.buildTabs(); this.renderTab(); };
    this.panelBody.appendChild(style);
  }

  private renderAudio(): void {
    const st = this.player.getState();
    const tracks: AudioTrack[] = this.player.getAudioTracks();
    for (const t of tracks) {
      this.panelBody.appendChild(
        this.row(t.label, t.kind === 'external' ? 'external dub' : 'in stream', t.lang === st.audioLang, () => {
          void this.player.setAudio(t.id);
        }),
      );
    }
  }

  private renderSpeed(): void {
    const st = this.player.getState();
    for (const s of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      this.panelBody.appendChild(this.row(`${s}×`, s === 1 ? 'normal' : '', s === st.speed, () => {
        this.player.setSpeed(s);
        this.renderTab();
      }));
    }
  }

  /* ---------------------- subtitle style editor --------------------- */

  private renderStyle(): void {
    const style = this.player.getSubtitleStyle();

    const back = el('button', 'elf-style-back', `${I.back} Customise style`);
    back.onclick = () => { this.tab = 'subs'; this.buildTabs(); this.renderTab(); };
    this.panelBody.appendChild(back);

    const preview = el('div', 'elf-sub-preview');
    this.panelBody.appendChild(preview);
    this.previewRenderer = new SubtitleRenderer({ host: preview, baselineHeight: 720 }, style);
    this.previewRenderer.bindClock(() => 1.5);
    this.previewRenderer.setCues([
      { id: 'p', start: 0, end: 9999, spans: [{ text: 'The quick brown fox' }, { text: '\njumps over the lazy dog', italic: true }], text: 'preview' },
    ]);

    const live = (patch: Partial<SubtitleStyle>) => {
      this.previewRenderer?.setStyle(patch, { silent: true });
      this.player.setSubtitleStyle(patch);
    };

    this.label('Colour & transparency');
    this.panelBody.appendChild(this.color('Text colour', style.color, (c) => live({ color: c })));
    this.panelBody.appendChild(this.slider('Text transparency', opacityToTransparency(style.textOpacity), 0, 100, 1, '%', (v) => live({ textOpacity: transparencyToOpacity(v) })));
    this.panelBody.appendChild(this.color('Background colour', style.backgroundColor, (c) => live({ backgroundColor: c })));
    this.panelBody.appendChild(this.slider('Background transparency', opacityToTransparency(style.backgroundOpacity), 0, 100, 1, '%', (v) => live({ backgroundOpacity: transparencyToOpacity(v) })));

    this.label('Font');
    this.panelBody.appendChild(this.select('Font family', FONT_CHOICES.map((f) => ({ value: f.value, label: f.label })), style.fontFamily, (v) => live({ fontFamily: v })));
    this.panelBody.appendChild(this.slider('Size', style.fontSizePct, 40, 220, 1, '%', (v) => live({ fontSizePct: v })));
    this.panelBody.appendChild(this.segmented('Weight', [
      { value: 400, label: 'Reg' }, { value: 500, label: 'Med' }, { value: 600, label: 'Semi' }, { value: 700, label: 'Bold' }, { value: 800, label: 'Xtra' },
    ], style.fontWeight, (v) => live({ fontWeight: v })));
    this.panelBody.appendChild(this.toggle('Italic', style.italic, (v) => live({ italic: v })));
    this.panelBody.appendChild(this.toggle('UPPERCASE', style.uppercase, (v) => live({ uppercase: v })));
    this.panelBody.appendChild(this.slider('Letter spacing', style.letterSpacingEm, -0.05, 0.4, 0.005, 'em', (v) => live({ letterSpacingEm: v })));

    this.label('Legibility');
    this.panelBody.appendChild(this.toggle('Outline', style.outline, (v) => live({ outline: v })));
    if (style.outline) {
      this.panelBody.appendChild(this.color('Outline colour', style.outlineColor, (c) => live({ outlineColor: c })));
      this.panelBody.appendChild(this.slider('Outline width', style.outlineWidth, 0, 4, 0.5, 'px', (v) => live({ outlineWidth: v })));
    }
    this.panelBody.appendChild(this.toggle('Drop shadow', style.shadow, (v) => live({ shadow: v })));
    if (style.shadow) this.panelBody.appendChild(this.slider('Shadow blur', style.shadowBlur, 0, 12, 1, 'px', (v) => live({ shadowBlur: v })));

    this.label('Box');
    this.panelBody.appendChild(this.slider('Padding', style.paddingPx, 0, 24, 1, 'px', (v) => live({ paddingPx: v })));
    this.panelBody.appendChild(this.slider('Corner radius', style.radiusPx, 0, 24, 1, 'px', (v) => live({ radiusPx: v })));
    this.panelBody.appendChild(this.slider('Max width', style.maxWidthPct, 40, 100, 1, '%', (v) => live({ maxWidthPct: v })));

    this.label('Position');
    this.panelBody.appendChild(this.segmented('Edge', [
      { value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' },
    ], style.edge, (v) => live({ edge: v as SubtitleStyle['edge'] })));
    this.panelBody.appendChild(this.slider('Distance from edge', style.verticalPct, 0, 45, 1, '%', (v) => live({ verticalPct: v })));
    this.panelBody.appendChild(this.segmented('Align', [
      { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' },
    ], style.horizontalAlign, (v) => live({ horizontalAlign: v as SubtitleStyle['horizontalAlign'] })));
    this.panelBody.appendChild(this.slider('Horizontal nudge', style.horizontalPct, -40, 40, 1, '%', (v) => live({ horizontalPct: v })));

    const hint = el('div', 'elf-hint', 'Tip: drag the captions on the video to reposition them.');
    this.panelBody.appendChild(hint);

    const actions = el('div', 'elf-panel-actions');
    const reset = el('button', '', 'Reset');
    reset.onclick = () => { this.player.resetSubtitleStyle(); this.renderTab(); };
    const done = el('button', '', 'Done');
    done.dataset.primary = 'true';
    done.onclick = () => this.closePanel();
    actions.append(reset, done);
    this.panelBody.appendChild(actions);
  }

  /* --------------------------- field helpers ------------------------ */

  private label(text: string): void {
    this.panelBody.appendChild(el('div', 'elf-section-label', esc(text)));
  }

  private slider(label: string, value: number, min: number, max: number, step: number, unit: string, onChange: (v: number) => void) {
    const wrap = el('div', 'elf-field');
    const head = el('div', 'elf-field-head');
    head.append(el('span', 'elf-field-label', esc(label)));
    const out = el('span', 'elf-field-value', `${trim(value)}${unit}`);
    head.appendChild(out);
    const input = el('input') as HTMLInputElement;
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    input.oninput = () => {
      const v = Number(input.value);
      out.textContent = `${trim(v)}${unit}`;
      onChange(v);
    };
    wrap.append(head, input);
    return wrap;
  }

  private toggle(label: string, value: boolean, onChange: (v: boolean) => void) {
    const row = el('div', 'elf-toggle-row');
    row.appendChild(el('span', '', esc(label)));
    const sw = el('label', 'elf-switch');
    const input = el('input') as HTMLInputElement;
    input.type = 'checkbox';
    input.checked = value;
    input.onchange = () => onChange(input.checked);
    sw.append(input, el('i'));
    row.appendChild(sw);
    return row;
  }

  private segmented<T extends string | number>(label: string, opts: { value: T; label: string }[], value: T, onChange: (v: T) => void) {
    const wrap = el('div', 'elf-field');
    wrap.appendChild(el('div', 'elf-field-head', `<span class="elf-field-label">${esc(label)}</span>`));
    const group = el('div', 'elf-seg-group');
    for (const o of opts) {
      const b = el('button', '', esc(o.label));
      b.dataset.on = String(o.value === value);
      b.onclick = () => {
        group.querySelectorAll('button').forEach((x) => (x.dataset.on = 'false'));
        b.dataset.on = 'true';
        onChange(o.value);
      };
      group.appendChild(b);
    }
    wrap.appendChild(group);
    return wrap;
  }

  private color(label: string, value: string, onChange: (hex: string) => void) {
    const row = el('div', 'elf-color-row');
    row.appendChild(el('label', '', esc(label)));
    const input = el('input') as HTMLInputElement;
    input.type = 'color';
    input.value = value;
    input.oninput = () => onChange(input.value);
    row.appendChild(input);
    return row;
  }

  private select(label: string, opts: { value: string; label: string }[], value: string, onChange: (v: string) => void) {
    const wrap = el('div', 'elf-field');
    wrap.appendChild(el('div', 'elf-field-head', `<span class="elf-field-label">${esc(label)}</span>`));
    const sel = el('select') as HTMLSelectElement;
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      opt.selected = o.value === value;
      sel.appendChild(opt);
    }
    sel.onchange = () => onChange(sel.value);
    wrap.appendChild(sel);
    return wrap;
  }

  /* ------------------------------ misc ------------------------------ */

  private showUI(): void {
    this.player.shell.dataset.ui = 'visible';
    this.scheduleHide();
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    if (this.player.video.paused || this.panel.dataset.open === 'true') return;
    this.hideTimer = window.setTimeout(() => {
      if (this.player.video.paused || this.panel.dataset.open === 'true') return;
      this.player.shell.dataset.ui = 'hidden';
    }, 2600);
  }

  showToast(msg: string, ms = 2200): void {
    this.toastEl.textContent = msg;
    this.toastEl.dataset.show = 'true';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.dataset.show = 'false'), ms);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hideTimer);
    clearTimeout(this.toastTimer);
    clearTimeout(this.flashTimer);
    this.previewRenderer?.destroy();
  }
}

const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
