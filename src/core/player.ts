/**
 * Elfura Player — core
 * ====================
 * Orchestration only. No UI, no hardcoded lists, no fixed stream.
 *
 *   engine adapter      hls.js / dash.js / native <video>  (sniffed, overridable)
 *   audio layer         native muxed tracks + external dubs (see core/audio.ts)
 *   subtitle layer      our own renderer, never the engine's (see subs/*)
 *
 * "Dynamic" rules the UI relies on, all of which come from events here:
 *   qualityLevels   -> populated by the manifest, never a fixed list
 *   effectiveHeight -> LEVEL_SWITCHED, so "Auto [240p]" shows the truth
 *   audioTracks / subtitleTracks -> tabs only exist when a stream offers them
 *   capability flags -> PiP / fullscreen buttons only when the browser has them
 */

/**
 * Engine adapters are loaded on demand: an HLS title never pays for dash.js and
 * vice-versa, so the embed's initial parse stays at ~25 KB gzip instead of
 * shipping both engines up front. Type-only imports keep the bundler honest.
 */
import type Hls from 'hls.js';
import type { MediaPlayerClass, MediaInfo } from 'dashjs';

type HlsCtor = typeof Hls;

let hlsCtorPromise: Promise<HlsCtor> | null = null;
function getHls(): Promise<HlsCtor> {
  if (!hlsCtorPromise) hlsCtorPromise = import('hls.js').then((m) => m.default);
  return hlsCtorPromise;
}
let dashFactoryPromise: Promise<typeof import('dashjs').MediaPlayer> | null = null;
function getDash(): Promise<typeof import('dashjs').MediaPlayer> {
  if (!dashFactoryPromise) dashFactoryPromise = import('dashjs').then((m) => m.MediaPlayer);
  return dashFactoryPromise;
}

import {
  buildTrackList,
  ExternalAudioSync,
  languageLabel,
  loadPreferredAudio,
  pickTrack,
  savePreferredAudio,
  type AudioTrack,
} from './audio';
import { EventBus, PostMessageBridge, type CommandName, type EventName } from './events';
import { resolveInput, type ElfuraConfig, type ResolvedInput } from './config';
import { fetchCues, parseCues, type Cue } from '../subs/parser';
import { SubtitleRenderer } from '../subs/renderer';
import { DEFAULT_SUB_STYLE, saveStoredStyle, type SubtitleStyle } from '../subs/style';

export interface SubtitleTrack {
  id: string;
  kind: 'native' | 'external';
  lang: string;
  label: string;
  url?: string;
}

export interface QualityLevel {
  id: number;
  height: number;
  width: number;
  bitrate: number;
  label: string;
}

export interface PlayerState {
  playing: boolean;
  time: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  speed: number;
  /** What the user asked for: 'auto' or a height. */
  qualityMode: string;
  /** What the ABR actually picked right now (0 until known). */
  effectiveHeight: number;
  audioLang: string | null;
  subtitleLang: string | null;
  subtitlesOn: boolean;
  server: string | null;
  fullscreen: boolean;
  canPip: boolean;
  canFullscreen: boolean;
}

export interface ElfuraPlayerOptions extends ElfuraConfig {
  root?: HTMLElement;
}

type EngineKind = 'hls' | 'dash' | 'native';

/** Methods dash.js ships but its .d.ts omits. Kept tiny and cast once. */
interface DashExtras {
  getBitrateInfoListFor(type: 'video' | 'audio'): { bitrate: number; height: number; width: number; qualityIndex: number }[];
  setQualityFor(type: 'video' | 'audio', quality: number): void;
  getQualityFor(type: 'video' | 'audio'): number;
}

export class ElfuraPlayer {
  readonly sessionId = Math.random().toString(36).slice(2, 10);
  readonly bus = new EventBus();
  readonly video: HTMLVideoElement;
  readonly shell: HTMLElement;
  readonly surface: HTMLElement;

