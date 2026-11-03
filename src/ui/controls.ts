/**
 * Elfura Player — Cinema OTT Chrome (Part 1 UI)
 * =============================================
 * Clean cinema-grade OTT interface combining:
 *   - Persistent top-left brand badge (`[ TV-Logo  TheOGPirateBot ]`) using the
 *     exact `icon-maskable-512` mark: 100% opacity when started or paused,
 *     fading smoothly to a subtle watermark while playing; stays on top even
 *     when player controls hide.
 *   - `<- Back` pill button on top-left ONLY when player UI is visible (never
 *     when UI is off; no Home button clutter).
 *   - Top episode text (`S1 · E1 — Episode Name`) for TV series when UI is on
 *     (no duplicate top title logo).
 *   - Title Logo (with playful cartoony display-font fallback when TMDB has no
 *     logo) + compact `Movie · Genre · Year` metadata above the seekbar when
 *     controls are visible.
 *   - Cinema Paused Screen when paused: dark vignette, large Title Logo (or
 *     cartoony title fallback), `PAUSED`, italic `"Tagline"`, `Year • ★ Rating`,
 *     and synopsis paragraph.
 *   - Top-right `Quality`, unified side-by-side `Audio & Subtitles`, and
 *     `Screen Lock`; Hotstar-style 5-second bottom language selector; inline
 *     capsule-thumb seekbar; animated Play/Pause & 4-corner Fullscreen; left/
 *     right double-tap 10s skip; press-and-hold for 2× speed; zero center skip
 *     clutter.
 *
 * Strictly zero hardcoded audio tracks or static language lists.
 */

import type { ElfuraPlayer, TitleMediaInfo } from '../core/player';
import type { SubtitleStyle } from '../subs/style';
import { FONT_CHOICES, opacityToTransparency, transparencyToOpacity } from '../subs/style';
import type { AudioTrack } from '../core/audio';
import { SubtitleRenderer } from '../subs/renderer';

/* ---------------------------------------------------------------------- */
/* Brand Mark (`icon-maskable-512.png`, lossless 64x64 RGBA, 377 bytes)   */
/* ---------------------------------------------------------------------- */

const BRAND_ICON_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABQElEQVR42u3bMW7CQBCFYSf0zg3ScACEuAARUqBC3AIiUTmgdLlBjpGOinNwCwo6SqjQMEix5MKJbbyzsdb/SK+zrH2fLHuLdSQiUZsTAQAAAC4Te1h03FSArmavSQzLjzVHzahpAGn5dBKj8uef+59cIViUt0DIlheXCHUX9vRLeZcIeeWzCL3/fgLW8vckRuVv863pNOEdYIFgXt71V8AlwquP8hb7ABcI3spb7QTrIHgtb7kVvgfBe/kigIHmrUZ2BQhfmWs/CsofNMsaa5loHqsAfEp4s81DyCv/rLlImDMrAzCUcOe9DMBLwAArAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACA1p8SC/mc4FRafFJ0o3mQCmeF+5q5ZhFARnnlhR8nAQCg9QBXIzKsKaB4oWUAAAAASUVORK5CYII=';

const DEFAULT_BRAND_NAME = 'TheOGPirateBot';

/* ---------------------------------------------------------------------- */
/* Crisp Reference Icons (SVG strings built once, zero hot-path overhead) */
/* ---------------------------------------------------------------------- */

const skipBarSvg = (dir: 'back' | 'fwd', step: number) =>
  dir === 'back'
    ? `<span class="elf-skip10-inner" data-dir="back"><svg class="elf-skip10-chev" viewBox="0 0 20 20" fill="none"><path d="M10.8 4.5 5.3 10l5.5 5.5M16.2 4.5 10.7 10l5.5 5.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="elf-skip10-num">${step}</span></span>`
    : `<span class="elf-skip10-inner" data-dir="fwd"><span class="elf-skip10-num">${step}</span><svg class="elf-skip10-chev" viewBox="0 0 20 20" fill="none"><path d="M3.8 4.5 9.3 10l-5.5 5.5M9.2 4.5 14.7 10l-5.5 5.5" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

const PLAY_PAUSE_MORPH_SVG = `
<svg class="elf-pp-svg" viewBox="0 0 24 24" aria-hidden="true">
  <g class="elf-pp-play">
    <path d="M7.2 4.6c0-1 .9-1.6 1.8-1.1l11.4 7.4c.8.5.8 1.7 0 2.2L9 20.5c-.9.5-1.8-.1-1.8-1.1V4.6z" fill="currentColor"/>
  </g>
  <g class="elf-pp-pause">
    <rect x="6" y="4" width="4.4" height="16" rx="1.5" fill="currentColor"/>
    <rect x="13.6" y="4" width="4.4" height="16" rx="1.5" fill="currentColor"/>
  </g>
</svg>`;

const FULLSCREEN_ANIM_SVG = `
<svg class="elf-fs-svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path class="elf-fs-c elf-fs-tl" d="M4 9V4h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="elf-fs-c elf-fs-tr" d="M20 9V4h-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="elf-fs-c elf-fs-bl" d="M4 15v5h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="elf-fs-c elf-fs-br" d="M20 15v5h-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const I = {
  playSolid:
    '<svg viewBox="0 0 24 24"><path d="M7.5 4.8c0-1 .9-1.6 1.8-1.1l11.2 7.2c.8.5.8 1.7 0 2.2L9.3 20.3c-.9.5-1.8-.1-1.8-1.1V4.8z" fill="currentColor"/></svg>',
  pauseSolid:
    '<svg viewBox="0 0 24 24"><rect x="6.2" y="4.2" width="4.3" height="15.6" rx="1.4" fill="currentColor"/><rect x="13.5" y="4.2" width="4.3" height="15.6" rx="1.4" fill="currentColor"/></svg>',
  volHigh:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M11 5 6.5 8.8H3.8a1 1 0 0 0-1 1v4.4a1 1 0 0 0 1 1h2.7L11 19V5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path class="elf-vol-w1" d="M15.2 9.2a4.2 4.2 0 0 1 0 5.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path class="elf-vol-w2" d="M18.2 6.6a7.8 7.8 0 0 1 0 10.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  volMute:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M11 5 6.5 8.8H3.8a1 1 0 0 0-1 1v4.4a1 1 0 0 0 1 1h2.7L11 19V5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m15.5 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  qualityTv:
    '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="12.5" rx="2.4" stroke="currentColor" stroke-width="2"/><path d="M8.5 20h7M12 16.5V20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.4 8.1v4.3l3.7-2.15-3.7-2.15z" fill="currentColor"/></svg>',
  audioSubsBox:
    '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4.5" width="18" height="15" rx="2.8" stroke="currentColor" stroke-width="2"/><path d="M7 10h3.2M13 10h4M7 14h6.2M15.8 14H17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  pip:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M21 11V6.8A2.3 2.3 0 0 0 18.7 4.5H5.3A2.3 2.3 0 0 0 3 6.8v10.4a2.3 2.3 0 0 0 2.3 2.3H11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="13" y="13" width="8" height="6.5" rx="1.6" stroke="currentColor" stroke-width="2"/></svg>',
  lockOpen:
    '<svg viewBox="0 0 24 24" fill="none"><rect x="4.5" y="10.5" width="15" height="10" rx="2.4" stroke="currentColor" stroke-width="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 6.7-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  lockClosed:
    '<svg viewBox="0 0 24 24" fill="none"><rect x="4.5" y="10.5" width="15" height="10" rx="2.4" stroke="currentColor" stroke-width="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  layers:
    '<svg viewBox="0 0 24 24" fill="none"><path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4zm-8.5 8.5L12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gauge:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M4.8 18a9 9 0 1 1 14.4 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m12 13 4-4" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><circle cx="12" cy="13" r="1.6" fill="currentColor"/></svg>',
  langSpark:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M4 6h10M9 4v2m3.5 0c-.5 4.2-3 7.6-6.8 9.6M6.8 9.5c1.3 2.2 3.4 4.2 6.2 5.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="m13.5 19.5 3.3-8.5 3.3 8.5M14.7 17h4.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  back:
    '<svg viewBox="0 0 24 24" fill="none"><path d="M19 12H5m6-6-6 6 6 6" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  star:
    '<svg viewBox="0 0 24 24"><path d="m12 2.6 2.84 5.76 6.36.92-4.6 4.48 1.09 6.33L12 17.1l-5.69 2.99 1.09-6.33-4.6-4.48 6.36-.92L12 2.6z" fill="currentColor"/></svg>',
  doubleChevRight:
    '<svg viewBox="0 0 24 24" fill="none"><path class="elf-c1" d="m6 7 5 5-5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path class="elf-c2" d="m13 7 5 5-5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  doubleChevLeft:
    '<svg viewBox="0 0 24 24" fill="none"><path class="elf-c2" d="m18 7-5 5 5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path class="elf-c1" d="m11 7-5 5 5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

type PanelMode = 'audiosubs' | 'quality' | 'sources' | 'speed' | 'style';

interface DisplayMedia {
  mediaType: 'movie' | 'tv';
  mainTitle: string;
  season?: number;
  episode?: number;
  episodeName: string;
  year: string;
  tagline: string;
  rating: number | null;
  genres: string[];
  overview: string;
  logo: string | null;
}

export class PlayerUI {
  private player: ElfuraPlayer;

  /* Persistent top-left Brand + UI-only Back + TV Episode bar */
  private topBrandCluster!: HTMLElement;
  private backPillBtn!: HTMLButtonElement;
  private brandPill!: HTMLElement;
  private brandTextEl!: HTMLElement;
  private topEpisodeEl!: HTMLElement;
  private startWindowTimer = 0;

  /* Top-right chrome (visible only when UI is on) */
  private topEl!: HTMLElement;
  private qualityTopBtn!: HTMLButtonElement;
  private qualitySubText!: HTMLElement;
  private audioSubsTopBtn!: HTMLButtonElement;
  private lockBtn!: HTMLButtonElement;

