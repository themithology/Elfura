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
 *   - Top-right `Quality` and `Screen Lock`; bottom-navigation Episodes with
 *     thumbnail drawer; integrated current-language Audio & Subtitles; inline
 *     capsule-thumb seekbar; animated Play/Pause & 4-corner Fullscreen; left/
 *     right double-tap 10s skip; press-and-hold for 2× speed; zero center skip
 *     clutter.
 *
 * Strictly zero hardcoded audio tracks or static language lists.
 */

import type { ElfuraPlayer, EpisodeItemInfo, SeasonSummaryInfo, TitleMediaInfo } from '../core/player';
import type { SubtitleStyle } from '../subs/style';
import { FONT_CHOICES, opacityToTransparency, transparencyToOpacity } from '../subs/style';
import { canonLang, languageLabel, type AudioTrack } from '../core/audio';
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
  episodesTray:
    '<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="4" width="17" height="16" rx="3.2" stroke="currentColor" stroke-width="2"/><path d="M3.8 14h4.7a1.5 1.5 0 0 1 1.3.8l.4.8a1.5 1.5 0 0 0 1.3.8h1a1.5 1.5 0 0 0 1.3-.8l.4-.8a1.5 1.5 0 0 1 1.3-.8h4.7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  playingScreen:
    '<svg viewBox="0 0 20 20" fill="none"><rect x="2.2" y="3.5" width="15.6" height="10.8" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M6.8 17.2h6.4M10 14.3v2.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8.5 7v3.8l3.3-1.9L8.5 7z" fill="currentColor"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v6M12 7.2v.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  nextEp:
    '<svg viewBox="0 0 20 20" fill="none"><path d="M4.5 4.6c0-.8.8-1.3 1.5-.8l7.5 5.4c.6.4.6 1.2 0 1.6L6 16.2c-.7.5-1.5 0-1.5-.8V4.6z" fill="currentColor"/><path d="M15.5 4.8v10.4" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>',
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

const FALLBACK_LOADING_QUOTES: { quote: string; author: string }[] = [
  { quote: 'Every great story begins with a single scene.', author: '' },
  { quote: 'The best seat in the house is wherever you are.', author: '' },
  { quote: 'A little escape, one episode at a time.', author: '' },
  { quote: 'Stories stay with us long after the screen goes dark.', author: '' },
  { quote: 'Another world is only a play button away.', author: '' },
  { quote: 'Some stories deserve just one more episode.', author: '' },
  { quote: 'Every frame opens a door to somewhere new.', author: '' },
  { quote: 'A quiet moment can hold an extraordinary adventure.', author: '' },
  { quote: 'The next chapter is already waiting for you.', author: '' },
  { quote: 'Great characters make even unfamiliar worlds feel like home.', author: '' },
  { quote: 'Let the rest of the day wait while the story unfolds.', author: '' },
  { quote: 'There is always more beyond the opening scene.', author: '' },
  { quote: 'A good story turns spare minutes into memorable journeys.', author: '' },
  { quote: 'New voices, new worlds, and a fresh perspective await.', author: '' },
  { quote: 'The screen is small, but the adventure does not have to be.', author: '' },
  { quote: 'Settle in. Something remarkable is about to begin.', author: '' },
];