  private input: ResolvedInput;
  private HlsClass: HlsCtor | null = null;
  private engineKind: EngineKind | null = null;
  private hls: Hls | null = null;
  private dash: MediaPlayerClass | null = null;
  private externalAudio = new ExternalAudioSync();

  private audioTracks: AudioTrack[] = [];
  private currentAudio: AudioTrack | null = null;
  private subtitleTracks: SubtitleTrack[] = [];
  private currentSubtitle: SubtitleTrack | null = null;
  private cues: Cue[] = [];
  private qualityLevels: QualityLevel[] = [];
  private qualityMode = 'auto';
  private effectiveHeight = 0;

  renderer: SubtitleRenderer | null = null;
  bridge!: PostMessageBridge;

  private fatalCount = 0;
  private destroyed = false;

  constructor(options: ElfuraPlayerOptions = {}, search = window.location.search) {
    this.input = resolveInput(options, search);
    const cfg = this.input.config;

    this.shell = options.root ?? document.createElement('div');
    this.shell.classList.add('elf-shell');
    this.shell.dataset.skin = cfg.skin ?? 'dark';
    this.shell.style.setProperty('--elf-accent', cfg.color ?? '#ff5c39');

    this.surface = document.createElement('div');
    this.surface.className = 'elf-surface';
    this.video = document.createElement('video');
    this.video.className = 'elf-video';
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.preload = 'metadata';
    if (cfg.poster) this.video.poster = cfg.poster;
    if (cfg.loop) this.video.loop = true;
    this.surface.appendChild(this.video);
    this.shell.appendChild(this.surface);

    this.externalAudio.bind(this.video);

    this.renderer = new SubtitleRenderer(
      { host: this.surface, onStyleChange: (s) => this.emit('subtitleStyle', s), draggable: true },
      this.input.subtitleStyle,
    );
    this.renderer.bindClock(() => this.video.currentTime);
    this.renderer.setEnabled(cfg.subtitles !== false);

    this.setupBridge();
    this.bindMediaEvents();

    if (cfg.src) void this.load(String(cfg.src));
  }

  /* ------------------------------------------------------------------ */
  /* API — identical surface to the postMessage commands                  */
  /* ------------------------------------------------------------------ */

  get config(): ResolvedInput['config'] {
    return this.input.config;
  }

  get engine(): EngineKind | null {
    return this.engineKind;
  }

  getState(): PlayerState {
    const v = this.video;
    return {
      playing: !v.paused && !v.ended,
      time: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
      volume: v.volume,
      muted: v.muted,
      speed: v.playbackRate,
      qualityMode: this.qualityMode,
      effectiveHeight: this.effectiveHeight,
      audioLang: this.currentAudio?.lang ?? null,
      subtitleLang: this.currentSubtitle?.lang ?? null,
      subtitlesOn: this.renderer?.getEnabled() ?? false,
      server: this.input.config.server ?? null,
      fullscreen: document.fullscreenElement === this.shell,
      canPip: typeof v.requestPictureInPicture === 'function' && !v.disablePictureInPicture,
      canFullscreen: typeof this.shell.requestFullscreen === 'function',
    };
  }

  getAudioTracks(): AudioTrack[] {
    return this.audioTracks;
  }
  getSubtitleTracks(): SubtitleTrack[] {
    return this.subtitleTracks;
  }
  getQualityLevels(): QualityLevel[] {
    return this.qualityLevels;
  }
  getCues(): Cue[] {
    return this.cues;
  }

  async load(url: string, typeHint?: string): Promise<void> {
    const kind = (typeHint ?? this.input.config.type ?? 'auto') as string;
    const engine: EngineKind = kind === 'auto' ? sniff(url) : (kind as EngineKind);
    this.teardownEngine();
    this.engineKind = engine;
    this.fatalCount = 0;

    if (engine === 'hls') void this.loadHls(url);
    else if (engine === 'dash') void this.loadDash(url);
    else this.loadNative(url);

    this.applyInitialPrefs();
  }