  /* Cinema Paused Screen (Image 3 layout) */
  private pauseScreen!: HTMLElement;
  private pauseTitleSlot!: HTMLElement;
  private pauseTaglineEl!: HTMLElement;
  private pauseFactsEl!: HTMLElement;
  private pauseOverviewEl!: HTMLElement;
  private pauseIdleTimer = 0;
  private hasStartedPlayback = false;
  private failedLogoUrl = '';

  /* Locked-state floating unlock pill */
  private unlockPill!: HTMLButtonElement;
  private locked = false;
  private lockPeekTimer = 0;

  /* Center & gesture overlays (NO center -10/+10 buttons!) */
  private flash!: HTMLElement;
  private bigPlay!: HTMLButtonElement;
  private spinner!: HTMLElement;
  private speedHoldBadge!: HTMLElement;
  private dtapLeftEl!: HTMLElement;
  private dtapLeftText!: HTMLElement;
  private dtapRightEl!: HTMLElement;
  private dtapRightText!: HTMLElement;
  private toastEl!: HTMLElement;
  private skipBtn!: HTMLButtonElement;

  /* Bottom dock: Title Logo / Cartoony Title + Submeta (left) & Source Pill (right) */
  private dockIdentityEl!: HTMLElement;
  private dockLogoSlot!: HTMLElement;
  private dockSubmetaEl!: HTMLElement;
  private sourceSwitchWrap!: HTMLElement;

  /* Hotstar-style bottom language selector (shows in first 5 seconds) */
  private hotstarBar!: HTMLElement;
  private hotstarPills!: HTMLElement;
  private hotstarTimer = 0;
  private hotstarShownForTitle = false;
  private hotstarDismissed = false;

  /* Inline timeline row (`0:09 [====|----] 1:33:49`) */
  private timelineRow!: HTMLElement;
  private curTimeEl!: HTMLElement;
  private durTimeEl!: HTMLElement;
  private scrub!: HTMLElement;
  private rail!: HTMLElement;
  private fill!: HTMLElement;
  private buffered!: HTMLElement;
  private knob!: HTMLElement;
  private tip!: HTMLElement;
  private segLayer!: HTMLElement;

  /* Bottom control bar */
  private bar!: HTMLElement;
  private back10!: HTMLButtonElement;
  private playBtn!: HTMLButtonElement;
  private fwd10!: HTMLButtonElement;
  private volBtn!: HTMLButtonElement;
  private volSlider!: HTMLInputElement;
  private speedBtn!: HTMLButtonElement;
  private pipBtn!: HTMLButtonElement;
  private fsBtn!: HTMLButtonElement;

  /* Unified overlay sheet / panel */
  private panelBackdrop!: HTMLElement;
  private panel!: HTMLElement;
  private panelHeaderTitle!: HTMLElement;
  private panelTabsEl!: HTMLElement;
  private panelBody!: HTMLElement;
  private previewRenderer: SubtitleRenderer | null = null;
  private panelMode: PanelMode = 'audiosubs';

  /* Timers & state */
  private raf = 0;
  private hideTimer = 0;
  private toastTimer = 0;
  private toastWarnUntil = 0;
  private searchingTimer = 0;
  private hasRenderedAudioSelection = false;
  private flashTimer = 0;
  private dragging = false;

  /* Gesture state (double-tap 10s + hold for 2x) */
  private tapCount = 0;
  private tapZone: 'left' | 'center' | 'right' | null = null;
  private singleTapTimer = 0;
  private dtapAccumSec = 0;
  private dtapResetTimer = 0;
  private dtapHideLeftTimer = 0;
  private dtapHideRightTimer = 0;
  private holdTimer = 0;
  private holdActive = false;
  private holdSavedSpeed = 1;
  private pointerDownPos: { x: number; y: number; id: number; pointerType: string } | null = null;
  private suppressClickUntil = 0;

  /* Cached DOM writes for zero-jank rAF loop */
  private lastPct = -1;
  private lastBufPct = -1;
  private lastCurStr = '';
  private lastDurStr = '';
  private lastQualitySummary = '';
  private lastSourceSig = '';
  private lastMediaSig = '';
  private skipRanges: { kind: string; start: number; end: number; label: string }[] = [];

  constructor(player: ElfuraPlayer) {
    this.player = player;
    this.build();
    this.wire();
    this.syncMediaMetadata();
    this.syncCapabilities();
    this.showUI();
    this.startLoop();
  }

  /* ------------------------------------------------------------------ */
  /* Build DOM Once                                                      */
  /* ------------------------------------------------------------------ */