/** Presentation only: available tracks still come exclusively from runtime sources. */
const audioBadgeLabel = (lang?: string | null): string => {
  const canon = canonLang(lang);
  if (canon === 'und' || canon === 'mul') return 'A';
  const base = canon.split('-')[0];
  if (base === 'hi') return 'हिं';
  return base.toUpperCase();
};

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
  backdrop: string;
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
  private episodesBtn!: HTMLButtonElement;
  private qualityTopBtn!: HTMLButtonElement;
  private qualitySubText!: HTMLElement;
  private audioSubsBtn!: HTMLButtonElement;
  private audioCurrentLabel!: HTMLElement;
  private audioCurrentBadge!: HTMLElement;
  private lockBtn!: HTMLButtonElement;

  /* Right-Hand Curved/Fading Scroll-Wheel Episode Selector (TV only) */
  private epWheelOverlay!: HTMLElement;
  private epWheelSeasonsEl!: HTMLElement;
  private epWheelList!: HTMLElement;
  private epWheelOpen = false;
  private epWheelSeason = 1;
  private epWheelSeasons: SeasonSummaryInfo[] = [];
  private epWheelEpisodes: EpisodeItemInfo[] = [];

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
  private skipLabelEl!: HTMLElement;
  private nextEpWrap!: HTMLElement;
  private nextEpBtn!: HTMLButtonElement;
  private nextEpLabelEl!: HTMLElement;
  private nextEpDismissBtn!: HTMLButtonElement;
  private nextEpDismissedKey = '';

  /* Bottom dock: Title Logo / Cartoony Title + Submeta (left) & Source Pill (right) */
  private dockIdentityEl!: HTMLElement;
  private dockLogoSlot!: HTMLElement;
  private dockSubmetaEl!: HTMLElement;
  private sourceSwitchWrap!: HTMLElement;

  /* Branded startup / unavailable states */
  private loadingScreen!: HTMLElement;
  private loadingBackdrop!: HTMLImageElement;
  private loadingLogoSlot!: HTMLElement;
  private loadingStatus!: HTMLElement;
  private loadingQuote!: HTMLElement;
  private loadingQuoteAuthor!: HTMLElement;
  private loadingQuoteTimer = 0;
  private loadingDeadlineTimer = 0;
  private loadingQuoteIndex = 0;
  private loadingQuoteAbort: AbortController | null = null;
  private loadingQuoteSession = 0;
  private loadingQuoteHistory = new Set<string>();
  private loadingActive = false;
  private unavailableScreen!: HTMLElement;
  private unavailableBackdrop!: HTMLImageElement;
  private unavailableTitle!: HTMLElement;
  private unavailableMessage!: HTMLElement;

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
  private endsAtBtn!: HTMLButtonElement;
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

  /* Gesture state (double-tap 10s + hold for 2x + two-finger pinch-to-zoom) */
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
  private touchPoints = new Map<number, { x: number; y: number }>();
  private pinchActive = false;
  private pinchStartDist = 0;
  private suppressClickUntil = 0;

  /* Timeline & End-time toggles */
  private showRemainingTime = false;
  private endsAt12h = false;
  private lastEndsAtStr = '';
  private lastSkipPct = '';

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
    // Initial intro/outro configuration can predate UI construction. Render it
    // immediately; loadedmetadata/durationchange will refine it once known.
    this.renderSegments();
    this.syncMediaMetadata();
    this.syncCapabilities();
    if (this.player.config.tmdb && !this.player.config.src) this.showInitialLoading();
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

    /* 1B. Top-right chrome stays intentionally small; primary navigation lives below. */
    this.topEl = el('div', 'elf-top');
    const topSpacer = el('div', 'elf-top-spacer');
    const topRight = el('div', 'elf-top-actions');

    this.episodesBtn = el('button', 'elf-btn elf-episodes-btn') as HTMLButtonElement;
    this.episodesBtn.type = 'button';
    this.episodesBtn.title = 'Episodes';
    this.episodesBtn.setAttribute('aria-label', 'Open episodes');
    this.episodesBtn.setAttribute('aria-haspopup', 'dialog');
    this.episodesBtn.hidden = true;
    this.episodesBtn.innerHTML = `<span class="elf-episodes-icon">${I.episodesTray}<svg class="elf-episodes-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg></span><span class="elf-episodes-label">Episodes</span>`;
    this.episodesBtn.onclick = () => this.toggleEpisodeWheel();

    this.qualityTopBtn = el('button', 'elf-top-btn elf-quality-trigger') as HTMLButtonElement;
    this.qualityTopBtn.setAttribute('aria-label', 'Quality');
    const qIcon = el('span', 'elf-top-icon', I.qualityTv);
    const qLabel = el('span', 'elf-top-label', 'Quality');
    this.qualitySubText = el('span', 'elf-top-meta', 'Auto');
    this.qualityTopBtn.append(qIcon, qLabel, this.qualitySubText);

    this.audioSubsBtn = el('button', 'elf-btn elf-audio-quick') as HTMLButtonElement;
    this.audioSubsBtn.type = 'button';
    this.audioSubsBtn.title = 'Audio & subtitles';
    this.audioSubsBtn.setAttribute('aria-label', 'Change audio and subtitles');
    this.audioSubsBtn.setAttribute('aria-haspopup', 'dialog');
    this.audioSubsBtn.innerHTML = `<span class="elf-audio-badge" aria-hidden="true">A</span><span class="elf-audio-current">Audio</span>`;
    this.audioCurrentLabel = this.audioSubsBtn.querySelector('.elf-audio-current') as HTMLElement;
    this.audioCurrentBadge = this.audioSubsBtn.querySelector('.elf-audio-badge') as HTMLElement;
    this.audioSubsBtn.onclick = () => this.togglePanel('audiosubs');

    this.lockBtn = el('button', 'elf-top-btn elf-lock-trigger') as HTMLButtonElement;
    this.lockBtn.title = 'Lock screen';
    this.lockBtn.setAttribute('aria-label', 'Lock controls');
    this.lockBtn.appendChild(el('span', 'elf-top-icon', I.lockOpen));

    topRight.append(this.qualityTopBtn, this.lockBtn);
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

    /* 7. Toast, Progressing Intro/Outro Skip Pill & Instant Next-Episode Binge Pill */
    this.toastEl = el('div', 'elf-toast');
    this.toastEl.dataset.show = 'false';
    shell.appendChild(this.toastEl);

    this.skipBtn = el('button', 'elf-skip') as HTMLButtonElement;
    this.skipBtn.dataset.visible = 'false';
    const skipProg = el('span', 'elf-skip-prog');
    this.skipLabelEl = el('span', 'elf-skip-label', 'Skip Intro');
    this.skipBtn.append(skipProg, this.skipLabelEl);
    shell.appendChild(this.skipBtn);

    this.nextEpWrap = el('div', 'elf-next-ep-wrap');
    this.nextEpWrap.dataset.visible = 'false';
    this.nextEpBtn = el('button', 'elf-next-ep-btn') as HTMLButtonElement;
    const nextProg = el('span', 'elf-next-ep-prog');
    const nextIco = el('span', 'elf-next-ep-ico', I.nextEp);
    this.nextEpLabelEl = el('span', 'elf-next-ep-label', 'Next Episode');
    this.nextEpBtn.append(nextProg, nextIco, this.nextEpLabelEl);
    this.nextEpDismissBtn = el('button', 'elf-next-ep-dismiss', I.close) as HTMLButtonElement;
    this.nextEpDismissBtn.title = 'Dismiss';
    this.nextEpDismissBtn.setAttribute('aria-label', 'Dismiss next episode');
    this.nextEpWrap.append(this.nextEpBtn, this.nextEpDismissBtn);
    shell.appendChild(this.nextEpWrap);

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
    this.durTimeEl.title = 'Tap to toggle remaining time';
    this.durTimeEl.setAttribute('role', 'button');
    this.durTimeEl.tabIndex = 0;

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

    this.endsAtBtn = el('button', 'elf-btn elf-ends-at-btn', 'Will End at --:--') as HTMLButtonElement;
    this.endsAtBtn.title = 'Toggle 24h / 12h clock format';
    this.endsAtBtn.setAttribute('aria-label', 'Toggle end time format');
    this.endsAtBtn.hidden = true;

    this.speedBtn = el('button', 'elf-btn elf-speed-pill', '1×') as HTMLButtonElement;
    this.speedBtn.title = 'Playback speed (or hold video for 2×)';
    this.speedBtn.setAttribute('aria-label', 'Playback speed');

    this.pipBtn = this.iconBtn(I.pip, 'Picture in Picture');
    this.fsBtn = el('button', 'elf-btn elf-fs-btn', FULLSCREEN_ANIM_SVG) as HTMLButtonElement;
    this.fsBtn.title = 'Fullscreen';
    this.fsBtn.setAttribute('aria-label', 'Fullscreen');

    const barStart = el('div', 'elf-bar-start');
    barStart.append(this.back10, this.playBtn, this.fwd10, this.volBtn, volWrap);
    const barEnd = el('div', 'elf-bar-end');
    barEnd.append(
      this.endsAtBtn,
      this.episodesBtn,
      this.audioSubsBtn,
      this.speedBtn,
      this.pipBtn,
      this.fsBtn,
    );
    this.bar.append(barStart, el('div', 'elf-spacer'), barEnd);
    bottomDock.appendChild(this.bar);
    shell.appendChild(bottomDock);

    /* 9B. Right-Hand Curved/Fading Scroll-Wheel Episode Selector (TV only) */
    this.epWheelOverlay = el('div', 'elf-ep-wheel-overlay');
    this.epWheelOverlay.dataset.open = 'false';
    const epWheelStage = el('div', 'elf-ep-wheel-stage');
    this.epWheelSeasonsEl = el('div', 'elf-ep-wheel-seasons');
    this.epWheelList = el('div', 'elf-ep-wheel-list');
    const epWheelHead = el('div', 'elf-ep-wheel-head');
    const epWheelHeading = el('div', 'elf-ep-wheel-heading', 'Episodes');
    const epWheelClose = this.iconBtn(I.close, 'Close episodes');
    epWheelClose.classList.add('elf-ep-wheel-close');
    epWheelClose.onclick = () => this.closeEpisodeWheel();
    epWheelHead.append(epWheelHeading, epWheelClose);
    epWheelStage.append(epWheelHead, this.epWheelSeasonsEl, this.epWheelList);
    this.epWheelOverlay.appendChild(epWheelStage);
    shell.appendChild(this.epWheelOverlay);

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

    /* 11. Startup artwork + useful progress and a real terminal unavailable state. */
    this.loadingScreen = el('div', 'elf-loading-screen');
    this.loadingScreen.dataset.visible = 'false';
    this.loadingScreen.setAttribute('role', 'status');
    this.loadingScreen.setAttribute('aria-live', 'polite');
    this.loadingBackdrop = document.createElement('img');
    this.loadingBackdrop.className = 'elf-state-backdrop';
    this.loadingBackdrop.alt = '';
    this.loadingBackdrop.decoding = 'async';
    const loadingShade = el('div', 'elf-state-shade');
    const loadingContent = el('div', 'elf-loading-content');
    this.loadingLogoSlot = el('div', 'elf-loading-logo');
    const loadingRule = el('div', 'elf-loading-rule', '<span></span>');
    this.loadingStatus = el('div', 'elf-loading-status', 'Finding the best available source…');
    const quoteCard = el('figure', 'elf-loading-quote-card');
    this.loadingQuote = el('blockquote', 'elf-loading-quote');
    this.loadingQuoteAuthor = el('figcaption', 'elf-loading-quote-author');
    quoteCard.append(this.loadingQuote, this.loadingQuoteAuthor);
    loadingContent.append(this.loadingLogoSlot, loadingRule, this.loadingStatus, quoteCard);
    this.loadingScreen.append(this.loadingBackdrop, loadingShade, loadingContent);

    this.unavailableScreen = el('div', 'elf-unavailable-screen');
    this.unavailableScreen.dataset.visible = 'false';
    this.unavailableScreen.setAttribute('role', 'alert');
    this.unavailableBackdrop = document.createElement('img');
    this.unavailableBackdrop.className = 'elf-state-backdrop';
    this.unavailableBackdrop.alt = '';
    const unavailableShade = el('div', 'elf-state-shade');
    const unavailableCard = el('div', 'elf-unavailable-card');
    const unavailableIcon = el('div', 'elf-unavailable-icon', I.info);
    this.unavailableTitle = el('h2', 'elf-unavailable-title', "Couldn't find this title");
    this.unavailableMessage = el(
      'p',
      'elf-unavailable-message',
      'No playable sources are available right now. Please try again in a moment.',
    );
    const retryBtn = el('button', 'elf-state-retry', 'Try again') as HTMLButtonElement;
    retryBtn.type = 'button';
    retryBtn.onclick = () => {
      this.unavailableScreen.dataset.visible = 'false';
      this.showInitialLoading();
      void this.player.retrySources();
    };
    unavailableCard.append(unavailableIcon, this.unavailableTitle, this.unavailableMessage, retryBtn);
    this.unavailableScreen.append(this.unavailableBackdrop, unavailableShade, unavailableCard);
    shell.append(this.loadingScreen, this.unavailableScreen);
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
      backdrop: String(m?.backdrop || m?.poster || cfg.poster || '').trim(),
    };
  }

  private syncStateArtwork(dm: DisplayMedia): void {
    const backdrop = dm.backdrop;
    for (const img of [this.loadingBackdrop, this.unavailableBackdrop]) {
      if (backdrop) {
        if (img.getAttribute('src') !== backdrop) img.src = backdrop;
        img.hidden = false;
      } else {
        img.removeAttribute('src');
        img.hidden = true;
      }
    }
    this.loadingLogoSlot.replaceChildren();
    const visual = this.createTitleVisual(dm, 'pause');
    if (visual) this.loadingLogoSlot.appendChild(visual);
    this.loadingLogoSlot.hidden = !visual;
  }

  private showInitialLoading(): void {
    this.loadingActive = true;
    const session = ++this.loadingQuoteSession;
    if (this.loadingQuoteHistory.size > 64) this.loadingQuoteHistory.clear();
    this.player.shell.dataset.initialLoading = 'true';
    this.player.shell.dataset.unavailable = 'false';
    this.loadingScreen.dataset.visible = 'true';
    this.unavailableScreen.dataset.visible = 'false';
    clearTimeout(this.loadingDeadlineTimer);
    // One wall-clock budget across resolution, source switches, and recovery.
    // A timeout is an honest unavailable state, not a claim of playback success.
    this.loadingDeadlineTimer = window.setTimeout(() => {
      if (this.loadingActive) this.player.cancelStartup();
    }, 9000);
    this.loadingStatus.textContent = 'Finding the best available source…';
    this.syncStateArtwork(this.resolveDisplayMedia());
    this.showNextFallbackQuote();
    clearInterval(this.loadingQuoteTimer);
    void this.fetchLoadingQuote(session);
    this.loadingQuoteTimer = window.setInterval(() => {
      if (!this.loadingActive || session !== this.loadingQuoteSession) return;
      // Keep something fresh on screen immediately, then replace it with a new
      // live quote as soon as the request resolves. No repeated four-quote loop.
      this.showNextFallbackQuote();
      void this.fetchLoadingQuote(session);
    }, 6500);
  }

  private showNextFallbackQuote(): void {
    let item = FALLBACK_LOADING_QUOTES[this.loadingQuoteIndex % FALLBACK_LOADING_QUOTES.length];
    for (let i = 0; i < FALLBACK_LOADING_QUOTES.length; i++) {
      const candidate = FALLBACK_LOADING_QUOTES[(this.loadingQuoteIndex + i) % FALLBACK_LOADING_QUOTES.length];
      if (!this.loadingQuoteHistory.has(candidate.quote)) {
        item = candidate;
        this.loadingQuoteIndex = (this.loadingQuoteIndex + i + 1) % FALLBACK_LOADING_QUOTES.length;
        break;
      }
    }
    this.setLoadingQuote(item);
  }

  private setLoadingQuote(item: { quote: string; author: string }): void {
    this.loadingQuoteHistory.add(item.quote);
    this.loadingQuote.textContent = `“${item.quote}”`;
    this.loadingQuoteAuthor.textContent = item.author ? `— ${item.author}` : '';
  }

  private async fetchLoadingQuote(session: number, allowDuplicateRetry = true): Promise<void> {
    this.loadingQuoteAbort?.abort();
    const controller = new AbortController();
    this.loadingQuoteAbort = controller;
    const timeout = window.setTimeout(() => controller.abort(), 2600);
    try {
      const res = await fetch('https://zenquotes.io/api/random', {
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { q?: unknown; a?: unknown }[] | null;
      const quote = String(data?.[0]?.q ?? '').trim();
      const author = String(data?.[0]?.a ?? '').trim();
      if (!this.loadingActive || session !== this.loadingQuoteSession || !quote || quote.length > 280) return;
      if (this.loadingQuoteHistory.has(quote)) {
        if (allowDuplicateRetry) void this.fetchLoadingQuote(session, false);
        return;
      }
      this.setLoadingQuote({ quote, author: author.slice(0, 90) });
    } catch {
      /* Offline/CORS failures retain the larger, non-repeating local fallback set. */
    } finally {
      clearTimeout(timeout);
      if (this.loadingQuoteAbort === controller) this.loadingQuoteAbort = null;
    }
  }

  private hideInitialLoading(): void {
    this.loadingActive = false;
    this.loadingQuoteSession++;
    clearInterval(this.loadingQuoteTimer);
    clearTimeout(this.loadingDeadlineTimer);
    this.loadingDeadlineTimer = 0;
    this.loadingQuoteTimer = 0;
    this.loadingQuoteAbort?.abort();
    this.loadingQuoteAbort = null;
    this.player.shell.dataset.initialLoading = 'false';
    this.loadingScreen.dataset.visible = 'false';
  }

  private showUnavailable(message?: string): void {
    this.hideInitialLoading();
    this.closePanel();
    if (this.epWheelOpen) this.closeEpisodeWheel();
    this.player.shell.dataset.pauseScreen = 'false';
    this.player.shell.dataset.buffering = 'false';
    this.player.shell.dataset.unavailable = 'true';
    this.unavailableMessage.textContent =
      message || 'No playable sources are available right now. Please try again in a moment.';
    this.syncStateArtwork(this.resolveDisplayMedia());
    this.unavailableScreen.dataset.visible = 'true';
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
    this.syncStateArtwork(dm);

    /* A. Top bar TV Episode indicator + Bottom-navigation Episode trigger */
    this.episodesBtn.hidden = dm.mediaType !== 'tv';
    if (dm.mediaType === 'tv' && dm.season && dm.episode) {
      const epCode = `S${dm.season} · E${dm.episode}`;
      this.topEpisodeEl.textContent = dm.episodeName ? `${epCode} — ${dm.episodeName}` : epCode;
      this.topEpisodeEl.hidden = false;
    } else {
      this.topEpisodeEl.textContent = '';
      this.topEpisodeEl.hidden = true;
      if (this.epWheelOpen) this.closeEpisodeWheel();
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
    if (this.locked || this.panel.dataset.open === 'true' || this.epWheelOpen) return;
    clearTimeout(this.hideTimer);
    clearTimeout(this.pauseIdleTimer);
    this.player.shell.dataset.pauseScreen = 'true';
    this.player.shell.dataset.ui = 'hidden';
    // Paused -> brand logo & name at 100% opacity!
    this.player.shell.dataset.brandFull = 'true';
  }

  private schedulePauseScreen(ms = 3200): void {
    clearTimeout(this.pauseIdleTimer);
    if (
      !this.player.video.paused ||
      !this.hasStartedPlayback ||
      this.locked ||
      this.panel.dataset.open === 'true' ||
      this.epWheelOpen
    ) {
      return;
    }
    this.pauseIdleTimer = window.setTimeout(() => {
      if (
        this.player.video.paused &&
        this.hasStartedPlayback &&
        this.panel.dataset.open !== 'true' &&
        !this.epWheelOpen &&
        !this.locked
      ) {
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

    this.episodesBtn.onclick = () => this.toggleEpisodeWheel();
    this.qualityTopBtn.onclick = () => this.togglePanel('quality');
    this.audioSubsBtn.onclick = () => this.togglePanel('audiosubs');
    this.speedBtn.onclick = () => this.togglePanel('speed');

    const toggleRemTime = (e: Event) => {
      e.stopPropagation();
      this.showRemainingTime = !this.showRemainingTime;
      this.durTimeEl.dataset.remaining = String(this.showRemainingTime);
      this.lastDurStr = '';
      this.refreshTimeReadouts();
    };
    this.durTimeEl.onclick = toggleRemTime;
    this.durTimeEl.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleRemTime(e);
      }
    };

    this.endsAtBtn.onclick = (e) => {
      e.stopPropagation();
      this.endsAt12h = !this.endsAt12h;
      this.endsAtBtn.dataset.fmt = this.endsAt12h ? '12h' : '24h';
      this.lastEndsAtStr = '';
      this.triggerBtnPop(this.endsAtBtn);
      this.refreshTimeReadouts();
    };

    this.nextEpBtn.onclick = (e) => {
      e.stopPropagation();
      this.nextEpWrap.dataset.visible = 'false';
      void this.player.nextEpisode();
    };
    this.nextEpDismissBtn.onclick = (e) => {
      e.stopPropagation();
      const dm = this.resolveDisplayMedia();
      this.nextEpDismissedKey = `${dm.season ?? 1}:${dm.episode ?? 1}`;
      this.nextEpWrap.dataset.visible = 'false';
    };

    this.epWheelOverlay.onclick = (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      if (!e.target.closest('.elf-ep-wheel-item, .elf-ep-season-pill')) {
        this.closeEpisodeWheel();
      }
    };
    this.epWheelList.addEventListener('scroll', () => this.syncWheelCurve(), { passive: true });

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
    const markPlaybackReady = () => {
      // Ignore late media events from an attempt already declared unavailable.
      if (shell.dataset.unavailable === 'true') return;
      shell.dataset.buffering = 'false';
      shell.dataset.unavailable = 'false';
      this.unavailableScreen.dataset.visible = 'false';
      this.hideInitialLoading();
    };
    v.addEventListener('playing', markPlaybackReady);
    v.addEventListener('loadeddata', markPlaybackReady);

    bus.on('media', () => {
      this.failedLogoUrl = '';
      this.syncMediaMetadata();
    });
    bus.on('config', () => {
      this.syncMediaMetadata();
      this.renderSegments();
    });
    bus.on('sources', () => {
      this.hasStartedPlayback = false;
      shell.dataset.pauseScreen = 'false';
      shell.dataset.brandFull = 'true';
      this.syncMediaMetadata();
      this.syncCapabilities();
      this.rebuildPanelIfOpen();
    });
    bus.on('sourcesUpdated', () => {
      this.syncCapabilities();
      this.rebuildPanelIfOpen();
    });
    bus.on('sourceChange', (d) => {
      if (this.loadingActive) this.loadingStatus.textContent = 'Preparing your stream…';
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
      this.rebuildPanelIfOpen();
    });
    bus.on('audioChange', (d) => {
      clearTimeout(this.searchingTimer);
      this.audioSubsBtn.dataset.switching = 'false';
      this.syncAudioQuickLabel();
      this.rebuildPanelIfOpen();
      const label = (d as { label?: string })?.label ?? '';
      if (this.hasRenderedAudioSelection && label) {
        this.showToast(`Audio · ${label}`);
      }
      this.hasRenderedAudioSelection = true;
    });
    bus.on('audio:searching', (d) => {
      clearTimeout(this.searchingTimer);
      this.audioSubsBtn.dataset.switching = 'true';
      const label = (d as { label?: string })?.label ?? '';
      this.searchingTimer = window.setTimeout(() => {
        if (label) this.showToast(`Switching to ${label}…`, 3500);
      }, 350);
    });
    bus.on('audio:unavailable', (d) => {
      clearTimeout(this.searchingTimer);
      this.audioSubsBtn.dataset.switching = 'false';
      this.syncAudioQuickLabel();
      const msg =
        (d as { message?: string })?.message ??
        `Sorry, we searched all sources yet didn't find it in "${(d as { label?: string })?.label ?? 'that language'}"`;
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
    v.addEventListener('loadedmetadata', () => this.renderSegments());
    bus.on('autoplay:blocked', () => this.showToast('Tap to play with sound'));
    bus.on('error', (d) => {
      const code = (d as { code?: string })?.code ?? '';
      if (code === 'no-sources' || code === 'all-sources-failed' || code.startsWith('resolve-')) {
        const message = code.startsWith('resolve-')
          ? 'We couldn’t reach this title’s sources. Check your connection and try again.'
          : code === 'all-sources-failed'
            ? 'None of the available sources could start playback. Please try again.'
            : 'We couldn’t find a playable stream for this title. Please try again later.';
        this.showUnavailable(message);
      }
    });
    v.addEventListener('ended', () => {
      const dm = this.resolveDisplayMedia();
      const epKey = `${dm.season ?? 1}:${dm.episode ?? 1}`;
      if (
        dm.mediaType === 'tv' &&
        this.player.config.autoplayNextEp !== false &&
        this.nextEpDismissedKey !== epKey &&
        this.player.getNextEpisodeTarget()
      ) {
        this.nextEpWrap.dataset.visible = 'false';
        void this.player.nextEpisode();
      }
    });

    bus.on('episodesCatalog', () => {
      if (this.epWheelOpen) {
        const cat = this.player.getSeasonCatalog(this.epWheelSeason);
        if (cat) {
          this.epWheelSeasons = cat.seasons;
          this.epWheelEpisodes = cat.episodes;
          this.renderEpisodeWheelDOM();
        }
      }
    });
    bus.on('episodeChange', (d) => {
      const ev = d as { season?: number; episode?: number } | undefined;
      this.showInitialLoading();
      this.nextEpDismissedKey = '';
      this.nextEpWrap.dataset.visible = 'false';
      this.lastMediaSig = '';
      this.syncMediaMetadata();
      if (ev?.season && ev?.episode) {
        this.showToast(`Season ${ev.season} · Episode ${ev.episode}`);
      }
      if (this.epWheelOpen) {
        this.epWheelSeason = ev?.season ?? this.epWheelSeason;
        this.renderEpisodeWheelDOM();
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
    // SVG icons inside controls are Element targets, not HTMLElement targets.
    // Treating them as the video surface caused delayed accidental play/panel-close taps.
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.closest(
        '.elf-brand-cluster, .elf-top-actions, .elf-bottom-dock, .elf-panel, .elf-panel-backdrop, .elf-ep-wheel-overlay, .elf-loading-screen, .elf-unavailable-screen, .elf-skip, .elf-next-ep-wrap, .elf-unlock-pill, .elf-bigplay, .elf-sub-box',
      ),
    );
  }

  private wireSurfaceGestures(step: number): void {
    const shell = this.player.shell;
    const v = this.player.video;

    const getTwoTouchDist = (): number => {
      const pts = Array.from(this.touchPoints.values());
      if (pts.length < 2) return 0;
      return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    };

    shell.addEventListener('pointerdown', (e) => {
      if (this.isInteractiveChrome(e.target)) return;
      if (e.button !== undefined && e.button !== 0) return;

      if (this.locked) {
        this.peekUnlockPill();
        return;
      }

      if (e.pointerType === 'touch') {
        this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touchPoints.size >= 2) {
          this.pinchActive = true;
          this.pinchStartDist = Math.max(10, getTwoTouchDist());
          this.pointerDownPos = null;
          this.tapCount = 0;
          clearTimeout(this.singleTapTimer);
          clearTimeout(this.holdTimer);
          if (this.holdActive) this.stopHold2x();
          return;
        }
      }

      this.pointerDownPos = {
        x: e.clientX,
        y: e.clientY,
        id: e.pointerId,
        pointerType: e.pointerType || 'mouse',
      };

      clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => {
        if (!this.pointerDownPos || this.pinchActive || v.paused || this.dragging || this.locked) return;
        this.startHold2x();
      }, 380);
    });

    shell.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' && this.touchPoints.has(e.pointerId)) {
        this.touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pinchActive && this.touchPoints.size >= 2 && !this.locked) {
          const dist = getTwoTouchDist();
          if (this.pinchStartDist > 0 && dist > 0) {
            const ratio = dist / this.pinchStartDist;
            if (ratio > 1.15 && this.player.getZoomMode() !== 'cover') {
              this.player.setZoomMode('cover');
              this.pinchStartDist = dist;
              this.showToast('Zoomed to fill');
            } else if (ratio < 0.86 && this.player.getZoomMode() !== 'fit') {
              this.player.setZoomMode('fit');
              this.pinchStartDist = dist;
              this.showToast('Original fit');
            }
          }
          return;
        }
      }

      if (!this.pointerDownPos || e.pointerId !== this.pointerDownPos.id) return;
      const dx = Math.abs(e.clientX - this.pointerDownPos.x);
      const dy = Math.abs(e.clientY - this.pointerDownPos.y);
      if (dx > 14 || dy > 14) {
        clearTimeout(this.holdTimer);
        if (!this.holdActive) this.pointerDownPos = null;
      }
    });

    const finishPointer = (e: PointerEvent, cancelled = false) => {
      if (e.pointerType === 'touch') {
        this.touchPoints.delete(e.pointerId);
        if (this.pinchActive) {
          if (this.touchPoints.size === 0) {
            this.pinchActive = false;
            this.pinchStartDist = 0;
          }
          this.suppressClickUntil = Date.now() + 280;
          this.pointerDownPos = null;
          clearTimeout(this.holdTimer);
          return;
        }
      }

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
      this.closeEpisodeWheel();
      this.nextEpWrap.dataset.visible = 'false';
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
  /* Integrated current-audio navigation (no floating language pills)          */
  /* ------------------------------------------------------------------ */

  private syncAudioQuickLabel(): void {
    const st = this.player.getState();
    const tracks = this.player.getAudioTracks();
    const selected = tracks.find((t) => (st.audioId ? t.id === st.audioId : t.lang === st.audioLang));
    const source = this.player.getSources().find((s) => s.id === st.source);
    const lang = selected?.lang ?? st.audioLang ?? source?.audioLang ?? null;
    const label = selected?.label ?? (lang && lang !== 'und' ? languageLabel(lang) : 'Audio');
    this.audioCurrentLabel.textContent = label;
    this.audioCurrentBadge.textContent = audioBadgeLabel(lang);
    this.audioSubsBtn.setAttribute(
      'aria-label',
      lang && lang !== 'und' ? `Audio: ${label}. Change audio and subtitles` : 'Change audio and subtitles',
    );
    this.audioSubsBtn.title = lang && lang !== 'und' ? `Audio: ${label}` : 'Audio & subtitles';
  }

  /* ------------------------------------------------------------------ */
    /* Capability Sync & Branded Source Toggle                             */
  /* ------------------------------------------------------------------ */

  private syncCapabilities(): void {
    const st = this.player.getState();
    const sources = this.player.getSources();
    const ql = this.player.getQualityLevels();

    this.pipBtn.hidden = !st.canPip;
    this.fsBtn.hidden = !st.canFullscreen;
    this.qualityTopBtn.hidden = ql.length === 0 && sources.length < 2;
    this.audioSubsBtn.hidden = false;
    this.syncAudioQuickLabel();

    const d = st.duration;
    this.endsAtBtn.hidden = !(Number.isFinite(d) && d > 0);
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

  private formatClientFinishTime(remainingSec: number): string {
    const endDate = new Date(Date.now() + Math.max(0, remainingSec) * 1000);
    const mm = String(endDate.getMinutes()).padStart(2, '0');
    if (this.endsAt12h) {
      const rawH = endDate.getHours();
      const ampm = rawH >= 12 ? 'PM' : 'AM';
      const h12 = rawH % 12 || 12;
      return `Will End at ${h12}:${mm} ${ampm}`;
    }
    const hh = String(endDate.getHours()).padStart(2, '0');
    return `Will End at ${hh}:${mm}`;
  }

  private refreshTimeReadouts(): void {
    const v = this.player.video;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;

    const curStr = fmtTime(cur);
    if (curStr !== this.lastCurStr) {
      this.lastCurStr = curStr;
      this.curTimeEl.textContent = curStr;
      this.scrub.setAttribute('aria-valuenow', String(Math.round(cur)));
    }

    const durStr =
      this.showRemainingTime && d > 0 ? `-${fmtTime(Math.max(0, d - cur))}` : fmtTime(d);
    if (durStr !== this.lastDurStr) {
      this.lastDurStr = durStr;
      this.durTimeEl.textContent = durStr;
    }

    if (d > 0) {
      if (this.endsAtBtn.hidden) this.endsAtBtn.hidden = false;
      const rate = Math.max(0.25, v.playbackRate || 1);
      const wallRemSec = Math.max(0, d - cur) / rate;
      const endsStr = this.formatClientFinishTime(wallRemSec);
      if (endsStr !== this.lastEndsAtStr) {
        this.lastEndsAtStr = endsStr;
        this.endsAtBtn.textContent = endsStr;
      }
    } else if (!this.endsAtBtn.hidden) {
      this.endsAtBtn.hidden = true;
    }
  }

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

      this.refreshTimeReadouts();
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
      const rVal = ratio(x);
      const p = rVal * 100;
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      if (this.dragging) {
        this.fill.style.width = `${p}%`;
        this.knob.style.left = `${p}%`;
      }
      const clampedTipPct = Math.max(3.5, Math.min(96.5, p));
      this.tip.style.left = `${clampedTipPct}%`;
      this.tip.textContent = fmtTime(rVal * d);
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
    if (this.locked || this.epWheelOpen) {
      if (this.skipBtn.dataset.visible !== 'false') this.skipBtn.dataset.visible = 'false';
      if (this.nextEpWrap.dataset.visible !== 'false') this.nextEpWrap.dataset.visible = 'false';
      return;
    }
    const v = this.player.video;
    const t = v.currentTime;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const hit = this.skipRanges.find((r) => t >= r.start && t < r.end);
    const visible = !!hit;
    if (this.skipBtn.dataset.visible !== String(visible)) {
      this.skipBtn.dataset.visible = String(visible);
    }

    const dm = this.resolveDisplayMedia();
    const nextTarget = dm.mediaType === 'tv' ? this.player.getNextEpisodeTarget() : null;

    if (hit) {
      const span = Math.max(0.1, hit.end - hit.start);
      const pct = Math.max(0, Math.min(100, ((t - hit.start) / span) * 100)).toFixed(1);
      if (pct !== this.lastSkipPct) {
        this.lastSkipPct = pct;
        this.skipBtn.style.setProperty('--elf-skip-pct', `${pct}%`);
      }

      if (hit.kind === 'outro' && nextTarget) {
        const nextTxt = `Next Episode · E${nextTarget.episode} »`;
        if (this.skipLabelEl.textContent !== nextTxt) this.skipLabelEl.textContent = nextTxt;
        this.skipBtn.onclick = () => void this.player.nextEpisode();
      } else {
        const skipTxt = `${hit.label} »`;
        if (this.skipLabelEl.textContent !== skipTxt) this.skipLabelEl.textContent = skipTxt;
        this.skipBtn.onclick = () => this.player.seek(hit.end);
      }
      if (this.nextEpWrap.dataset.visible !== 'false') this.nextEpWrap.dataset.visible = 'false';
      return;
    }

    // End-of-episode pre-warmed Next Episode prompt during final 15s (TV only)
    const epKey = `${dm.season ?? 1}:${dm.episode ?? 1}`;
    const rem = d - t;
    if (
      nextTarget &&
      d > 45 &&
      rem > 0 &&
      rem <= 15 &&
      this.nextEpDismissedKey !== epKey
    ) {
      const countdown = Math.max(1, Math.ceil(rem));
      const nextPct = Math.max(0, Math.min(100, ((15 - rem) / 15) * 100)).toFixed(1);
      this.nextEpBtn.style.setProperty('--elf-next-pct', `${nextPct}%`);
      const lbl = `Next Episode · E${nextTarget.episode} (${countdown}s)`;
      if (this.nextEpLabelEl.textContent !== lbl) this.nextEpLabelEl.textContent = lbl;
      if (this.nextEpWrap.dataset.visible !== 'true') this.nextEpWrap.dataset.visible = 'true';
    } else if (this.nextEpWrap.dataset.visible !== 'false') {
      this.nextEpWrap.dataset.visible = 'false';
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
          if (this.epWheelOpen) {
            this.closeEpisodeWheel();
            e.preventDefault();
            return;
          }
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
    const modes: { id: PanelMode; icon: string; label: string }[] = [
      { id: 'audiosubs', icon: I.audioSubsBox, label: 'Audio & Subtitles' },
    ];
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
    if (this.epWheelOpen) this.closeEpisodeWheel();
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
    clearTimeout(this.pauseIdleTimer);
    this.player.shell.dataset.pauseScreen = 'false';
    this.panel.dataset.open = 'true';
    this.panel.dataset.wide = String(this.panelMode === 'audiosubs');
    this.panelBackdrop.dataset.open = 'true';
    this.qualityTopBtn.dataset.active = String(this.panelMode === 'quality');
    this.audioSubsBtn.dataset.active = String(this.panelMode === 'audiosubs' || this.panelMode === 'style');
    this.buildPanelHeader();
    this.renderPanelBody();
    this.showUI();
  }

  private closePanel(): void {
    this.panel.dataset.open = 'false';
    this.panelBackdrop.dataset.open = 'false';
    this.qualityTopBtn.dataset.active = 'false';
    this.audioSubsBtn.dataset.active = 'false';
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
        this.audioSubsBtn.dataset.active = String(this.panelMode === 'audiosubs');
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
    grid.dataset.dual = 'true';

    /* ---- Column 1: Dynamic Audio Tracks + Phone Speaker Boost (200%) ---- */
    const colAudio = el('div', 'elf-as-col');
    colAudio.appendChild(el('div', 'elf-col-heading', 'Audio'));
    const listAudio = el('div', 'elf-col-list');
    if (audioTracks.length > 0) {
      for (const t of audioTracks) {
        const selected = st.audioId ? t.id === st.audioId : t.lang === st.audioLang;
        const row = this.row(t.label, selected ? 'Selected' : '', selected, () => {
          this.hasRenderedAudioSelection = true;
          void this.player.setAudio(t.id);
          this.renderPanelBody();
        }, audioBadgeLabel(t.lang));
        row.classList.add('elf-audio-option');
        listAudio.appendChild(row);
      }
    } else {
      listAudio.appendChild(this.row('Original', '', true, () => {}));
    }
    colAudio.appendChild(listAudio);

    const boostPct = this.player.getAudioBoost();
    const boostCard = el('div', 'elf-qol-card');
    const boostHead = el('div', 'elf-qol-head');
    boostHead.appendChild(el('span', 'elf-qol-title', 'Speaker Boost'));
    const boostVal = el('span', 'elf-qol-badge', `${boostPct}%`);
    boostVal.dataset.active = String(boostPct > 100);
    boostHead.appendChild(boostVal);

    const boostSlider = el('input', 'elf-boost-range') as HTMLInputElement;
    boostSlider.type = 'range';
    boostSlider.min = '100';
    boostSlider.max = '200';
    boostSlider.step = '5';
    boostSlider.value = String(boostPct);
    boostSlider.setAttribute('aria-label', 'Speaker Boost');

    const boostChips = el('div', 'elf-qol-chips');
    const syncBoostUI = (nextPct: number) => {
      this.player.setAudioBoost(nextPct);
      const actual = this.player.getAudioBoost();
      boostSlider.value = String(actual);
      boostVal.textContent = `${actual}%`;
      boostVal.dataset.active = String(actual > 100);
      boostChips.querySelectorAll('button').forEach((b) => {
        b.dataset.on = String(Number((b as HTMLButtonElement).dataset.pct) === actual);
      });
    };

    boostSlider.oninput = () => syncBoostUI(Number(boostSlider.value));

    for (const preset of [100, 150, 200]) {
      const chip = el('button', 'elf-qol-chip', `${preset}%`) as HTMLButtonElement;
      chip.dataset.pct = String(preset);
      chip.dataset.on = String(boostPct === preset);
      chip.onclick = () => {
        syncBoostUI(preset);
        this.showToast(preset > 100 ? `Speaker Boost · ${preset}%` : 'Speaker Boost · Normal');
      };
      boostChips.appendChild(chip);
    }

    boostCard.append(boostHead, boostSlider, boostChips);
    colAudio.appendChild(boostCard);
    grid.appendChild(colAudio);

    /* ---- Column 2: Dynamic Subtitles + Subtitle Sync Fixer (-0.5s / +0.5s) ---- */
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

    const fmtOffset = (sec: number) =>
      sec === 0 ? '0.0s' : `${sec > 0 ? '+' : ''}${sec.toFixed(1)}s`;
    const curOffset = this.player.getSubtitleOffset();
    const syncCard = el('div', 'elf-qol-card');
    const syncHead = el('div', 'elf-qol-head');
    syncHead.appendChild(el('span', 'elf-qol-title', 'Subtitle Sync'));
    const syncVal = el('span', 'elf-qol-badge', fmtOffset(curOffset));
    syncVal.dataset.active = String(curOffset !== 0);
    syncHead.appendChild(syncVal);

    const syncChips = el('div', 'elf-qol-chips');
    const updateSync = (nextSec: number) => {
      this.player.setSubtitleOffset(nextSec);
      const actual = this.player.getSubtitleOffset();
      const txt = fmtOffset(actual);
      syncVal.textContent = txt;
      syncVal.dataset.active = String(actual !== 0);
      resetChip.disabled = actual === 0;
      this.showToast(`Subtitle sync · ${txt}`);
    };

    const minusChip = el('button', 'elf-qol-chip', '−0.5s') as HTMLButtonElement;
    minusChip.onclick = () => updateSync(this.player.getSubtitleOffset() - 0.5);

    const resetChip = el('button', 'elf-qol-chip', 'Reset') as HTMLButtonElement;
    resetChip.disabled = curOffset === 0;
    resetChip.onclick = () => updateSync(0);

    const plusChip = el('button', 'elf-qol-chip', '+0.5s') as HTMLButtonElement;
    plusChip.onclick = () => updateSync(this.player.getSubtitleOffset() + 0.5);

    syncChips.append(minusChip, resetChip, plusChip);
    syncCard.append(syncHead, syncChips);
    colSubs.appendChild(syncCard);

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
    // Only real, selectable renditions get a row: height-less levels are a
    // single fixed rendition already covered by "Auto" (never a "0k" row).
    const seenHeights = new Set<number>();
    for (const l of this.player.getQualityLevels()) {
      if (!l.height || l.height <= 0 || seenHeights.has(l.height)) continue;
      seenHeights.add(l.height);
      this.panelBody.appendChild(
        this.row(l.label || `${l.height}p`, '', st.qualityMode === String(l.height), () => {
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
      // Only the active engine knows which manifest representations the
      // current browser can actually select. Do not promise a ladder for an
      // unloaded source based solely on backend manifest metadata.
      const optionCount = s.id === st.source
        ? new Set(this.player.getQualityLevels().map((level) => level.height).filter((height) => height > 0)).size
        : 0;
      const badge =
        optionCount > 1
          ? `${qualityBadge ? `${qualityBadge} · ` : ''}${optionCount} QUALITIES`
          : qualityBadge;
      this.panelBody.appendChild(
        this.row(s.label, badge, s.id === st.source, () => {
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

  private row(label: string, sub: string, selected: boolean, onClick: () => void, badge?: string) {
    const b = el('button', 'elf-menu-item') as HTMLButtonElement;
    b.dataset.selected = String(selected);
    b.setAttribute('aria-pressed', String(selected));
    b.innerHTML = `${badge ? `<span class="elf-mi-lang" aria-hidden="true">${esc(badge)}</span>` : ''}<span class="elf-mi-check">${I.check}</span><span class="elf-mi-label">${esc(label)}${
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
  /* Right-Hand Curved/Fading Scroll-Wheel Episode Selector (TV Only)    */
  /* ------------------------------------------------------------------ */

  private toggleEpisodeWheel(): void {
    if (this.locked) return;
    if (this.epWheelOpen) {
      this.closeEpisodeWheel();
    } else {
      void this.openEpisodeWheel();
    }
  }

  private async openEpisodeWheel(targetSeason?: number): Promise<void> {
    const dm = this.resolveDisplayMedia();
    if (dm.mediaType !== 'tv') return;

    if (this.panel.dataset.open === 'true') this.closePanel();
    clearTimeout(this.hideTimer);
    clearTimeout(this.pauseIdleTimer);

    this.epWheelOpen = true;
    this.triggerBtnPop(this.episodesBtn);
    this.epWheelSeason = Math.max(1, targetSeason ?? dm.season ?? this.player.config.season ?? 1);
    this.epWheelOverlay.dataset.open = 'true';
    this.episodesBtn.dataset.active = 'true';
    this.episodesBtn.setAttribute('aria-expanded', 'true');
    this.player.shell.dataset.pauseScreen = 'false';
    this.player.shell.dataset.epWheel = 'true';

    const cached = this.player.getSeasonCatalog(this.epWheelSeason);
    if (cached) {
      this.epWheelSeasons = cached.seasons;
      this.epWheelEpisodes = cached.episodes;
      this.renderEpisodeWheelDOM();
    } else {
      this.epWheelList.innerHTML = '<div class="elf-ep-wheel-loading">Loading episodes…</div>';
      const cat = await this.player.fetchSeasonEpisodes(this.epWheelSeason);
      if (!this.epWheelOpen) return;
      this.epWheelSeasons = cat.seasons;
      this.epWheelEpisodes = cat.episodes;
      this.renderEpisodeWheelDOM();
    }
  }

  private closeEpisodeWheel(): void {
    if (!this.epWheelOpen && this.epWheelOverlay.dataset.open !== 'true') return;
    this.epWheelOpen = false;
    this.epWheelOverlay.dataset.open = 'false';
    this.episodesBtn.dataset.active = 'false';
    this.episodesBtn.setAttribute('aria-expanded', 'false');
    this.player.shell.dataset.epWheel = 'false';
    if (this.player.video.paused && this.hasStartedPlayback) {
      this.schedulePauseScreen(2600);
    } else {
      this.scheduleHide();
    }
  }

  private renderEpisodeWheelDOM(): void {
    const dm = this.resolveDisplayMedia();
    const activePlaySeason = dm.season ?? this.player.config.season ?? 1;
    const activePlayEpisode = dm.episode ?? this.player.config.episode ?? 1;

    this.epWheelSeasonsEl.replaceChildren();
    if (this.epWheelSeasons.length > 1) {
      for (const s of this.epWheelSeasons) {
        const pill = el('button', 'elf-ep-season-pill', `S${s.seasonNumber}`) as HTMLButtonElement;
        pill.dataset.on = String(s.seasonNumber === this.epWheelSeason);
        pill.title = s.name;
        pill.onclick = (e) => {
          e.stopPropagation();
          if (s.seasonNumber !== this.epWheelSeason) {
            void this.openEpisodeWheel(s.seasonNumber);
          }
        };
        this.epWheelSeasonsEl.appendChild(pill);
      }
      this.epWheelSeasonsEl.hidden = false;
    } else {
      this.epWheelSeasonsEl.hidden = true;
    }

    this.epWheelList.replaceChildren();
    const topSpacer = el('div', 'elf-ep-wheel-pad');
    const bottomSpacer = el('div', 'elf-ep-wheel-pad');
    this.epWheelList.appendChild(topSpacer);

    let activeItemEl: HTMLElement | null = null;

    for (const ep of this.epWheelEpisodes) {
      const isPlaying =
        this.epWheelSeason === activePlaySeason && ep.episodeNumber === activePlayEpisode;

      const item = el('button', 'elf-ep-wheel-item') as HTMLButtonElement;
      item.dataset.playing = String(isPlaying);
      item.dataset.ep = String(ep.episodeNumber);

      const thumb = el('span', 'elf-epw-thumb');
      const thumbFallback = el('span', 'elf-epw-thumb-fallback', String(ep.episodeNumber));
      thumb.appendChild(thumbFallback);
      if (ep.still) {
        const image = document.createElement('img');
        image.src = ep.still;
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.onerror = () => {
          image.remove();
          thumb.dataset.missing = 'true';
        };
        thumb.appendChild(image);
      } else {
        thumb.dataset.missing = 'true';
      }
      const copy = el('span', 'elf-epw-copy');
      const titleLine = el('span', 'elf-epw-title', `Episode ${ep.episodeNumber}`);
      const cleanName =
        ep.name && !/^episode\s+\d+$/i.test(ep.name.trim())
          ? ep.name.trim()
          : ep.runtime
            ? `${ep.runtime} min`
            : `Season ${this.epWheelSeason}`;
      const subLine = el('span', 'elf-epw-sub', esc(cleanName));

      const statusLine = el(
        'span',
        'elf-epw-status',
        isPlaying
          ? `<span class="elf-epw-live">Playing</span><span class="elf-epw-ico">${I.playingScreen}</span>`
          : `<span class="elf-epw-queue">Queue</span><span class="elf-epw-dash">—</span>`,
      );

      copy.append(titleLine, subLine, statusLine);
      item.append(thumb, copy);
      item.onclick = (e) => {
        e.stopPropagation();
        if (isPlaying) {
          this.closeEpisodeWheel();
          return;
        }
        const chosenS = this.epWheelSeason;
        const chosenE = ep.episodeNumber;
        this.closeEpisodeWheel();
        void this.player.loadEpisode(chosenS, chosenE);
      };

      this.epWheelList.appendChild(item);
      if (isPlaying || (!activeItemEl && ep.episodeNumber === 1)) {
        activeItemEl = item;
      }
    }

    this.epWheelList.appendChild(bottomSpacer);

    requestAnimationFrame(() => {
      if (activeItemEl) {
        const listH = this.epWheelList.clientHeight;
        const targetTop =
          activeItemEl.offsetTop - listH / 2 + activeItemEl.offsetHeight / 2;
        this.epWheelList.scrollTop = Math.max(0, targetTop);
      }
      this.syncWheelCurve();
    });
  }

  private syncWheelCurve(): void {
    if (!this.epWheelOpen) return;
    const listRect = this.epWheelList.getBoundingClientRect();
    if (!listRect.height) return;
    const centerY = listRect.top + listRect.height * 0.5;
    const halfSpan = Math.max(120, listRect.height * 0.48);

    const items = this.epWheelList.querySelectorAll<HTMLElement>('.elf-ep-wheel-item');
    items.forEach((item) => {
      const r = item.getBoundingClientRect();
      const itemCenter = r.top + r.height * 0.5;
      const norm = Math.min(1, Math.abs(itemCenter - centerY) / halfSpan);
      const scale = 1 - norm * 0.17;
      const opacity = 1 - norm * 0.78;
      const shiftX = norm * norm * 16;
      item.style.opacity = opacity.toFixed(2);
      item.style.transform = `translate3d(${shiftX.toFixed(1)}px, 0, 0) scale(${scale.toFixed(3)})`;
      item.dataset.focus = String(norm < 0.24);
    });
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
    if (
      this.player.video.paused ||
      this.panel.dataset.open === 'true' ||
      this.epWheelOpen ||
      this.locked
    ) {
      return;
    }
    this.hideTimer = window.setTimeout(() => {
      if (
        this.player.video.paused ||
        this.panel.dataset.open === 'true' ||
        this.epWheelOpen ||
        this.locked
      ) {
        return;
      }
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
    clearTimeout(this.singleTapTimer);
    clearTimeout(this.dtapResetTimer);
    clearTimeout(this.dtapHideLeftTimer);
    clearTimeout(this.dtapHideRightTimer);
    clearTimeout(this.holdTimer);
    clearTimeout(this.lockPeekTimer);
    this.hideInitialLoading();
    this.previewRenderer?.destroy();
  }
}

const trim = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