  play(): Promise<void> {
    return this.video.play().catch((e) => {
      this.emit('error', { code: 'play-failed', message: String(e) });
    });
  }
  pause(): void {
    this.video.pause();
  }
  toggle(): void {
    if (this.video.paused) void this.play();
    else this.video.pause();
  }
  seek(t: number): void {
    const d = Number.isFinite(this.video.duration) ? this.video.duration : Infinity;
    this.video.currentTime = Math.max(0, Math.min(t, d));
  }
  skipBy(delta: number): void {
    this.seek(this.video.currentTime + delta);
  }
  setVolume(v: number): void {
    this.video.volume = Math.max(0, Math.min(1, v));
  }
  setMuted(m: boolean): void {
    this.video.muted = m;
  }
  setSpeed(s: number): void {
    this.video.playbackRate = Math.max(0.25, Math.min(4, s));
  }

  async setAudio(idOrLang: string): Promise<boolean> {
    const track = this.audioTracks.find((t) => t.id === idOrLang) ?? pickTrack(this.audioTracks, idOrLang);
    if (!track) return false;

    if (track.kind === 'native') {
      this.externalAudio.deactivate();
      if (this.hls && typeof track.ref === 'number') this.hls.audioTrack = track.ref;
      else if (this.dash) {
        const native = this.dash.getTracksFor('audio').find((t) => t.lang?.toLowerCase() === track.lang);
        if (native) this.dash.setCurrentTrack(native);
      }
    } else {
      const res = await this.externalAudio.activate(track);
      if (!res.ok) {
        this.emit('error', { code: 'audio-load-failed', message: res.error, lang: track.lang });
        return false;
      }
    }

    this.currentAudio = track;
    if (this.input.config.persistAudio) savePreferredAudio(track.lang);
    this.emit('audioChange', { id: track.id, lang: track.lang, label: track.label, kind: track.kind });
    return true;
  }

  async setSubtitle(idOrLang: string | null): Promise<boolean> {
    if (idOrLang === null) {
      this.currentSubtitle = null;
      this.renderer?.setEnabled(false);
      if (this.hls) this.hls.subtitleTrack = -1;
      this.emit('subtitleChange', { id: null, lang: null });
      return true;
    }
    const track =
      this.subtitleTracks.find((t) => t.id === idOrLang) ??
      this.subtitleTracks.find((t) => t.lang === idOrLang || t.lang.split('-')[0] === String(idOrLang).split('-')[0]);
    if (!track) return false;

    this.currentSubtitle = track;
    this.renderer?.setEnabled(true);
    await this.loadSubtitleCues(track);
    this.emit('subtitleChange', { id: track.id, lang: track.lang, label: track.label });
    return true;
  }

  setSubtitleStyle(patch: Partial<SubtitleStyle>): void {
    this.renderer?.setStyle(patch);
    if (this.input.config.persistSubs) {
      const s = this.renderer?.getStyle();
      if (s) saveStoredStyle(s);
    }
  }

  resetSubtitleStyle(): void {
    this.renderer?.replaceStyle({ ...DEFAULT_SUB_STYLE });
  }
  getSubtitleStyle(): SubtitleStyle {
    return this.renderer?.getStyle() ?? { ...DEFAULT_SUB_STYLE };
  }

  setQuality(mode: string | number): void {
    const want = String(mode);
    if (want === 'auto' || want === '-1') {
      this.qualityMode = 'auto';
      if (this.hls) this.hls.currentLevel = -1;
      else if (this.dash) (this.dash as unknown as DashExtras).setQualityFor('video', -1);
      this.emit('qualityChange', { mode: 'auto', effectiveHeight: this.effectiveHeight });
      return;
    }
    const height = Number(want);
    if (!Number.isFinite(height)) return;
    const level =
      this.qualityLevels.find((l) => l.height === height) ??
      [...this.qualityLevels].sort((a, b) => Math.abs(a.height - height) - Math.abs(b.height - height))[0];
    if (!level) return;
    if (this.hls) this.hls.currentLevel = level.id;
    else if (this.dash) (this.dash as unknown as DashExtras).setQualityFor('video', level.id);
    this.qualityMode = String(level.height);
    this.effectiveHeight = level.height;
    this.emit('qualityChange', { mode: this.qualityMode, effectiveHeight: level.height });
  }