  private build(): void {
    const shell = this.player.shell;
    const cfg = this.player.config;
    shell.dataset.controls = String(cfg.controls !== false);
    shell.dataset.playing = 'false';
    shell.dataset.fullscreen = 'false';
    shell.dataset.locked = 'false';
    shell.dataset.pauseScreen = 'false';
    // At initial load ("started"), brand badge opacity is 100%!
    shell.dataset.brandFull = 'true';

    /* 1A. Persistent Top-Left Cluster:
           - `[ <- Back ]` pill (shown ONLY when player UI is visible)
           - `[ TV-Logo  TheOGPirateBot ]` pill (STAYS ON TOP even when UI is off;
             100% opacity when started or paused, fades while playing!)
           - `S1 · E1 — Episode Name` for TV series (shown ONLY when UI is visible;
             never shows a duplicate top title logo). */
    this.topBrandCluster = el('div', 'elf-brand-cluster');

    this.backPillBtn = el(
      'button',
      'elf-pill-back',
      `<span class="elf-pill-back-ico">${I.back}</span><span>Back</span>`,
    ) as HTMLButtonElement;
    this.backPillBtn.title = 'Back';
    this.backPillBtn.setAttribute('aria-label', 'Back');
    this.backPillBtn.hidden = cfg.back === false;

    this.brandPill = el('div', 'elf-og-pill');
    const brandIconWrap = el('span', 'elf-og-icon-box');
    const brandImg = document.createElement('img');
    brandImg.src = BRAND_ICON_URI;
    brandImg.alt = '';
    brandImg.decoding = 'async';
    brandIconWrap.appendChild(brandImg);

    this.brandTextEl = el('span', 'elf-og-name');
    this.brandTextEl.textContent = String(cfg.brand || DEFAULT_BRAND_NAME);
    this.brandPill.append(brandIconWrap, this.brandTextEl);

    this.topEpisodeEl = el('div', 'elf-top-episode');
    this.topEpisodeEl.hidden = true;

    this.topBrandCluster.append(this.backPillBtn, this.brandPill, this.topEpisodeEl);
    shell.appendChild(this.topBrandCluster);

    /* 1B. Top-Right Chrome Bar (`Quality` + `Audio & Subtitles` + `Screen Lock`) */
    this.topEl = el('div', 'elf-top');
    const topSpacer = el('div', 'elf-top-spacer');
    const topRight = el('div', 'elf-top-actions');

    this.qualityTopBtn = el('button', 'elf-top-btn elf-quality-trigger') as HTMLButtonElement;
    this.qualityTopBtn.setAttribute('aria-label', 'Quality');
    const qIcon = el('span', 'elf-top-icon', I.qualityTv);
    const qLabel = el('span', 'elf-top-label', 'Quality');
    this.qualitySubText = el('span', 'elf-top-meta', 'Auto');
    this.qualityTopBtn.append(qIcon, qLabel, this.qualitySubText);

    this.audioSubsTopBtn = el('button', 'elf-top-btn elf-audiosubs-trigger') as HTMLButtonElement;
    this.audioSubsTopBtn.setAttribute('aria-label', 'Audio and Subtitles');
    this.audioSubsTopBtn.append(
      el('span', 'elf-top-icon', I.audioSubsBox),
      el('span', 'elf-top-label', 'Audio & Subtitles'),
    );

    this.lockBtn = el('button', 'elf-top-btn elf-lock-trigger') as HTMLButtonElement;
    this.lockBtn.title = 'Lock screen';
    this.lockBtn.setAttribute('aria-label', 'Lock controls');
    this.lockBtn.appendChild(el('span', 'elf-top-icon', I.lockOpen));

    topRight.append(this.qualityTopBtn, this.audioSubsTopBtn, this.lockBtn);
    this.topEl.append(topSpacer, topRight);
    shell.appendChild(this.topEl);

    /* 2. Cinema Paused Screen (exact clean layout from reference screenshot) */
    this.pauseScreen = el('div', 'elf-pause-screen');
    const pauseCard = el('div', 'elf-pause-card');
    this.pauseTitleSlot = el('div', 'elf-pause-title-slot');
    const pauseWord = el('div', 'elf-pause-word', 'PAUSED');
    this.pauseTaglineEl = el('div', 'elf-pause-tagline');
    this.pauseFactsEl = el('div', 'elf-pause-facts');
    this.pauseOverviewEl = el('p', 'elf-pause-overview');
    pauseCard.append(
      this.pauseTitleSlot,
      pauseWord,
      this.pauseTaglineEl,
      this.pauseFactsEl,
      this.pauseOverviewEl,
    );
    this.pauseScreen.appendChild(pauseCard);
    shell.appendChild(this.pauseScreen);

    /* 3. Screen-Lock floating unlock pill (only shown when locked) */
    this.unlockPill = el(
      'button',
      'elf-unlock-pill',
      `<span class="elf-unlock-ico">${I.lockClosed}</span><span>Screen Locked · Tap to Unlock</span>`,
    ) as HTMLButtonElement;
    this.unlockPill.dataset.show = 'false';
    shell.appendChild(this.unlockPill);

    /* 4. Hold-for-2x floating badge */
    this.speedHoldBadge = el(
      'div',
      'elf-hold2x-pill',
      `<span>2× Speed</span><span class="elf-hold2x-chevs">${I.doubleChevRight}</span>`,
    );
    this.speedHoldBadge.dataset.show = 'false';
    shell.appendChild(this.speedHoldBadge);

    /* 5. Double-tap left / right animated ripple zones */
    this.dtapLeftEl = el('div', 'elf-dtap-zone elf-dtap-left');
    this.dtapLeftEl.dataset.show = 'false';
    this.dtapLeftText = el('div', 'elf-dtap-label', '10s');
    this.dtapLeftEl.append(
      el('div', 'elf-dtap-ripple'),
      el('div', 'elf-dtap-content', `<span class="elf-dtap-chevs">${I.doubleChevLeft}</span>`),
    );
    this.dtapLeftEl.querySelector('.elf-dtap-content')!.appendChild(this.dtapLeftText);

    this.dtapRightEl = el('div', 'elf-dtap-zone elf-dtap-right');
    this.dtapRightEl.dataset.show = 'false';
    this.dtapRightText = el('div', 'elf-dtap-label', '10s');
    const rightContent = el('div', 'elf-dtap-content');
    rightContent.append(this.dtapRightText, el('span', 'elf-dtap-chevs', I.doubleChevRight));
    this.dtapRightEl.append(el('div', 'elf-dtap-ripple'), rightContent);

    shell.append(this.dtapLeftEl, this.dtapRightEl);

    /* 6. Center layer: subtle state flash + buffering ring + initial play (NO center -10/+10!) */
    const center = el('div', 'elf-center');
    this.flash = el('div', 'elf-flash', I.playSolid);
    this.spinner = el('div', 'elf-spinner');
    this.bigPlay = el('button', 'elf-bigplay', I.playSolid) as HTMLButtonElement;
    this.bigPlay.setAttribute('aria-label', 'Play');
    center.append(this.flash, this.spinner, this.bigPlay);
    shell.appendChild(center);

    /* 7. Toast & Intro/Outro skip pill */
    this.toastEl = el('div', 'elf-toast');
    this.toastEl.dataset.show = 'false';
    shell.appendChild(this.toastEl);

    this.skipBtn = el('button', 'elf-skip') as HTMLButtonElement;
    this.skipBtn.dataset.visible = 'false';
    shell.appendChild(this.skipBtn);

    /* 8. Hotstar-style bottom language selector pill bar (first 5 seconds) */
    this.hotstarBar = el('div', 'elf-hotstar-lang');
    this.hotstarBar.dataset.show = 'false';
    const hsTag = el('span', 'elf-hotstar-tag', `${I.langSpark}<span>Audio</span>`);
    this.hotstarPills = el('div', 'elf-hotstar-pills');
    const hsClose = el('button', 'elf-hotstar-close', I.close) as HTMLButtonElement;
    hsClose.setAttribute('aria-label', 'Dismiss language bar');
    hsClose.onclick = (e) => {
      e.stopPropagation();
      this.dismissHotstarBar(true);
    };
    this.hotstarBar.append(hsTag, this.hotstarPills, hsClose);
    shell.appendChild(this.hotstarBar);

    /* 9. Bottom dock: [Title Logo / Cartoony Title + Submeta | Source Pill] + Inline Timeline + Control Bar */
    const bottomDock = el('div', 'elf-bottom-dock');

    const dockUpper = el('div', 'elf-dock-upper');
    this.dockIdentityEl = el('div', 'elf-dock-identity');
    this.dockLogoSlot = el('div', 'elf-dock-logo-slot');
    this.dockSubmetaEl = el('div', 'elf-dock-submeta');
    this.dockIdentityEl.append(this.dockLogoSlot, this.dockSubmetaEl);

    this.sourceSwitchWrap = el('div', 'elf-source-row');
    this.sourceSwitchWrap.hidden = true;
    dockUpper.append(this.dockIdentityEl, this.sourceSwitchWrap);
    bottomDock.appendChild(dockUpper);

    this.timelineRow = el('div', 'elf-timeline-row');
    this.curTimeEl = el('span', 'elf-time-inline elf-time-cur', '0:00');
    this.durTimeEl = el('span', 'elf-time-inline elf-time-dur', '0:00');

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

    this.timelineRow.append(this.curTimeEl, this.scrub, this.durTimeEl);
    bottomDock.appendChild(this.timelineRow);

    const step = Number(cfg.skipStep ?? 10);
    this.bar = el('div', 'elf-bar');

    this.back10 = el('button', 'elf-btn elf-skip10-btn', skipBarSvg('back', step)) as HTMLButtonElement;
    this.back10.title = `Rewind ${step} seconds`;
    this.back10.setAttribute('aria-label', `Rewind ${step} seconds`);

    this.playBtn = el('button', 'elf-btn elf-play-btn', PLAY_PAUSE_MORPH_SVG) as HTMLButtonElement;
    this.playBtn.title = 'Play / Pause';
    this.playBtn.setAttribute('aria-label', 'Play');

    this.fwd10 = el('button', 'elf-btn elf-skip10-btn', skipBarSvg('fwd', step)) as HTMLButtonElement;
    this.fwd10.title = `Forward ${step} seconds`;
    this.fwd10.setAttribute('aria-label', `Forward ${step} seconds`);

    this.volBtn = this.iconBtn(I.volHigh, 'Mute');
    this.volBtn.classList.add('elf-vol-btn');
    const volWrap = el('div', 'elf-vol-slider');
    this.volSlider = el('input') as HTMLInputElement;
    this.volSlider.type = 'range';
    this.volSlider.min = '0';
    this.volSlider.max = '1';
    this.volSlider.step = '0.02';
    this.volSlider.value = '1';
    this.volSlider.setAttribute('aria-label', 'Volume');
    volWrap.appendChild(this.volSlider);

    this.speedBtn = el('button', 'elf-btn elf-speed-pill', '1×') as HTMLButtonElement;
    this.speedBtn.title = 'Playback speed (or hold video for 2×)';
    this.speedBtn.setAttribute('aria-label', 'Playback speed');

    this.pipBtn = this.iconBtn(I.pip, 'Picture in Picture');
    this.fsBtn = el('button', 'elf-btn elf-fs-btn', FULLSCREEN_ANIM_SVG) as HTMLButtonElement;
    this.fsBtn.title = 'Fullscreen';
    this.fsBtn.setAttribute('aria-label', 'Fullscreen');

    this.bar.append(
      this.back10,
      this.playBtn,
      this.fwd10,
      this.volBtn,
      volWrap,
      el('div', 'elf-spacer'),
      this.speedBtn,
      this.pipBtn,
      this.fsBtn,
    );
    bottomDock.appendChild(this.bar);
    shell.appendChild(bottomDock);

    /* 10. Modal / Sheet Overlay for Audio & Subtitles, Quality, Speed, Sources, Style */
    this.panelBackdrop = el('div', 'elf-panel-backdrop');
    this.panelBackdrop.dataset.open = 'false';

    this.panel = el('div', 'elf-panel');
    this.panel.dataset.open = 'false';

    const panelHead = el('div', 'elf-panel-head');
    this.panelHeaderTitle = el('div', 'elf-panel-title', 'Audio & Subtitles');
    this.panelTabsEl = el('div', 'elf-tabs');
    const closeBtn = this.iconBtn(I.close, 'Close');
    closeBtn.classList.add('elf-panel-close');
    closeBtn.onclick = () => this.closePanel();
    panelHead.append(this.panelHeaderTitle, this.panelTabsEl, closeBtn);

    this.panelBody = el('div', 'elf-panel-body');
    this.panel.append(panelHead, this.panelBody);
    shell.append(this.panelBackdrop, this.panel);
  }

  private iconBtn(icon: string, label: string): HTMLButtonElement {
    const b = el('button', 'elf-btn', icon) as HTMLButtonElement;
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  }

  /* ------------------------------------------------------------------ */
  /* Title Logo / Cartoony Fallback + Paused Cinema Screen Sync          */
  /* ------------------------------------------------------------------ */

  private resolveDisplayMedia(): DisplayMedia {
    const cfg = this.player.config;
    const m: TitleMediaInfo | null =
      typeof this.player.getMediaInfo === 'function' ? this.player.getMediaInfo() : null;

    const rawCfgTitle = String(cfg.title ?? '').trim();
    // Parse "Series · S1E1 — Episode Name" if present in cfg.title
    const epPattern = /^(.*?)\s*·\s*S(\d+)E(\d+)(?:\s*[—-]\s*(.*))?$/i.exec(rawCfgTitle);

    const mediaType: 'movie' | 'tv' =
      m?.type ?? (cfg.mediaType === 'tv' || epPattern ? 'tv' : 'movie');

    const season =
      m?.season ?? (mediaType === 'tv' ? (epPattern ? Number(epPattern[2]) : cfg.season) : undefined);
    const episode =
      m?.episode ?? (mediaType === 'tv' ? (epPattern ? Number(epPattern[3]) : cfg.episode) : undefined);
    const episodeName = String(m?.episodeName ?? (epPattern?.[4] ?? '')).trim();

    const mainTitle = String(
      m?.rawTitle || (epPattern ? epPattern[1] : '') || m?.title || rawCfgTitle || '',
    ).trim();

    const logo = m?.logo && m.logo !== this.failedLogoUrl ? m.logo : null;
    const year = String(m?.year ?? '').trim();
    const tagline = String(m?.tagline ?? '').trim();
    const rating = typeof m?.rating === 'number' && Number.isFinite(m.rating) && m.rating > 0 ? m.rating : null;
    const genres = Array.isArray(m?.genres) ? m.genres.filter(Boolean) : [];
    const overview = String(m?.overview ?? '').trim();

    return {
      mediaType,
      mainTitle,
      season,
      episode,
      episodeName,
      year,
      tagline,
      rating,
      genres,
      overview,
      logo,
    };
  }