  async togglePip(): Promise<boolean> {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
      return true;
    } catch (err) {
      this.emit('error', { code: 'pip-failed', message: String(err) });
      return false;
    }
  }

  async fullscreen(on = true): Promise<void> {
    try {
      if (on && document.fullscreenElement !== this.shell) await this.shell.requestFullscreen();
      else if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch (err) {
      this.emit('error', { code: 'fullscreen-failed', message: String(err) });
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.teardownEngine();
    this.externalAudio.destroy();
    this.renderer?.destroy();
    this.bus.clear();
    this.video.removeAttribute('src');
    this.video.load();
  }

  /* ------------------------------------------------------------------ */
  /* Engines                                                             */
  /* ------------------------------------------------------------------ */

  private teardownEngine(): void {
    this.hls?.destroy();
    this.hls = null;
    if (this.dash) {
      this.dash.reset();
      this.dash = null;
    }
    this.audioTracks = [];
    this.qualityLevels = [];
    this.currentAudio = null;
    this.effectiveHeight = 0;
  }

  private async loadHls(url: string): Promise<void> {
    const cfg = this.input.config;
    const Hls = await getHls();
    this.HlsClass = Hls;
    if (this.destroyed) return;

    if (!Hls.isSupported()) {
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.engineKind = 'native';
        this.video.src = this.decorate(url);
        void this.handleAutoplay();
      } else {
        this.emit('error', { code: 'hls-unsupported', message: 'No MSE and no native HLS' });
      }
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      backBufferLength: 90,
      xhrSetup: (xhr) => {
        if (cfg.pltoken) xhr.setRequestHeader('X-Playback-Token', String(cfg.pltoken));
      },
    });
    this.hls = hls;

    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      this.qualityLevels = data.levels
        .map((l, i) => ({
          id: i,
          height: l.height ?? 0,
          width: l.width ?? 0,
          bitrate: l.bitrate ?? 0,
          label: l.height ? `${l.height}p` : `${Math.round((l.bitrate ?? 0) / 1000)}k`,
        }))
        .sort((a, b) => b.height - a.height);
      this.emit('qualityLevels', this.qualityLevels);
      this.applyQualityCap();
    });

    // The truth behind "Auto": what ABR is really serving right now.
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const level = this.qualityLevels.find((l) => l.id === data.level);
      if (!level) return;
      this.effectiveHeight = level.height;
      this.emit('qualityEffective', { height: level.height, label: level.label, mode: this.qualityMode });
    });

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_e, data) => {
      this.mergeNativeAudio(
        data.audioTracks.map((t, i) => ({
          id: t.id ?? i,
          lang: t.lang ?? 'und',
          label: t.name || undefined,
          default: !!t.default,
        })),
      );
    });

    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, data) => {
      this.subtitleTracks = (data.subtitleTracks ?? []).map((t) => ({
        id: `native:${t.id}`,
        kind: 'native' as const,
        lang: (t.lang ?? 'und').toLowerCase(),
        label: languageLabel(t.lang ?? 'und', t.name || undefined),
        url: t.url,
      }));
      this.mergeExternalSubs();
      this.emit('subtitleTracks', this.subtitleTracks);
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      this.handleFatal(data.type, url);
    });

    hls.loadSource(this.decorate(url));
    hls.attachMedia(this.video);
    void this.handleAutoplay();
  }

  private async loadDash(url: string): Promise<void> {
    const Dash = await getDash();
    if (this.destroyed) return;
    const player = Dash().create();
    this.dash = player;
    player.initialize(this.video, this.decorate(url), false);

    player.on(Dash.events.STREAM_INITIALIZED, () => {
      this.mergeNativeAudio(
        player.getTracksFor('audio').map((t: MediaInfo, i: number) => ({
          id: i,
          lang: t.lang ?? 'und',
          label: t.labels?.length ? String(t.labels[0].text) : undefined,
          default: i === 0,
        })),
      );
      const extras = player as unknown as DashExtras;
      this.qualityLevels = extras
        .getBitrateInfoListFor('video')
        .map((b) => ({
          id: b.qualityIndex,
          height: b.height,
          width: b.width,
          bitrate: b.bitrate,
          label: b.height ? `${b.height}p` : `${Math.round(b.bitrate / 1000)}k`,
        }))
        .sort((a, b) => b.height - a.height);
      this.emit('qualityLevels', this.qualityLevels);

      this.subtitleTracks = player.getTracksFor('text').map((t: MediaInfo, i: number) => ({
        id: `native:text:${i}`,
        kind: 'native' as const,
        lang: (t.lang ?? 'und').toLowerCase(),
        label: languageLabel(t.lang ?? 'und'),
      }));
      this.mergeExternalSubs();
      this.emit('subtitleTracks', this.subtitleTracks);
    });

    player.on(Dash.events.QUALITY_CHANGE_RENDERED, (e: { mediaType?: string; newQuality?: number }) => {
      if (e.mediaType !== 'video') return;
      const level = this.qualityLevels.find((l) => l.id === e.newQuality);
      if (!level) return;
      this.effectiveHeight = level.height;
      this.emit('qualityEffective', { height: level.height, label: level.label, mode: this.qualityMode });
    });

    player.on(Dash.events.ERROR, (e: { error?: unknown; message?: string }) => {
      this.emit('error', { code: 'dash-error', message: e.message ?? String(e.error ?? 'unknown') });
      this.failover();
    });

    void this.handleAutoplay();
  }

  private loadNative(url: string): void {
    this.video.src = this.decorate(url);
    void this.handleAutoplay();
  }

  private decorate(url: string): string {
    const cfg = this.input.config;
    if (!cfg.pltoken || !cfg.nonce) return url;
    try {
      const u = new URL(url, window.location.href);
      u.searchParams.set('nonce', String(cfg.nonce));
      return u.toString();
    } catch {
      return url;
    }
  }

  private async handleAutoplay(): Promise<void> {
    const cfg = this.input.config;
    if (cfg.t) this.seek(cfg.t);
    if (cfg.speed && cfg.speed !== 1) this.setSpeed(cfg.speed);
    if (cfg.volume !== undefined) this.setVolume(cfg.volume);
    if (cfg.muted) this.setMuted(true);
    if (!cfg.autoplay) return;
    try {
      await this.video.play();
    } catch {
      this.video.muted = true;
      try {
        await this.video.play();
        this.emit('autoplay:blocked', { recovered: 'muted' });
      } catch {
        this.emit('autoplay:blocked', { recovered: null });
      }
    }
  }

  private applyQualityCap(): void {
    const q = this.input.config.quality;
    if (!q || q === 'auto' || !this.hls) return;
    const cap = Number(q);
    if (!Number.isFinite(cap)) return;
    const allowed = this.qualityLevels.filter((l) => l.height > 0 && l.height <= cap);
    this.hls.autoLevelCapping = allowed.length ? Math.max(...allowed.map((l) => l.height)) : -1;
  }

  private handleFatal(type: string, url: string): void {
    this.fatalCount++;
    const Hls = this.HlsClass;
    if (this.hls && Hls) {
      if (type === Hls.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
      else if (type === Hls.ErrorTypes.NETWORK_ERROR && this.fatalCount < 3) this.hls.startLoad();
    }
    this.emit('error', { code: 'fatal', type, fatalCount: this.fatalCount, url });
    this.failover();
  }

  /** Walk `servers` on fatal error; the UI toasts, the user never sees a dead player. */
  private failover(): void {
    const cfg = this.input.config;
    const servers = cfg.servers ?? [];
    if (servers.length < 2) return;
    const currentIdx = servers.findIndex((s) => s.url === cfg.src);
    const next = servers[currentIdx + 1];
    if (!next) return;
    this.emit('server:switch', { from: cfg.server ?? servers[currentIdx]?.lang ?? null, to: next.lang, reason: 'fatal-error' });
    cfg.src = next.url;
    cfg.server = next.lang;
    void this.load(next.url);
  }

  /* ------------------------------------------------------------------ */
  /* Tracks                                                              */
  /* ------------------------------------------------------------------ */

  private mergeNativeAudio(native: { id: number; lang: string; label?: string; default?: boolean }[]): void {
    const external = (this.input.config.audioTracks ?? []).map((x) => ({ lang: x.lang, label: x.label, url: x.url }));
    this.audioTracks = buildTrackList({ native, external });
    this.emit('audioTracks', this.audioTracks);
    this.applyInitialAudio();
  }

  private mergeExternalSubs(): void {
    const external = (this.input.config.subsrc ?? []).map((x, i) => ({
      id: `external:${x.lang}:${i}`,
      kind: 'external' as const,
      lang: (x.lang || 'und').toLowerCase(),
      label: languageLabel(x.lang, x.label),
      url: x.url,
    }));
    const merged = [...this.subtitleTracks];
    for (const e of external) if (!merged.some((t) => t.lang === e.lang)) merged.push(e);
    this.subtitleTracks = merged;
    this.emit('subtitleTracks', this.subtitleTracks);
    this.applyInitialSubtitle();
  }

  private applyInitialPrefs(): void {
    this.applyInitialAudio();
    this.applyInitialSubtitle();
  }

  private applyInitialAudio(): void {
    if (this.currentAudio || !this.audioTracks.length) return;
    const pick = pickTrack(this.audioTracks, this.input.config.lang ?? loadPreferredAudio());
    if (pick) void this.setAudio(pick.id);
  }

  private applyInitialSubtitle(): void {
    if (this.currentSubtitle || !this.subtitleTracks.length) return;
    if (this.input.config.subtitles === false) return;
    const want = this.input.config.sublang;
    const pick =
      (want && this.subtitleTracks.find((t) => t.lang === want || t.lang.split('-')[0] === want.split('-')[0])) ??
      null;
    if (pick) void this.setSubtitle(pick.id);
  }

  /**
   * Native HLS subtitles arrive as a media playlist of .vtt segments, not one
   * file. Resolve it, concatenate in order, then parse with our own parser so
   * styling stays under our control.
   */
  private async loadSubtitleCues(track: SubtitleTrack): Promise<void> {
    const grab = async (u: string) => (await fetch(u, { credentials: 'omit' })).text();
    try {
      if (track.kind === 'external' && track.url) {
        const res = await fetchCues(track.url);
        this.cues = res.cues;
        this.renderer?.setCues(this.cues);
        return;
      }
      if (track.url) {
        const body = await grab(track.url);
        if (!/#EXTINF/i.test(body)) {
          const res = parseCues(body, track.url);
          this.cues = res.cues;
          this.renderer?.setCues(this.cues);
          return;
        }
        const base = new URL(track.url, window.location.href);
        const segs = [...body.matchAll(/^([^#\s][^\n]*\.vtt[^\n]*)$/gim)].map((m) => m[1].trim());
        const parts: string[] = [];
        for (const seg of segs) {
          try {
            parts.push(await grab(new URL(seg, base).toString()));
          } catch {
            /* skip an unavailable segment */
          }
        }
        const res = parseCues(parts.join('\n'), track.url);
        this.cues = res.cues;
        this.renderer?.setCues(this.cues);
        return;
      }
      this.cues = [];
      this.renderer?.setCues(this.cues);
    } catch (err) {
      this.emit('error', { code: 'subtitle-load-failed', message: String(err), lang: track.lang });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Events / bridge                                                     */
  /* ------------------------------------------------------------------ */

  private emit(name: EventName, data?: unknown): void {
    this.bus.emit(name, data);
  }

  private bindMediaEvents(): void {
    const v = this.video;
    v.addEventListener('play', () => this.emit('play', {}));
    v.addEventListener('pause', () => this.emit('pause', {}));
    v.addEventListener('ended', () => {
      this.emit('ended', {});
      if (this.input.config.autoplayNextEp || this.input.config.next) this.emit('episode:next', {});
    });
    v.addEventListener('waiting', () => this.emit('buffering', {}));
    v.addEventListener('playing', () => this.emit('buffered', {}));
    v.addEventListener('durationchange', () => {
      this.emit('durationchange', { duration: v.duration });
      this.emit('segments:invalidate', {});
    });
    v.addEventListener('volumechange', () => this.emit('volumechange', { volume: v.volume, muted: v.muted }));
    v.addEventListener('ratechange', () => this.emit('speedchange', { speed: v.playbackRate }));
    document.addEventListener('fullscreenchange', () =>
      this.emit('fullscreen', { on: document.fullscreenElement === this.shell }),
    );
  }

  private setupBridge(): void {
    const cfg = this.input.config;
    this.bridge = new PostMessageBridge({
      sessionId: this.sessionId,
      targetOrigin: cfg.origin ?? inferParentOrigin() ?? '*',
      enabled: cfg.postMessage !== false,
      debug: cfg.debug,
    });
    this.bridge.bind(this.bus);

    const val = (d: unknown) => (d as { value?: unknown })?.value ?? d;
    const cmd = (name: CommandName, fn: (data: unknown) => unknown | Promise<unknown>) => this.bridge.register(name, fn);

    cmd('play', () => this.play());
    cmd('pause', () => this.pause());
    cmd('toggle', () => this.toggle());
    cmd('seek', (d) => this.seek(Number(val(d))));
    cmd('skip', (d) => this.skipBy(Number(val(d)) || 10));
    cmd('setVolume', (d) => this.setVolume(Number(val(d))));
    cmd('mute', (d) => this.setMuted(val(d) !== false));
    cmd('setSpeed', (d) => this.setSpeed(Number(val(d))));
    cmd('setQuality', (d) => this.setQuality(String(val(d))));
    cmd('setAudio', async (d) => this.setAudio(String(val(d))));
    cmd('setSubtitle', async (d) => {
      const v = val(d);
      return this.setSubtitle(v === null || v === 'off' || v === false ? null : String(v));
    });
    cmd('setSubtitleStyle', (d) => this.setSubtitleStyle((val(d) as Partial<SubtitleStyle>) ?? {}));
    cmd('resetSubtitleStyle', () => this.resetSubtitleStyle());
    cmd('getState', () => this.getState());
    cmd('getSchema', () => resolveInput({}, '').config);
    cmd('fullscreen', (d) => this.fullscreen(val(d) !== false));
    cmd('pip', () => this.togglePip());
    cmd('setConfig', (d) => {
      Object.assign(this.input.config, val(d) as ElfuraConfig);
      this.emit('config', this.input.config);
      return this.input.config;
    });
    cmd('next', () => this.emit('episode:next', {}));

    this.emit('ready', {
      sessionId: this.sessionId,
      config: redacted(this.input.config as unknown as Record<string, unknown>),
      subtitleStyle: this.getSubtitleStyle(),
    });
  }
}

function sniff(url: string): EngineKind {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  return 'native';
}

function inferParentOrigin(): string | null {
  try {
    if (document.referrer) return new URL(document.referrer).origin;
  } catch {
    /* ignore */
  }
  return null;
}

/** Security params must never leave the iframe. */
function redacted(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = ['pltoken', 'nonce', 'token', 'sig'].includes(k) ? '[redacted]' : v;
  }
  return out;
}