  private createTitleVisual(dm: DisplayMedia, variant: 'dock' | 'pause'): HTMLElement | null {
    if (dm.logo) {
      const img = document.createElement('img');
      img.className = `elf-title-logo elf-title-logo--${variant}`;
      img.src = dm.logo;
      img.alt = dm.mainTitle || 'Title';
      img.decoding = 'async';
      img.onerror = () => {
        if (dm.logo && this.failedLogoUrl !== dm.logo) {
          this.failedLogoUrl = dm.logo;
          this.lastMediaSig = '';
          this.syncMediaMetadata();
        }
      };
      return img;
    }
    if (dm.mainTitle) {
      const cartoon = el('div', `elf-title-cartoon elf-title-cartoon--${variant}`);
      cartoon.textContent = dm.mainTitle;
      return cartoon;
    }
    return null;
  }

  private syncMediaMetadata(): void {
    const cfg = this.player.config;
    this.backPillBtn.hidden = cfg.back === false;
    this.brandTextEl.textContent = String(cfg.brand || DEFAULT_BRAND_NAME);

    const dm = this.resolveDisplayMedia();
    const sig = JSON.stringify(dm);
    if (sig === this.lastMediaSig) return;
    this.lastMediaSig = sig;

    /* A. Top bar TV Episode indicator (NO top title logo — only S# · E# — Episode Name!) */
    if (dm.mediaType === 'tv' && dm.season && dm.episode) {
      const epCode = `S${dm.season} · E${dm.episode}`;
      this.topEpisodeEl.textContent = dm.episodeName ? `${epCode} — ${dm.episodeName}` : epCode;
      this.topEpisodeEl.hidden = false;
    } else {
      this.topEpisodeEl.textContent = '';
      this.topEpisodeEl.hidden = true;
    }

    /* B. Bottom-dock Title Logo (or Cartoony Font fallback) + `Movie · Genre · Year` */
    this.dockLogoSlot.replaceChildren();
    const dockVisual = this.createTitleVisual(dm, 'dock');
    if (dockVisual) this.dockLogoSlot.appendChild(dockVisual);

    const dockParts: string[] = [];
    if (dm.mainTitle || dm.logo) {
      dockParts.push(dm.mediaType === 'tv' ? 'Series' : 'Movie');
    }
    if (dm.mediaType === 'tv' && dm.season && dm.episode) {
      dockParts.push(`S${dm.season} E${dm.episode}`);
    } else if (dm.genres.length > 0) {
      dockParts.push(dm.genres[0]);
    }
    if (dm.year) dockParts.push(dm.year);
    this.dockSubmetaEl.textContent = dockParts.join(' · ');
    this.dockSubmetaEl.hidden = dockParts.length === 0;
    this.dockIdentityEl.hidden = !dockVisual && dockParts.length === 0;

    /* C. Cinema Paused Screen (Title Logo / Cartoony Title + PAUSED + "Tagline" + Year • ★ Rating + Overview) */
    this.pauseTitleSlot.replaceChildren();
    const pauseVisual = this.createTitleVisual(dm, 'pause');
    if (pauseVisual) this.pauseTitleSlot.appendChild(pauseVisual);

    if (dm.tagline) {
      const cleanTag = dm.tagline.replace(/^["“]+|["”]+$/g, '');
      this.pauseTaglineEl.textContent = `“${cleanTag}”`;
      this.pauseTaglineEl.hidden = false;
    } else {
      this.pauseTaglineEl.textContent = '';
      this.pauseTaglineEl.hidden = true;
    }

    const factItems: string[] = [];
    if (dm.year) factItems.push(`<span class="elf-pf-year">${esc(dm.year)}</span>`);
    if (dm.rating !== null) {
      factItems.push(
        `<span class="elf-pf-rating"><span class="elf-pf-star">${I.star}</span>${esc(dm.rating.toFixed(1))}</span>`,
      );
    }
    if (dm.mediaType === 'tv' && dm.season && dm.episode) {
      const epStr = dm.episodeName
        ? `S${dm.season} E${dm.episode} · ${dm.episodeName}`
        : `S${dm.season} E${dm.episode}`;
      factItems.push(`<span class="elf-pf-ep">${esc(epStr)}</span>`);
    } else if (dm.genres.length > 0 && dm.rating === null) {
      factItems.push(`<span class="elf-pf-genre">${esc(dm.genres.slice(0, 2).join(', '))}</span>`);
    }
    this.pauseFactsEl.innerHTML = factItems.join('<span class="elf-pf-dot">•</span>');
    this.pauseFactsEl.hidden = factItems.length === 0;

    this.pauseOverviewEl.textContent = dm.overview;
    this.pauseOverviewEl.hidden = !dm.overview;
  }

  private enterPauseScreen(): void {
    if (this.locked || this.panel.dataset.open === 'true') return;
    clearTimeout(this.hideTimer);
    clearTimeout(this.pauseIdleTimer);
    this.player.shell.dataset.pauseScreen = 'true';
    this.player.shell.dataset.ui = 'hidden';
    // Paused -> brand logo & name at 100% opacity!
    this.player.shell.dataset.brandFull = 'true';
  }

  private schedulePauseScreen(ms = 3200): void {
    clearTimeout(this.pauseIdleTimer);
    if (!this.player.video.paused || !this.hasStartedPlayback || this.locked || this.panel.dataset.open === 'true') {
      return;
    }
    this.pauseIdleTimer = window.setTimeout(() => {
      if (this.player.video.paused && this.hasStartedPlayback && this.panel.dataset.open !== 'true' && !this.locked) {
        this.enterPauseScreen();
      }
    }, ms);
  }

  /* ------------------------------------------------------------------ */
  /* Wiring & Gestures                                                   */
  /* ------------------------------------------------------------------ */

  private wire(): void {
    const v = this.player.video;
    const shell = this.player.shell;
    const bus = this.player.bus;
    const step = Number(this.player.config.skipStep ?? 10);

    this.backPillBtn.onclick = (e) => {
      e.stopPropagation();
      this.player.bus.emit('back', {});
      try {
        if (window === window.top && window.history.length > 1) {
          window.history.back();
        }
      } catch {
        /* cross-origin parent iframe — postMessage bridge already delivered `back` */
      }
    };

    this.playBtn.onclick = () => {
      this.triggerBtnPop(this.playBtn);
      this.player.toggle();
    };
    this.bigPlay.onclick = (e) => {
      e.stopPropagation();
      this.player.toggle();
    };

    this.back10.onclick = () => {
      this.triggerSkipBtnAnim(this.back10);
      this.player.skipBy(-step);
    };
    this.fwd10.onclick = () => {
      this.triggerSkipBtnAnim(this.fwd10);
      this.player.skipBy(step);
    };

    this.volBtn.onclick = () => {
      this.triggerBtnPop(this.volBtn);
      this.player.setMuted(!v.muted);
    };
    this.volSlider.oninput = () => this.player.setVolume(Number(this.volSlider.value));

    this.qualityTopBtn.onclick = () => this.togglePanel('quality');
    this.audioSubsTopBtn.onclick = () => this.togglePanel('audiosubs');
    this.speedBtn.onclick = () => this.togglePanel('speed');

    // Hold on the `1x` speed pill ALSO triggers temporary 2x boost!
    let speedBtnHoldTimer = 0;
    let speedBtnHeld = false;
    this.speedBtn.addEventListener('pointerdown', () => {
      speedBtnHeld = false;
      clearTimeout(speedBtnHoldTimer);
      speedBtnHoldTimer = window.setTimeout(() => {
        if (!v.paused) {
          speedBtnHeld = true;
          this.startHold2x();
        }
      }, 320);
    });
    const endSpeedBtnHold = (e: Event) => {
      clearTimeout(speedBtnHoldTimer);
      if (speedBtnHeld) {
        speedBtnHeld = false;
        this.stopHold2x();
        e.preventDefault();
        e.stopPropagation();
      }
    };
    this.speedBtn.addEventListener('pointerup', endSpeedBtnHold);
    this.speedBtn.addEventListener('pointercancel', endSpeedBtnHold);
    this.speedBtn.addEventListener('pointerleave', endSpeedBtnHold);

    this.lockBtn.onclick = () => this.setLocked(true);
    this.unlockPill.onclick = (e) => {
      e.stopPropagation();
      this.setLocked(false);
    };

    this.pipBtn.onclick = () => {
      this.triggerBtnPop(this.pipBtn);
      void this.player.togglePip();
    };
    this.fsBtn.onclick = () => {
      this.triggerBtnPop(this.fsBtn);
      void this.player.fullscreen(document.fullscreenElement !== shell);
    };

    this.panelBackdrop.onclick = () => this.closePanel();

    // Pause Hotstar bar auto-hide while pointer is interacting with it
    this.hotstarBar.addEventListener('pointerenter', () => clearTimeout(this.hotstarTimer));
    this.hotstarBar.addEventListener('pointerdown', () => clearTimeout(this.hotstarTimer));
    this.hotstarBar.addEventListener('pointerleave', () => {
      if (this.hotstarBar.dataset.show === 'true') this.armHotstarHide(2500);
    });

    this.wireSurfaceGestures(step);

    shell.addEventListener('pointermove', (e) => {
      if (this.locked) return;
      if (e.pointerType === 'mouse') {
        this.showUI();
      }
    });
    shell.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.locked) {
        if (v.paused && this.hasStartedPlayback) this.enterPauseScreen();
        else this.scheduleHide();
      }
    });

    v.addEventListener('play', () => {
      const firstStart = !this.hasStartedPlayback;
      this.hasStartedPlayback = true;
      clearTimeout(this.pauseIdleTimer);
      shell.dataset.pauseScreen = 'false';
      shell.dataset.playing = 'true';
      shell.dataset.paused = 'false';
      this.playBtn.setAttribute('aria-label', 'Pause');

      // Brand pill: 100% opacity when started, then fades smoothly while playing!
      clearTimeout(this.startWindowTimer);
      if (firstStart) {
        shell.dataset.brandFull = 'true';
        this.startWindowTimer = window.setTimeout(() => {
          if (!this.player.video.paused) {
            shell.dataset.brandFull = 'false';
          }
        }, 3600);
      } else {
        shell.dataset.brandFull = 'false';
      }

      this.flashIcon(I.playSolid);
      this.maybeTriggerHotstarBar();
      this.scheduleHide();
    });

    v.addEventListener('pause', () => {
      this.stopHold2x();
      clearTimeout(this.startWindowTimer);
      shell.dataset.playing = 'false';
      shell.dataset.paused = 'true';
      // When paused: brand logo & TheOGPirateBot opacity is 100%!
      shell.dataset.brandFull = 'true';
      this.playBtn.setAttribute('aria-label', 'Play');
      this.flashIcon(I.pauseSolid);

      if (!this.locked) {
        if (this.hasStartedPlayback || v.currentTime > 0) {
          this.hasStartedPlayback = true;
          this.enterPauseScreen();
        } else {
          this.showUI();
        }
      }
    });

    v.addEventListener('waiting', () => (shell.dataset.buffering = 'true'));
    v.addEventListener('playing', () => {
      shell.dataset.buffering = 'false';
      this.maybeTriggerHotstarBar();
    });
    v.addEventListener('loadeddata', () => {
      shell.dataset.buffering = 'false';
      this.maybeTriggerHotstarBar();
    });

    bus.on('media', () => {
      this.failedLogoUrl = '';
      this.syncMediaMetadata();
    });
    bus.on('config', () => {
      this.syncMediaMetadata();
      this.renderSegments();
    });
    bus.on('sources', () => {
      this.hotstarShownForTitle = false;
      this.hotstarDismissed = false;
      this.hasStartedPlayback = false;
      shell.dataset.pauseScreen = 'false';
      shell.dataset.brandFull = 'true';
      this.syncMediaMetadata();
      this.syncCapabilities();
      this.rebuildPanelIfOpen();
    });
    bus.on('sourceChange', (d) => {
      this.syncCapabilities();
      this.rebuildPanelIfOpen();
      const ev = d as { label?: string; manual?: boolean } | undefined;
      if (ev?.manual && ev.label) this.showToast(ev.label);
    });
    bus.on('qualityLevels', () => {
      this.syncCapabilities();
      this.rebuildPanelIfOpen();
    });
    bus.on('qualityEffective', (d) => this.syncQualityBadge(d as { mode?: string; height?: number }));
    bus.on('qualityChange', (d) => this.syncQualityBadge(d as { mode?: string; height?: number }));
    bus.on('audioTracks', () => {
      this.syncCapabilities();
      this.renderHotstarPills();
      this.maybeTriggerHotstarBar();
      this.rebuildPanelIfOpen();
    });
    bus.on('audioChange', (d) => {
      clearTimeout(this.searchingTimer);
      this.renderHotstarPills();
      this.rebuildPanelIfOpen();
      const label = (d as { label?: string })?.label ?? '';
      if (this.hasRenderedAudioSelection && label) {
        this.showToast(`Audio · ${label}`);
      }
      this.hasRenderedAudioSelection = true;
    });
    bus.on('audio:searching', (d) => {
      clearTimeout(this.searchingTimer);
      const label = (d as { label?: string })?.label ?? '';
      this.searchingTimer = window.setTimeout(() => {
        if (label) this.showToast(`Switching to ${label}…`, 3500);
      }, 350);
    });
    bus.on('audio:unavailable', (d) => {
      clearTimeout(this.searchingTimer);
      const msg =
        (d as { message?: string })?.message ??
        `Sorry, we searched all sources yet didn't find it in "${(d as { label?: string })?.label ?? 'that language'}"`;
      this.renderHotstarPills();
      this.rebuildPanelIfOpen();
      this.showToast(msg, 6000, 'warn');
    });
    bus.on('subtitleTracks', () => {
      this.syncCapabilities();
      this.rebuildPanelIfOpen();
    });
    bus.on('subtitleChange', () => {
      this.syncCapabilities();
      this.rebuildPanelIfOpen();
    });
    bus.on('volumechange', (d) => this.syncVolume(d as { volume: number; muted: boolean }));
    bus.on('speedchange', (d) => {
      const sp = (d as { speed?: number })?.speed ?? v.playbackRate;
      if (!this.holdActive) {
        this.speedBtn.textContent = `${trim(sp)}×`;
        this.speedBtn.dataset.active = String(sp !== 1);
      }
      this.rebuildPanelIfOpen();
    });
    bus.on('segments:invalidate', () => this.renderSegments());
    bus.on('durationchange', () => {
      this.syncCapabilities();
      this.renderSegments();
    });
    bus.on('autoplay:blocked', () => this.showToast('Tap to play with sound'));
    bus.on('error', (d) => {
      const code = (d as { code?: string })?.code ?? '';
      if (code === 'no-sources' || code.startsWith('resolve-')) {
        this.showToast('Stream currently unavailable', 4500, 'warn');
      }
    });
    bus.on('episode:next', () => this.showToast('Loading next…'));
    bus.on('fullscreen', (d) => {
      const on = Boolean((d as { on?: boolean })?.on);
      shell.dataset.fullscreen = String(on);
      this.fsBtn.title = on ? 'Exit fullscreen' : 'Fullscreen';
      this.fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    });

    this.wireScrub();
    if (this.player.config.keyboard !== false) this.wireKeyboard();
  }

  /* ------------------------------------------------------------------ */
  /* Touch & Pointer Surface Gestures (Double-Tap 10s + Hold 2x + Lock)  */
  /* ------------------------------------------------------------------ */

  private isInteractiveChrome(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(
      target.closest(
        '.elf-brand-cluster, .elf-top-actions, .elf-bottom-dock, .elf-panel, .elf-panel-backdrop, .elf-hotstar-lang, .elf-skip, .elf-unlock-pill, .elf-bigplay, .elf-sub-box',
      ),
    );
  }

  private wireSurfaceGestures(step: number): void {
    const shell = this.player.shell;
    const v = this.player.video;

    shell.addEventListener('pointerdown', (e) => {
      if (this.isInteractiveChrome(e.target)) return;
      if (e.button !== undefined && e.button !== 0) return;

      if (this.locked) {
        this.peekUnlockPill();
        return;
      }

      this.pointerDownPos = {
        x: e.clientX,
        y: e.clientY,
        id: e.pointerId,
        pointerType: e.pointerType || 'mouse',
      };

      clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => {
        if (!this.pointerDownPos || v.paused || this.dragging || this.locked) return;
        this.startHold2x();
      }, 380);
    });

    shell.addEventListener('pointermove', (e) => {
      if (!this.pointerDownPos || e.pointerId !== this.pointerDownPos.id) return;
      const dx = Math.abs(e.clientX - this.pointerDownPos.x);
      const dy = Math.abs(e.clientY - this.pointerDownPos.y);
      if (dx > 14 || dy > 14) {
        clearTimeout(this.holdTimer);
        if (!this.holdActive) this.pointerDownPos = null;
      }
    });

    const finishPointer = (e: PointerEvent, cancelled = false) => {
      clearTimeout(this.holdTimer);
      if (this.holdActive) {
        this.stopHold2x();
        this.suppressClickUntil = Date.now() + 260;
        this.pointerDownPos = null;
        return;
      }
      if (!this.pointerDownPos || e.pointerId !== this.pointerDownPos.id) return;
      const down = this.pointerDownPos;
      this.pointerDownPos = null;
      if (cancelled || this.locked || this.isInteractiveChrome(e.target)) return;

      this.suppressClickUntil = Date.now() + 320;
      this.handleSurfaceTap(e.clientX, down.pointerType, step);
    };

    shell.addEventListener('pointerup', (e) => finishPointer(e, false));
    shell.addEventListener('pointercancel', (e) => finishPointer(e, true));

    shell.addEventListener('click', (e) => {
      if (this.isInteractiveChrome(e.target)) return;
      if (Date.now() < this.suppressClickUntil || this.locked) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  private handleSurfaceTap(clientX: number, pointerType: string, step: number): void {
    const shell = this.player.shell;
    const rect = shell.getBoundingClientRect();
    const relX = (clientX - rect.left) / Math.max(1, rect.width);
    const zone: 'left' | 'center' | 'right' =
      relX < 0.36 ? 'left' : relX > 0.64 ? 'right' : 'center';

    if (this.dtapAccumSec > 0 && this.tapZone === zone && (zone === 'left' || zone === 'right')) {
      clearTimeout(this.singleTapTimer);
      this.triggerDoubleTapSkip(zone, step);
      return;
    }

    if (this.tapCount === 1 && this.tapZone === zone) {
      clearTimeout(this.singleTapTimer);
      this.tapCount = 0;
      if (zone === 'left' || zone === 'right') {
        this.triggerDoubleTapSkip(zone, step);
      } else if (pointerType === 'mouse') {
        void this.player.fullscreen(document.fullscreenElement !== shell);
      } else {
        this.player.toggle();
      }
      return;
    }

    this.tapCount = 1;
    this.tapZone = zone;
    clearTimeout(this.singleTapTimer);
    this.singleTapTimer = window.setTimeout(() => {
      this.tapCount = 0;
      if (this.panel.dataset.open === 'true') {
        this.closePanel();
        return;
      }
      if (pointerType === 'touch') {
        if (shell.dataset.pauseScreen === 'true') {
          // Single tap on Paused Cinema Screen wakes up controls (and drifts back to Paused Screen if left idle)
          this.showUI();
        } else if (shell.dataset.ui === 'visible') {
          if (this.player.video.paused && this.hasStartedPlayback) {
            this.enterPauseScreen();
          } else {
            shell.dataset.ui = 'hidden';
            clearTimeout(this.hideTimer);
          }
        } else {
          this.showUI();
        }
      } else {
        this.player.toggle();
      }
    }, 220);
  }

  private triggerDoubleTapSkip(side: 'left' | 'right', step: number): void {
    const delta = side === 'left' ? -step : step;
    this.player.skipBy(delta);

    this.dtapAccumSec += step;
    clearTimeout(this.dtapResetTimer);
    this.dtapResetTimer = window.setTimeout(() => {
      this.dtapAccumSec = 0;
      this.tapZone = null;
    }, 650);

    if (side === 'left') {
      this.dtapLeftText.textContent = `-${this.dtapAccumSec}s`;
      this.dtapLeftEl.dataset.show = 'false';
      void this.dtapLeftEl.offsetWidth;
      this.dtapLeftEl.dataset.show = 'true';
      clearTimeout(this.dtapHideLeftTimer);
      this.dtapHideLeftTimer = window.setTimeout(() => {
        this.dtapLeftEl.dataset.show = 'false';
      }, 620);
    } else {
      this.dtapRightText.textContent = `+${this.dtapAccumSec}s`;
      this.dtapRightEl.dataset.show = 'false';
      void this.dtapRightEl.offsetWidth;
      this.dtapRightEl.dataset.show = 'true';
      clearTimeout(this.dtapHideRightTimer);
      this.dtapHideRightTimer = window.setTimeout(() => {
        this.dtapRightEl.dataset.show = 'false';
      }, 620);
    }
  }

  private startHold2x(): void {
    if (this.holdActive || this.locked) return;
    this.holdActive = true;
    this.holdSavedSpeed = this.player.video.playbackRate || 1;
    this.player.setSpeed(2);
    this.speedHoldBadge.dataset.show = 'true';
  }

  private stopHold2x(): void {
    if (!this.holdActive) return;
    this.holdActive = false;
    this.speedHoldBadge.dataset.show = 'false';
    this.player.setSpeed(this.holdSavedSpeed);
  }

  /* ------------------------------------------------------------------ */
  /* Screen Lock Mode                                                    */
  /* ------------------------------------------------------------------ */

  private setLocked(on: boolean): void {
    this.locked = on;
    const shell = this.player.shell;
    shell.dataset.locked = String(on);

    if (on) {
      this.stopHold2x();
      this.closePanel();
      this.dismissHotstarBar(false);
      shell.dataset.pauseScreen = 'false';
      shell.dataset.ui = 'hidden';
      clearTimeout(this.hideTimer);
      clearTimeout(this.pauseIdleTimer);
      this.peekUnlockPill();
    } else {
      clearTimeout(this.lockPeekTimer);
      this.unlockPill.dataset.show = 'false';
      this.showUI();
      this.showToast('Controls unlocked', 1400);
    }
  }

  private peekUnlockPill(): void {
    this.unlockPill.dataset.show = 'true';
    clearTimeout(this.lockPeekTimer);
    this.lockPeekTimer = window.setTimeout(() => {
      this.unlockPill.dataset.show = 'false';
    }, 2600);
  }

  /* ------------------------------------------------------------------ */
  /* Hotstar-Style Bottom Language Selector (First 5 Seconds!)           */
  /* ------------------------------------------------------------------ */

  private renderHotstarPills(): void {
    const tracks: AudioTrack[] = this.player.getAudioTracks();
    this.hotstarPills.replaceChildren();
    if (tracks.length < 2) {
      this.dismissHotstarBar(false);
      return;
    }

    const st = this.player.getState();
    for (const t of tracks) {
      const selected = st.audioId ? t.id === st.audioId : t.lang === st.audioLang;
      const pill = el('button', 'elf-hotstar-pill') as HTMLButtonElement;
      pill.dataset.selected = String(selected);
      pill.innerHTML = selected
        ? `<span class="elf-hs-dot">${I.check}</span><span>${esc(t.label)}</span>`
        : `<span>${esc(t.label)}</span>`;
      pill.onclick = (e) => {
        e.stopPropagation();
        this.hasRenderedAudioSelection = true;
        void this.player.setAudio(t.id);
        this.armHotstarHide(1600);
      };
      this.hotstarPills.appendChild(pill);
    }
  }

  private maybeTriggerHotstarBar(): void {
    if (this.locked || this.hotstarDismissed) return;
    const tracks = this.player.getAudioTracks();
    if (tracks.length < 2) return;
    const v = this.player.video;

    if (this.hotstarShownForTitle) {
      if (this.hotstarBar.dataset.show === 'true' && !v.paused && !this.hotstarTimer) {
        this.armHotstarHide(5000);
      }
      return;
    }

    if (v.currentTime > 8 && !v.paused) return;

    this.hotstarShownForTitle = true;
    this.renderHotstarPills();
    this.hotstarBar.dataset.show = 'true';
    if (!v.paused) {
      this.armHotstarHide(5000);
    }
  }

  private armHotstarHide(ms: number): void {
    clearTimeout(this.hotstarTimer);
    this.hotstarTimer = window.setTimeout(() => {
      this.hotstarTimer = 0;
      this.dismissHotstarBar(false);
    }, ms);
  }

  private dismissHotstarBar(manual: boolean): void {
    clearTimeout(this.hotstarTimer);
    this.hotstarTimer = 0;
    if (manual) this.hotstarDismissed = true;
    this.hotstarBar.dataset.show = 'false';
  }

  /* ------------------------------------------------------------------ */
  /* Capability Sync & Branded Source Toggle                             */
  /* ------------------------------------------------------------------ */

  private syncCapabilities(): void {
    const st = this.player.getState();
    const sources = this.player.getSources();
    const ql = this.player.getQualityLevels();
    const audio = this.player.getAudioTracks();
    const subs = this.player.getSubtitleTracks();

    this.pipBtn.hidden = !st.canPip;
    this.fsBtn.hidden = !st.canFullscreen;
    this.qualityTopBtn.hidden = ql.length === 0 && sources.length < 2;
    this.audioSubsTopBtn.hidden = audio.length < 2 && subs.length === 0;

    const d = st.duration;
    const step = Number(this.player.config.skipStep ?? 10);
    const hideSkip = Number.isFinite(d) && d > 0 && d <= step * 2;
    this.back10.hidden = hideSkip;
    this.fwd10.hidden = hideSkip;

    this.syncQualityBadge();
    this.syncSourceToggle();
    this.syncVolume({ volume: st.volume, muted: st.muted });
  }

  private syncQualityBadge(d?: { mode?: string; height?: number }): void {
    const st = this.player.getState();
    const mode = d?.mode ?? st.qualityMode ?? 'auto';
    const eff = d?.height ?? st.effectiveHeight;
    const summary = mode === 'auto' ? (eff ? `Auto · ${eff}p` : 'Auto') : `${mode}p`;
    if (summary !== this.lastQualitySummary) {
      this.qualitySubText.textContent = summary;
      this.lastQualitySummary = summary;
    }
  }

  private syncSourceToggle(): void {
    const sources = this.player.getSources();
    if (sources.length < 2) {
      this.sourceSwitchWrap.hidden = true;
      this.lastSourceSig = '';
      return;
    }

    const groups: { sourceId: string; shortLabel: string; firstOptionId: string }[] = [];
    for (const s of sources) {
      if (!groups.some((g) => g.sourceId === s.sourceId)) {
        const cleanBrand = s.label.split('·')[0].trim() || s.sourceId;
        groups.push({
          sourceId: s.sourceId,
          shortLabel: cleanBrand,
          firstOptionId: s.id,
        });
      }
    }

    const st = this.player.getState();
    const activeOpt = sources.find((s) => s.id === st.source) ?? sources[0];
    const activeGroup = activeOpt?.sourceId ?? '';
    const sig = `${groups.map((g) => g.sourceId).join('|')}::${activeGroup}::${sources.length}`;
    if (sig === this.lastSourceSig) return;
    this.lastSourceSig = sig;

    this.sourceSwitchWrap.replaceChildren();
    const pillWrap = el('div', 'elf-source-pill');

    if (groups.length >= 2) {
      for (const g of groups) {
        const b = el('button', 'elf-source-seg', esc(g.shortLabel)) as HTMLButtonElement;
        b.dataset.on = String(g.sourceId === activeGroup);
        b.onclick = () => {
          if (g.sourceId === activeGroup) {
            this.togglePanel('sources');
          } else {
            void this.player.setSource(g.firstOptionId);
          }
        };
        pillWrap.appendChild(b);
      }
    } else {
      const b = el('button', 'elf-source-seg', 'Servers') as HTMLButtonElement;
      b.dataset.on = 'true';
      b.onclick = () => this.togglePanel('sources');
      pillWrap.appendChild(b);
    }

    this.sourceSwitchWrap.appendChild(pillWrap);
    this.sourceSwitchWrap.hidden = false;
  }

  private syncVolume(d: { volume: number; muted: boolean }): void {
    this.volSlider.value = String(d.volume);
    const isMuted = d.muted || d.volume === 0;
    this.volBtn.innerHTML = isMuted ? I.volMute : I.volHigh;
    this.volBtn.dataset.muted = String(isMuted);
  }

  private triggerBtnPop(btn: HTMLElement): void {
    btn.dataset.pop = 'false';
    void btn.offsetWidth;
    btn.dataset.pop = 'true';
  }

  private triggerSkipBtnAnim(btn: HTMLElement): void {
    btn.dataset.kick = 'false';
    void btn.offsetWidth;
    btn.dataset.kick = 'true';
  }

  /* ------------------------------------------------------------------ */
  /* Smooth 60fps rAF Timeline Loop                                      */
  /* ------------------------------------------------------------------ */

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

      const curStr = fmtTime(v.currentTime);
      if (curStr !== this.lastCurStr) {
        this.lastCurStr = curStr;
        this.curTimeEl.textContent = curStr;
        this.scrub.setAttribute('aria-valuenow', String(Math.round(v.currentTime)));
      }

      const durStr = fmtTime(d);
      if (durStr !== this.lastDurStr) {
        this.lastDurStr = durStr;
        this.durTimeEl.textContent = durStr;
      }

      this.updateSkip();
    };
    this.raf = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------ */
  /* Scrubber & Intro/Outro Segments                                     */
  /* ------------------------------------------------------------------ */

  private wireScrub(): void {
    const v = this.player.video;
    const ratio = (x: number) => {
      const r = this.scrub.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / (r.width || 1)));
    };
    const preview = (x: number) => {
      const p = ratio(x) * 100;
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      if (this.dragging) {
        this.fill.style.width = `${p}%`;
        this.knob.style.left = `${p}%`;
      }
      this.tip.style.left = `${p}%`;
      this.tip.textContent = fmtTime(ratio(x) * d);
    };

    this.scrub.addEventListener('pointerdown', (e) => {
      if (this.locked) return;
      this.dragging = true;
      this.scrub.dataset.dragging = 'true';
      this.scrub.setPointerCapture(e.pointerId);
      preview(e.clientX);
      e.preventDefault();
    });
    this.scrub.addEventListener('pointermove', (e) => {
      if (this.locked) return;
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
      if (this.locked) return;
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
    if (intro && d) ranges.push({ kind: 'intro', ...intro, label: 'Skip Intro' });
    const outro = read(cfg.outro as never);
    if (outro && d) ranges.push({ kind: 'outro', ...outro, label: 'Skip Outro' });

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

  private updateSkip(): void {
    if (this.locked) {
      if (this.skipBtn.dataset.visible !== 'false') this.skipBtn.dataset.visible = 'false';
      return;
    }
    const t = this.player.video.currentTime;
    const hit = this.skipRanges.find((r) => t >= r.start && t < r.end);
    const visible = !!hit;
    if (this.skipBtn.dataset.visible !== String(visible)) this.skipBtn.dataset.visible = String(visible);
    if (hit) {
      if (this.skipBtn.textContent !== hit.label) this.skipBtn.textContent = hit.label;
      this.skipBtn.onclick = () => this.player.seek(hit.end);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Keyboard Shortcuts                                                  */
  /* ------------------------------------------------------------------ */

  private wireKeyboard(): void {
    const shell = this.player.shell;
    shell.tabIndex = 0;
    const step = Number(this.player.config.skipStep ?? 10);
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (this.locked) {
        if (e.key === 'Escape') {
          this.setLocked(false);
          e.preventDefault();
        } else {
          this.peekUnlockPill();
        }
        return;
      }
      const v = this.player.video;
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          this.player.toggle();
          return;
        case 'arrowright':
        case 'l':
          this.triggerDoubleTapSkip('right', step);
          break;
        case 'arrowleft':
        case 'j':
          this.triggerDoubleTapSkip('left', step);
          break;
        case 'arrowup':
          this.player.setVolume(v.volume + 0.05);
          break;
        case 'arrowdown':
          this.player.setVolume(v.volume - 0.05);
          break;
        case 'm':
          this.player.setMuted(!v.muted);
          break;
        case 'f':
          void this.player.fullscreen(document.fullscreenElement !== shell);
          break;
        case 'c':
          void this.player.setSubtitle(
            this.player.getState().subtitleLang ? null : (this.player.getSubtitleTracks()[0]?.id ?? null),
          );
          break;
        case 'a':
        case 's':
          this.togglePanel('audiosubs');
          break;
        case 'escape':
          if (this.panel.dataset.open === 'true') {
            this.closePanel();
            e.preventDefault();
          }
          return;
        default:
          if (/^[0-9]$/.test(e.key) && d) this.player.seek((Number(e.key) / 10) * d);
          else return;
      }
      e.preventDefault();
      this.showUI();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Center State Burst                                                  */
  /* ------------------------------------------------------------------ */

  private flashIcon(icon: string): void {
    this.flash.innerHTML = icon;
    this.flash.dataset.show = 'false';
    void this.flash.offsetWidth;
    this.flash.dataset.show = 'true';
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => (this.flash.dataset.show = 'false'), 480);
  }

  /* ------------------------------------------------------------------ */
  /* Unified OTT Overlay Panel (Audio & Subtitles, Quality, Sources...)  */
  /* ------------------------------------------------------------------ */

  private availableModes(): { id: PanelMode; icon: string; label: string }[] {
    const modes: { id: PanelMode; icon: string; label: string }[] = [];
    if (this.player.getAudioTracks().length > 1 || this.player.getSubtitleTracks().length > 0) {
      modes.push({ id: 'audiosubs', icon: I.audioSubsBox, label: 'Audio & Subtitles' });
    }
    if (this.player.getQualityLevels().length > 0) {
      modes.push({ id: 'quality', icon: I.qualityTv, label: 'Quality' });
    }
    if (this.player.getSources().length > 1) {
      modes.push({ id: 'sources', icon: I.layers, label: 'Servers' });
    }
    modes.push({ id: 'speed', icon: I.gauge, label: 'Speed' });
    return modes;
  }

  private togglePanel(mode: PanelMode): void {
    if (this.locked) return;
    if (this.panel.dataset.open === 'true' && this.panelMode === mode) {
      this.closePanel();
    } else {
      this.openPanel(mode);
    }
  }

  private openPanel(mode: PanelMode): void {
    const modes = this.availableModes();
    this.panelMode =
      mode === 'style' || modes.some((m) => m.id === mode) ? mode : (modes[0]?.id ?? 'speed');
    this.dismissHotstarBar(false);
    clearTimeout(this.pauseIdleTimer);
    this.player.shell.dataset.pauseScreen = 'false';
    this.panel.dataset.open = 'true';
    this.panel.dataset.wide = String(this.panelMode === 'audiosubs');
    this.panelBackdrop.dataset.open = 'true';
    this.qualityTopBtn.dataset.active = String(this.panelMode === 'quality');
    this.audioSubsTopBtn.dataset.active = String(this.panelMode === 'audiosubs' || this.panelMode === 'style');
    this.buildPanelHeader();
    this.renderPanelBody();
    this.showUI();
  }

  private closePanel(): void {
    this.panel.dataset.open = 'false';
    this.panelBackdrop.dataset.open = 'false';
    this.qualityTopBtn.dataset.active = 'false';
    this.audioSubsTopBtn.dataset.active = 'false';
    this.previewRenderer?.destroy();
    this.previewRenderer = null;
    if (this.player.video.paused && this.hasStartedPlayback) {
      this.schedulePauseScreen(2600);
    } else {
      this.scheduleHide();
    }
  }

  private rebuildPanelIfOpen(): void {
    if (this.panel.dataset.open !== 'true') return;
    const modes = this.availableModes();
    if (this.panelMode !== 'style' && !modes.some((m) => m.id === this.panelMode)) {
      this.panelMode = modes[0]?.id ?? 'speed';
    }
    this.panel.dataset.wide = String(this.panelMode === 'audiosubs');
    this.buildPanelHeader();
    this.renderPanelBody();
  }

  private buildPanelHeader(): void {
    const modes = this.availableModes();
    const titles: Record<PanelMode, string> = {
      audiosubs: 'Audio & Subtitles',
      quality: 'Video Quality',
      sources: 'Servers',
      speed: 'Playback Speed',
      style: 'Subtitle Appearance',
    };
    this.panelHeaderTitle.textContent = titles[this.panelMode];

    this.panelTabsEl.replaceChildren();
    for (const m of modes) {
      const b = this.iconBtn(m.icon, m.label);
      b.dataset.on = String(this.panelMode === m.id || (this.panelMode === 'style' && m.id === 'audiosubs'));
      b.onclick = () => {
        this.panelMode = m.id;
        this.panel.dataset.wide = String(this.panelMode === 'audiosubs');
        this.qualityTopBtn.dataset.active = String(this.panelMode === 'quality');
        this.audioSubsTopBtn.dataset.active = String(this.panelMode === 'audiosubs');
        this.buildPanelHeader();
        this.renderPanelBody();
      };
      this.panelTabsEl.appendChild(b);
    }
  }

  private renderPanelBody(): void {
    this.previewRenderer?.destroy();
    this.previewRenderer = null;
    this.panelBody.replaceChildren();

    switch (this.panelMode) {
      case 'audiosubs':
        this.renderAudioAndSubs();
        break;
      case 'quality':
        this.renderQuality();
        break;
      case 'sources':
        this.renderSources();
        break;
      case 'speed':
        this.renderSpeed();
        break;
      case 'style':
        this.renderStyle();
        break;
    }
    this.panelBody.scrollTop = 0;
  }

  private renderAudioAndSubs(): void {
    const st = this.player.getState();
    const audioTracks: AudioTrack[] = this.player.getAudioTracks();
    const subTracks = this.player.getSubtitleTracks();

    const grid = el('div', 'elf-as-grid');
    grid.dataset.dual = String(audioTracks.length > 0 && subTracks.length >= 0);

    if (audioTracks.length > 0) {
      const colAudio = el('div', 'elf-as-col');
      colAudio.appendChild(el('div', 'elf-col-heading', 'Audio'));
      const listAudio = el('div', 'elf-col-list');
      for (const t of audioTracks) {
        const selected = st.audioId ? t.id === st.audioId : t.lang === st.audioLang;
        listAudio.appendChild(
          this.row(t.label, '', selected, () => {
            this.hasRenderedAudioSelection = true;
            void this.player.setAudio(t.id);
            this.renderPanelBody();
          }),
        );
      }
      colAudio.appendChild(listAudio);
      grid.appendChild(colAudio);
    }

    const colSubs = el('div', 'elf-as-col');
    colSubs.appendChild(el('div', 'elf-col-heading', 'Subtitles'));
    const listSubs = el('div', 'elf-col-list');
    listSubs.appendChild(
      this.row('Off', '', !st.subtitleId && !st.subtitleLang, () => {
        void this.player.setSubtitle(null);
        this.renderPanelBody();
      }),
    );
    for (const t of subTracks) {
      const selected = st.subtitleId ? t.id === st.subtitleId : t.lang === st.subtitleLang;
      listSubs.appendChild(
        this.row(t.label, '', selected, () => {
          void this.player.setSubtitle(t.id);
          this.renderPanelBody();
        }),
      );
    }
    if (subTracks.length > 0) {
      const styleBtn = el('button', 'elf-sub-style-link', 'Customize subtitle style ›') as HTMLButtonElement;
      styleBtn.onclick = () => {
        this.panelMode = 'style';
        this.panel.dataset.wide = 'false';
        this.buildPanelHeader();
        this.renderPanelBody();
      };
      listSubs.appendChild(styleBtn);
    }
    colSubs.appendChild(listSubs);
    grid.appendChild(colSubs);

    this.panelBody.appendChild(grid);
  }

  private renderQuality(): void {
    const st = this.player.getState();
    this.panelBody.appendChild(
      this.row('Auto', st.effectiveHeight ? `${st.effectiveHeight}p` : '', st.qualityMode === 'auto', () => {
        this.player.setQuality('auto');
        this.renderPanelBody();
      }),
    );
    for (const l of this.player.getQualityLevels()) {
      this.panelBody.appendChild(
        this.row(l.label, '', st.qualityMode === String(l.height), () => {
          this.player.setQuality(l.height);
          this.renderPanelBody();
        }),
      );
    }
  }

  private renderSources(): void {
    const st = this.player.getState();
    for (const s of this.player.getSources()) {
      const qualityBadge = s.quality && s.quality !== 'auto' ? s.quality.toUpperCase() : '';
      this.panelBody.appendChild(
        this.row(s.label, qualityBadge, s.id === st.source, () => {
          void this.player.setSource(s.id);
          this.renderPanelBody();
        }),
      );
    }
  }

  private renderSpeed(): void {
    const st = this.player.getState();
    for (const s of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      this.panelBody.appendChild(
        this.row(`${s}×`, s === 1 ? 'Normal' : '', s === st.speed, () => {
          this.player.setSpeed(s);
          this.renderPanelBody();
        }),
      );
    }
  }

  private row(label: string, sub: string, selected: boolean, onClick: () => void) {
    const b = el('button', 'elf-menu-item') as HTMLButtonElement;
    b.dataset.selected = String(selected);
    b.innerHTML = `<span class="elf-mi-check">${I.check}</span><span class="elf-mi-label">${esc(label)}${
      sub ? `<span class="elf-mi-sub"> · ${esc(sub)}</span>` : ''
    }</span>`;
    b.onclick = onClick;
    return b;
  }

  /* ---------------------- Subtitle Style Editor --------------------- */

  private renderStyle(): void {
    const style = this.player.getSubtitleStyle();

    const back = el('button', 'elf-style-back', `${I.back}<span>Back to Audio & Subtitles</span>`) as HTMLButtonElement;
    back.onclick = () => {
      this.panelMode = 'audiosubs';
      this.panel.dataset.wide = 'true';
      this.buildPanelHeader();
      this.renderPanelBody();
    };
    this.panelBody.appendChild(back);

    const preview = el('div', 'elf-sub-preview');
    this.panelBody.appendChild(preview);
    this.previewRenderer = new SubtitleRenderer({ host: preview, baselineHeight: 720 }, style);
    this.previewRenderer.bindClock(() => 1.5);
    this.previewRenderer.setCues([
      {
        id: 'p',
        start: 0,
        end: 9999,
        spans: [{ text: 'The quick brown fox' }, { text: '\njumps over the lazy dog', italic: true }],
        text: 'preview',
      },
    ]);

    const live = (patch: Partial<SubtitleStyle>) => {
      this.previewRenderer?.setStyle(patch, { silent: true });
      this.player.setSubtitleStyle(patch);
    };

    this.label('Color & Opacity');
    this.panelBody.appendChild(this.color('Text color', style.color, (c) => live({ color: c })));
    this.panelBody.appendChild(
      this.slider('Text transparency', opacityToTransparency(style.textOpacity), 0, 100, 1, '%', (v) =>
        live({ textOpacity: transparencyToOpacity(v) }),
      ),
    );
    this.panelBody.appendChild(this.color('Background color', style.backgroundColor, (c) => live({ backgroundColor: c })));
    this.panelBody.appendChild(
      this.slider('Background transparency', opacityToTransparency(style.backgroundOpacity), 0, 100, 1, '%', (v) =>
        live({ backgroundOpacity: transparencyToOpacity(v) }),
      ),
    );

    this.label('Typography');
    this.panelBody.appendChild(
      this.select(
        'Font family',
        FONT_CHOICES.map((f) => ({ value: f.value, label: f.label })),
        style.fontFamily,
        (v) => live({ fontFamily: v }),
      ),
    );
    this.panelBody.appendChild(this.slider('Size', style.fontSizePct, 40, 220, 1, '%', (v) => live({ fontSizePct: v })));
    this.panelBody.appendChild(
      this.segmented(
        'Weight',
        [
          { value: 400, label: 'Reg' },
          { value: 500, label: 'Med' },
          { value: 600, label: 'Semi' },
          { value: 700, label: 'Bold' },
          { value: 800, label: 'Xtra' },
        ],
        style.fontWeight,
        (v) => live({ fontWeight: v }),
      ),
    );
    this.panelBody.appendChild(this.toggle('Italic', style.italic, (v) => live({ italic: v })));
    this.panelBody.appendChild(this.toggle('UPPERCASE', style.uppercase, (v) => live({ uppercase: v })));

    this.label('Edge & Shadow');
    this.panelBody.appendChild(this.toggle('Outline', style.outline, (v) => live({ outline: v })));
    if (style.outline) {
      this.panelBody.appendChild(this.color('Outline color', style.outlineColor, (c) => live({ outlineColor: c })));
      this.panelBody.appendChild(this.slider('Outline width', style.outlineWidth, 0, 4, 0.5, 'px', (v) => live({ outlineWidth: v })));
    }
    this.panelBody.appendChild(this.toggle('Drop shadow', style.shadow, (v) => live({ shadow: v })));
    if (style.shadow) {
      this.panelBody.appendChild(this.slider('Shadow blur', style.shadowBlur, 0, 12, 1, 'px', (v) => live({ shadowBlur: v })));
    }

    this.label('Position');
    this.panelBody.appendChild(
      this.segmented(
        'Edge',
        [
          { value: 'bottom', label: 'Bottom' },
          { value: 'top', label: 'Top' },
        ],
        style.edge,
        (v) => live({ edge: v as SubtitleStyle['edge'] }),
      ),
    );
    this.panelBody.appendChild(
      this.slider('Distance from edge', style.verticalPct, 0, 45, 1, '%', (v) => live({ verticalPct: v })),
    );

    const actions = el('div', 'elf-panel-actions');
    const reset = el('button', '', 'Reset') as HTMLButtonElement;
    reset.onclick = () => {
      this.player.resetSubtitleStyle();
      this.renderPanelBody();
    };
    const done = el('button', '', 'Done') as HTMLButtonElement;
    done.dataset.primary = 'true';
    done.onclick = () => this.closePanel();
    actions.append(reset, done);
    this.panelBody.appendChild(actions);
  }

  /* --------------------------- Field Helpers ------------------------ */

  private label(text: string): void {
    this.panelBody.appendChild(el('div', 'elf-section-label', esc(text)));
  }

  private slider(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    unit: string,
    onChange: (v: number) => void,
  ) {
    const wrap = el('div', 'elf-field');
    const head = el('div', 'elf-field-head');
    head.append(el('span', 'elf-field-label', esc(label)));
    const out = el('span', 'elf-field-value', `${trim(value)}${unit}`);
    head.appendChild(out);
    const input = el('input') as HTMLInputElement;
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
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

  private segmented<T extends string | number>(
    label: string,
    opts: { value: T; label: string }[],
    value: T,
    onChange: (v: T) => void,
  ) {
    const wrap = el('div', 'elf-field');
    wrap.appendChild(el('div', 'elf-field-head', `<span class="elf-field-label">${esc(label)}</span>`));
    const group = el('div', 'elf-seg-group');
    for (const o of opts) {
      const b = el('button', '', esc(o.label)) as HTMLButtonElement;
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

  /* ------------------------------------------------------------------ */
  /* Visibility & Toasts                                                 */
  /* ------------------------------------------------------------------ */

  private showUI(): void {
    if (this.locked) return;
    this.player.shell.dataset.pauseScreen = 'false';
    this.player.shell.dataset.ui = 'visible';
    if (this.player.video.paused && this.hasStartedPlayback) {
      this.schedulePauseScreen(3500);
    } else {
      this.scheduleHide();
    }
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer);
    if (this.player.video.paused || this.panel.dataset.open === 'true' || this.locked) return;
    this.hideTimer = window.setTimeout(() => {
      if (this.player.video.paused || this.panel.dataset.open === 'true' || this.locked) return;
      this.player.shell.dataset.ui = 'hidden';
    }, 3000);
  }

  showToast(msg: string, ms = 2200, kind: 'info' | 'warn' = 'info'): void {
    if (kind === 'info' && Date.now() < this.toastWarnUntil) return;
    if (kind === 'warn') this.toastWarnUntil = Date.now() + ms;
    this.toastEl.textContent = msg;
    this.toastEl.dataset.kind = kind;
    this.toastEl.dataset.show = 'true';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.dataset.show = 'false';
      this.toastEl.dataset.kind = 'info';
    }, ms);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hideTimer);
    clearTimeout(this.pauseIdleTimer);
    clearTimeout(this.startWindowTimer);
    clearTimeout(this.toastTimer);
    clearTimeout(this.searchingTimer);
    clearTimeout(this.flashTimer);
    clearTimeout(this.hotstarTimer);
    clearTimeout(this.singleTapTimer);
    clearTimeout(this.dtapResetTimer);
    clearTimeout(this.dtapHideLeftTimer);
    clearTimeout(this.dtapHideRightTimer);
    clearTimeout(this.holdTimer);
    clearTimeout(this.lockPeekTimer);
    this.previewRenderer?.destroy();
  }
}

const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
