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
  canonLang,
  ExternalAudioSync,
  languageLabel,
  loadPreferredAudio,
  matchScore,
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

export interface SourceOption {
  id: string;
  sourceId: string;
  label: string;
  type: 'hls' | 'dash' | 'mp4';
  url: string;
  quality: string;
  /** Distinct rendition heights (desc) for multi-quality ABR streams. */
  qualityLadder?: number[];
  /** Number of quality options when known (>1 ranks above single/unknown). */
  qualityOptions?: number;
  fingerprint?: string;
  latencyHintMs?: number;
  audioLang?: string;
  availableAudioLangs?: string[];
  multiAudio?: boolean;
  audioTracks: { lang: string; label: string; url: string }[];
  subtitles: { lang: string; label: string; url: string }[];
}

export interface SeasonSummaryInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
}

export interface EpisodeItemInfo {
  episodeNumber: number;
  seasonNumber: number;
  name: string;
  overview: string;
  runtime: number | null;
  rating: number | null;
  airDate: string;
  still: string | null;
}

export interface SeasonCatalogInfo {
  tmdbId: string;
  season: number;
  seasons: SeasonSummaryInfo[];
  episodes: EpisodeItemInfo[];
}

export interface NextEpisodeTarget {
  season: number;
  episode: number;
  name?: string;
}

export interface TitleMediaInfo {
  type?: 'movie' | 'tv';
  tmdbId?: string;
  season?: number;
  episode?: number;
  episodeName?: string;
  seasons?: SeasonSummaryInfo[];
  title?: string;
  rawTitle?: string;
  year?: string;
  tagline?: string;
  rating?: number | null;
  genres?: string[];
  overview?: string;
  poster?: string | null;
  backdrop?: string | null;
  logo?: string | null;
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
  audioId: string | null;
  audioLang: string | null;
  subtitleId: string | null;
  subtitleLang: string | null;
  subtitlesOn: boolean;
  server: string | null;
  source: string | null;
  fullscreen: boolean;
  zoomMode: 'fit' | 'cover';
  audioBoostPct: number;
  subtitleOffsetSec: number;
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
  updateSettings?(settings: Record<string, unknown>): void;
  extend?(name: string, factory: () => unknown, override?: boolean): void;
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

  private sources: SourceOption[] = [];
  private currentSource: SourceOption | null = null;
  private failedSourceIds = new Set<string>();
  private failedFingerprints = new Set<string>();
  private measuredRttByFp = new Map<string, number>();
  private audioTracks: AudioTrack[] = [];
  private currentAudio: AudioTrack | null = null;
  private subtitleTracks: SubtitleTrack[] = [];
  private currentSubtitle: SubtitleTrack | null = null;
  private cues: Cue[] = [];
  private qualityLevels: QualityLevel[] = [];
  private qualityMode = 'auto';
  private effectiveHeight = 0;
  private mediaInfo: TitleMediaInfo | null = null;
  private zoomMode: 'fit' | 'cover' = 'fit';
  private audioBoostPct = 100;
  private audioBoostCtx: AudioContext | null = null;
  private audioBoostShelf: BiquadFilterNode | null = null;
  private audioBoostGain: GainNode | null = null;
  private subtitleOffsetSec = 0;
  private seasonCatalogCache = new Map<number, SeasonCatalogInfo>();
  private nextEpisodeTarget: NextEpisodeTarget | null = null;
  private prewarmedKeyTriggered = '';
  private prewarmedNext: {
    season: number;
    episode: number;
    media?: TitleMediaInfo;
    sources: SourceOption[];
    fastest: SourceOption;
    segments?: { intro?: [number, number]; outro?: [number, number]; recap?: [number, number] };
  } | null = null;

  renderer: SubtitleRenderer | null = null;
  bridge!: PostMessageBridge;

  private fatalCount = 0;
  private initialAudioApplied = false;
  private desiredAudioLang: string | null = null;
  private audioSearchSeq = 0;
  private activeProbe: {
    seq: number;
    targetLang: string;
    opt: SourceOption;
    settle: (res: { ok: boolean; loadFailed?: boolean }) => void;
  } | null = null;
  private startupWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private hevcSupportedCache: boolean | null = null;
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
    this.video.preload = 'auto';
    if (cfg.poster) this.video.poster = cfg.poster;
    if (cfg.loop) this.video.loop = true;
    this.surface.appendChild(this.video);
    this.shell.appendChild(this.surface);

    this.externalAudio.bind(this.video);

    this.renderer = new SubtitleRenderer(
      { host: this.surface, onStyleChange: (s) => this.emit('subtitleStyle', s), draggable: true },
      this.input.subtitleStyle,
    );
    this.renderer.bindClock(() => this.video.currentTime - this.subtitleOffsetSec);
    this.renderer.setEnabled(cfg.subtitles !== false);

    this.setupBridge();
    this.bindMediaEvents();

    if (cfg.src) {
      if (cfg.servers?.length) {
        this.sources = cfg.servers.map((s, idx) => ({
          id: s.lang || `server-${idx + 1}`,
          sourceId: s.lang || `server-${idx + 1}`,
          label: s.label || s.lang || `Source ${idx + 1}`,
          type: sniff(s.url) === 'native' ? 'mp4' : (sniff(s.url) as 'hls' | 'dash'),
          url: s.url,
          quality: 'auto',
          audioTracks: [],
          subtitles: [],
        }));
        this.currentSource = this.sources.find((s) => s.url === cfg.src) ?? this.sources[0] ?? null;
      }
      void this.load(String(cfg.src));
    } else if (cfg.tmdb) {
      void this.resolveFromBackend();
    }
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
      audioId: this.currentAudio?.id ?? null,
      audioLang: this.currentAudio?.lang ?? null,
      subtitleId: this.currentSubtitle?.id ?? null,
      subtitleLang: this.currentSubtitle?.lang ?? null,
      subtitlesOn: this.renderer?.getEnabled() ?? false,
      server: this.input.config.server ?? null,
      source: this.currentSource?.id ?? null,
      fullscreen: document.fullscreenElement === this.shell,
      zoomMode: this.zoomMode,
      audioBoostPct: this.audioBoostPct,
      subtitleOffsetSec: this.subtitleOffsetSec,
      canPip: typeof v.requestPictureInPicture === 'function' && !v.disablePictureInPicture,
      canFullscreen: typeof this.shell.requestFullscreen === 'function',
    };
  }

  getSources(): SourceOption[] {
    return this.sources;
  }

  /** Re-run resolution after a terminal unavailable state without reloading the host page. */
  async retrySources(): Promise<void> {
    this.failedSourceIds.clear();
    this.failedFingerprints.clear();
    if (this.input.config.tmdb) {
      await this.resolveFromBackend();
    } else if (this.input.config.src) {
      await this.load(String(this.input.config.src));
    }
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
  getMediaInfo(): TitleMediaInfo | null {
    return this.mediaInfo;
  }
  setMediaInfo(info: TitleMediaInfo | null): void {
    this.mediaInfo = info;
    if (info) this.emit('media', info);
  }

  async setSource(id: string): Promise<boolean> {
    const opt = this.sources.find((s) => s.id === id || s.sourceId === id);
    if (!opt) return false;
    this.audioSearchSeq++;
    this.activeProbe = null;
    this.failedSourceIds.clear();
    this.failedFingerprints.clear();
    if (opt.audioLang && opt.audioLang !== 'und') {
      this.desiredAudioLang = canonLang(opt.audioLang);
    } else if (
      this.desiredAudioLang &&
      (opt.multiAudio ||
        (opt.availableAudioLangs ?? []).some((l) => matchScore(this.desiredAudioLang!, l) >= 0))
    ) {
      // Preserve active desired language (e.g. Hindi) when switching manually to a Multi-Audio server!
    } else {
      this.desiredAudioLang = null;
    }
    this.initialAudioApplied = true;
    await this.activateSourceOption(opt, true, true);
    return true;
  }

  private recordMeasuredLatency(opt: SourceOption, rttMs: number): void {
    const cleanMs = Math.max(1, Math.round(rttMs));
    const fp = opt.fingerprint || opt.id;
    const prev = this.measuredRttByFp.get(fp);
    const best = prev !== undefined ? Math.min(prev, cleanMs) : cleanMs;
    this.measuredRttByFp.set(fp, best);
    for (const s of this.sources) {
      if (s.id === opt.id || (opt.fingerprint && s.fingerprint === opt.fingerprint)) {
        s.latencyHintMs = best;
      }
    }
  }

  private recordDiscoveredAudioLangs(opt: SourceOption, langs: string[]): void {
    if (!langs.length) return;
    const fp = opt.fingerprint;
    for (const s of this.sources) {
      if (s.id !== opt.id && (!fp || s.fingerprint !== fp)) continue;
      if (langs.length > 1 || s.multiAudio) {
        const merged = [...(s.availableAudioLangs ?? [])];
        for (const code of langs) {
          if (code && code !== 'und' && !merged.includes(code)) merged.push(code);
        }
        s.availableAudioLangs = merged;
        if (merged.length > 1) s.multiAudio = true;
      } else if (!s.audioLang || s.audioLang === 'und') {
        s.audioLang = langs[0];
      }
    }
  }

  private effectiveSpeedScore(opt: SourceOption): number {
    const fp = opt.fingerprint || opt.id;
    const measured = this.measuredRttByFp.get(fp);
    if (measured !== undefined) {
      // Measured live RTT wins directly, with a slight 20ms ABR edge bonus for Multi-Audio CDNs
      return measured - (opt.multiAudio ? 20 : 0);
    }
    const hint = opt.latencyHintMs ?? 480;
    // Before live measurement, Multi-Audio ABR CDNs get a -65ms priority edge over single-dub hints
    return hint - (opt.multiAudio ? 65 : 0);
  }

  /**
   * Dynamically re-ranks sources for the selected language. Compatible
   * multi-audio sources are a strict tier above direct single-language sources;
   * measured speed and quality rank candidates within each tier.
   */
  reorderSourcesHierarchy(preferredLang?: string | null): void {
    if (this.sources.length <= 1) return;
    const lang = canonLang(
      preferredLang ?? this.desiredAudioLang ?? this.currentAudio?.lang ?? '',
    );

    const tierFor = (s: SourceOption): number => {
      if (this.isCandidateFailed(s)) return 9;
      if (lang && lang !== 'und') {
        if (this.currentSource?.id === s.id && this.desiredAudioLang === lang) return -1;
        const hasConfirmedMatch =
          (this.currentSource?.id === s.id && this.desiredAudioLang === lang) ||
          (s.audioLang && matchScore(lang, s.audioLang) >= 0) ||
          (s.availableAudioLangs ?? []).some((l) => matchScore(lang, l) >= 0) ||
          (s.audioTracks ?? []).some((a) => matchScore(lang, a.lang) >= 0);
        // Keep Multi-Audio streams whose internal tracks haven't been ruled out right in Tier 0
        // so fast Multi-Audio servers rank by true speed alongside direct language servers!
        if (hasConfirmedMatch || s.multiAudio) return 0;
        return 2;
      }
      if (s.multiAudio) return 0;
      const c = canonLang(s.audioLang);
      if (c === 'und' || c === 'en') return 0;
      return 1;
    };

    this.sources.sort((a, b) => {
      const tDiff = tierFor(a) - tierFor(b);
      if (tDiff !== 0) return tDiff;
      const multiDiff = Number(Boolean(b.multiAudio)) - Number(Boolean(a.multiAudio));
      if (multiDiff !== 0) return multiDiff;
      const qDiff = this.qualityTier(a) - this.qualityTier(b);
      if (qDiff !== 0) return qDiff;
      const sDiff = this.effectiveSpeedScore(a) - this.effectiveSpeedScore(b);
      if (Math.abs(sDiff) > 4) return sDiff;
      return this.qualityRank(b) - this.qualityRank(a);
    });

    this.emit('sources', this.sources);
  }

  private isCandidateFailed(opt: SourceOption): boolean {
    if (this.failedSourceIds.has(opt.id)) return true;
    if (opt.fingerprint && this.failedFingerprints.has(opt.fingerprint)) return true;
    return false;
  }

  private markCandidateFailed(opt: SourceOption): void {
    this.failedSourceIds.add(opt.id);
    if (opt.fingerprint) this.failedFingerprints.add(opt.fingerprint);
  }

  /**
   * Playback responses intentionally use root-relative `/api/v1/stream` tickets.
   * When an SDK consumer resolves through an absolute cross-origin `api` URL,
   * those tickets belong to that API origin, not to the site hosting the player.
   */
  private resolveBackendMediaUrl(rawUrl: string): string {
    if (!/^\/(?!\/)/.test(rawUrl.trim())) return rawUrl;
    try {
      const apiUrl = new URL(this.input.config.api || '/api/v1/playback', window.location.href);
      return new URL(rawUrl, apiUrl).toString();
    } catch {
      return rawUrl;
    }
  }

  private canPreProbeViaFetch(opt: SourceOption): boolean {
    if (typeof fetch !== 'function') return false;
    try {
      const base = new URL(window.location.href);
      const target = new URL(opt.url, base);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
      return target.origin === base.origin || this.isBackendOwnedUrl(target.toString());
    } catch {
      return false;
    }
  }

  private isBackendOwnedUrl(rawUrl: string): boolean {
    try {
      const base = new URL(window.location.href);
      const target = new URL(rawUrl, base);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
      if (target.origin === base.origin) return true;
      const apiOrigin = this.input.config.api
        ? new URL(this.input.config.api, base).origin
        : base.origin;
      return target.origin === apiOrigin;
    } catch {
      return false;
    }
  }

  private withForcedProxyParam(rawUrl: string): string {
    try {
      const base = new URL(window.location.href);
      const u = new URL(rawUrl, base);
      u.searchParams.set('p', '1');
      return u.origin === base.origin ? `${u.pathname}${u.search}${u.hash}` : u.toString();
    } catch {
      return rawUrl.includes('?') ? `${rawUrl}&p=1` : `${rawUrl}?p=1`;
    }
  }

  private supportsHevc(): boolean {
    if (this.hevcSupportedCache !== null) return this.hevcSupportedCache;
    try {
      const ms = (globalThis as unknown as { MediaSource?: { isTypeSupported?: (t: string) => boolean } }).MediaSource;
      if (ms && typeof ms.isTypeSupported === 'function') {
        const ok =
          ms.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
          ms.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"') ||
          Boolean(this.video.canPlayType?.('video/mp4; codecs="hvc1.1.6.L93.B0"'));
        this.hevcSupportedCache = ok;
        return ok;
      }
      if (typeof this.video.canPlayType === 'function') {
        const nativeHls = this.video.canPlayType('application/vnd.apple.mpegurl');
        if (nativeHls) {
          const ok = Boolean(this.video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"'));
          this.hevcSupportedCache = ok;
          return ok;
        }
      }
    } catch {
      /* ignore capability probe failure */
    }
    this.hevcSupportedCache = true;
    return true;
  }

  /** 0 = multi-quality ABR ladder, 1 = known single quality, 2 = unknown quality. */
  private qualityTier(opt: SourceOption): number {
    const n = opt.qualityOptions ?? opt.qualityLadder?.length ?? 0;
    if (n > 1) return 0;
    if (n === 1 || (opt.quality && opt.quality !== 'auto')) return 1;
    return 2;
  }

  private qualityRank(opt: SourceOption): number {
    const q = (opt.quality || '').toLowerCase();
    let res = 720;
    if (q.includes('4k') || q.includes('2160')) res = 2160;
    else if (q.includes('1440')) res = 1440;
    else if (q.includes('1080')) res = 1080;
    else if (q.includes('720')) res = 720;
    else if (q.includes('480')) res = 480;
    else if (q.includes('360')) res = 360;
    else if (q === 'auto') res = 960;
    // A real multi-quality ladder outranks any fixed rendition at the same tier.
    return res + (opt.multiAudio ? 250 : 0) + (this.qualityTier(opt) === 0 ? 180 : 0);
  }

  /**
   * Lightweight concurrent probe against our uniform `/api/v1/stream` relay.
   * Measures true end-to-end upstream latency, verifies the stream is alive
   * (and actually carries `targetLang` when probing multi-audio HLS), and
   * warms the backend RAM manifest cache so `hls.js` / `dash.js` starts in <2ms.
   */
  private async probeCandidateViaFetch(
    opt: SourceOption,
    targetLang: string | null,
    signal: AbortSignal,
    timeoutMs = 3200,
  ): Promise<{ ok: boolean; loadFailed: boolean; rttMs: number; languageRejected?: boolean }> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

    const cfg = this.input.config;
    const headers: Record<string, string> = {};
    if (cfg.pltoken) headers['X-Playback-Token'] = String(cfg.pltoken);

    const resolvedUrl = new URL(this.decorate(opt.url), window.location.href).toString();
    const isBackendTicket = resolvedUrl.includes('/api/v1/stream');
    const timeoutSig =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : signal;

    try {
      if (opt.type === 'mp4') {
        const res = await fetch(resolvedUrl, {
          method: 'GET',
          headers: { ...headers, Range: 'bytes=0-1023' },
          signal: timeoutSig,
        });
        const ok = res.ok || res.status === 206;
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        const rtt = nowMs();
        if (!ok) return { ok: false, loadFailed: true, rttMs: rtt };
        this.recordMeasuredLatency(opt, rtt);
        if (targetLang && targetLang !== 'und') {
          const matches =
            matchScore(targetLang, opt.audioLang ?? 'und') >= 0 ||
            (opt.audioTracks ?? []).some((a) => matchScore(targetLang, a.lang) >= 0) ||
            !!opt.multiAudio;
          if (!matches) return { ok: false, loadFailed: false, rttMs: rtt, languageRejected: true };
        }
        return { ok: true, loadFailed: false, rttMs: rtt };
      }

      const res = await fetch(resolvedUrl, { headers, signal: timeoutSig });
      if (!res.ok) return { ok: false, loadFailed: true, rttMs: nowMs() };
      const text = await res.text();
      const rtt = nowMs();
      const lead = text.trimStart();

      if (opt.type === 'dash' || lead.includes('<MPD')) {
        if (!lead.includes('<MPD')) return { ok: false, loadFailed: true, rttMs: rtt };
        this.recordMeasuredLatency(opt, rtt);
        return { ok: true, loadFailed: false, rttMs: rtt };
      }

      if (!lead.startsWith('#EXTM3U')) {
        return { ok: false, loadFailed: true, rttMs: rtt };
      }

      const lines = text.split(/\r?\n/);
      const streamInfLines = lines.filter((l) => /^#EXT-X-STREAM-INF\b/i.test(l.trim()));

      // Reject HEVC-only streams before attaching hls.js when the device/browser MSE lacks HEVC hardware decode
      if (
        streamInfLines.length > 0 &&
        streamInfLines.every((l) => /\bCODECS="[^"]*\b(?:hvc1|hev1)\b/i.test(l)) &&
        !this.supportsHevc()
      ) {
        return { ok: false, loadFailed: true, rttMs: rtt };
      }

      this.recordMeasuredLatency(opt, rtt);

      let matchedAudioUri: string | null = null;
      let defaultAudioUri: string | null = null;
      const discoveredManifestLangs: string[] = [];
      const audioMediaLines = lines.filter((l) => /^#EXT-X-MEDIA:.*TYPE=AUDIO\b/i.test(l.trim()));
      for (const al of audioMediaLines) {
        const langAttr = al.match(/\bLANGUAGE="([^"]*)"/i)?.[1] ?? '';
        const nameAttr = al.match(/\bNAME="([^"]*)"/i)?.[1] ?? '';
        const uriAttr = al.match(/\bURI="([^"]*)"/i)?.[1] ?? '';
        const cLang = canonLang(langAttr) !== 'und' ? canonLang(langAttr) : canonLang(nameAttr);
        if (cLang !== 'und' && !discoveredManifestLangs.includes(cLang)) {
          discoveredManifestLangs.push(cLang);
        }
        if (uriAttr) {
          if (!defaultAudioUri) defaultAudioUri = uriAttr;
          if (/DEFAULT=YES\b/i.test(al)) defaultAudioUri = uriAttr;
        }
      }
      if (discoveredManifestLangs.length > 0) {
        this.recordDiscoveredAudioLangs(opt, discoveredManifestLangs);
      }

      if (targetLang && targetLang !== 'und') {
        const hasSidecarMatch = (opt.audioTracks ?? []).some((a) => matchScore(targetLang, a.lang) >= 0);
        if (!hasSidecarMatch) {
          if (audioMediaLines.length > 0) {
            let foundInManifest = false;
            for (const al of audioMediaLines) {
              const langAttr = al.match(/\bLANGUAGE="([^"]*)"/i)?.[1] ?? '';
              const nameAttr = al.match(/\bNAME="([^"]*)"/i)?.[1] ?? '';
              const uriAttr = al.match(/\bURI="([^"]*)"/i)?.[1] ?? '';
              const candidateCanon = canonLang(langAttr || nameAttr);
              const nameCanon = canonLang(nameAttr);
              if (
                (candidateCanon !== 'und' && matchScore(targetLang, candidateCanon) >= 0) ||
                (nameCanon !== 'und' && matchScore(targetLang, nameCanon) >= 0)
              ) {
                foundInManifest = true;
                if (uriAttr && !matchedAudioUri) matchedAudioUri = uriAttr;
                break;
              }
            }
            if (!foundInManifest && matchScore(targetLang, opt.audioLang ?? 'und') < 0) {
              return { ok: false, loadFailed: false, rttMs: rtt, languageRejected: true };
            }
          }
          // No EXT-X-MEDIA language/name is inconclusive, not an explicit
          // rejection. Keep this candidate eligible for the real HLS/DASH
          // engine probe, which can discover tracks after parsing the manifest.
        }
      }

      // Backend `/api/v1/stream` tickets were ALREADY deep-verified (including child playlists)
      // by `liveness.ts` on the server — only double-check child playlists for raw non-relay URLs!
      if (streamInfLines.length > 0 && !isBackendTicket) {
        let variantChildUri: string | null = null;
        for (let i = 0; i < lines.length; i++) {
          if (/^#EXT-X-STREAM-INF\b/i.test(lines[i].trim())) {
            for (let j = i + 1; j < lines.length; j++) {
              const candLine = lines[j].trim();
              if (!candLine) continue;
              if (!candLine.startsWith('#')) variantChildUri = candLine;
              break;
            }
            if (variantChildUri) break;
          }
        }

        const audioChildUri = matchedAudioUri || defaultAudioUri;
        const childTargets = [...new Set([variantChildUri, audioChildUri].filter((x): x is string => Boolean(x)))];
        if (childTargets.length > 0) {
          const childResults = await Promise.all(
            childTargets.map(async (targetRef) => {
              const childUrl = new URL(this.decorate(targetRef), resolvedUrl).toString();
              const childRes = await fetch(childUrl, { headers, signal: timeoutSig });
              if (!childRes.ok) return false;
              const childText = await childRes.text();
              const childLead = childText.trimStart();
              return (
                childLead.startsWith('#EXTM3U') &&
                /#EXTINF\b|#EXT-X-STREAM-INF\b|#EXT-X-MAP\b/i.test(childText)
              );
            }),
          );
          if (childResults.some((okChild) => !okChild)) {
            return { ok: false, loadFailed: true, rttMs: nowMs() };
          }
        }
      } else if (streamInfLines.length === 0 && !/#EXTINF\b|#EXT-X-MAP\b/i.test(text)) {
        return { ok: false, loadFailed: true, rttMs: rtt };
      }

      return { ok: true, loadFailed: false, rttMs: nowMs() };
    } catch {
      // A ranking timeout is not proof that a backend-verified source is dead.
      // Keep slow/mobile candidates eligible for startup fallback and language failover.
      if (signal.aborted || timeoutSig.aborted) return { ok: false, loadFailed: false, rttMs: nowMs() };
      return { ok: false, loadFailed: true, rttMs: nowMs() };
    }
  }

  /**
   * Concurrently races candidates. Multi-audio responses win their class first;
   * direct streams cannot abort an unanswered multi-audio probe merely by being
   * faster. Quality receives only a short 25ms tie-break inside each class.
   */
  private async raceCandidatesBatch(
    batch: SourceOption[],
    targetLang: string | null,
    probeTimeoutMs = 3200,
  ): Promise<{ winner: SourceOption | null; winners: SourceOption[]; failed: SourceOption[]; rejected: SourceOption[] }> {
    if (batch.length === 0) return { winner: null, winners: [], failed: [], rejected: [] };

    const controllers = batch.map(() => new AbortController());
    const failed: SourceOption[] = [];
    const rejected: SourceOption[] = [];
    const successes: { opt: SourceOption; rttMs: number; rank: number }[] = [];
    let pending = batch.length;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    return new Promise((resolve) => {
      const rankSuccesses = (): SourceOption[] => {
        if (!successes.length) return [];
        successes.sort((a, b) => {
          // Multi-audio is a strict product priority; speed ranks candidates within each class.
          const multiDiff = Number(Boolean(b.opt.multiAudio)) - Number(Boolean(a.opt.multiAudio));
          if (multiDiff !== 0) return multiDiff;
          const rttGap = a.rttMs - b.rttMs;
          if (Math.abs(rttGap) > 30) return rttGap;
          return b.rank - a.rank || rttGap;
        });
        return successes.map((s) => s.opt);
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        for (const c of controllers) {
          try {
            c.abort();
          } catch {
            /* ignore */
          }
        }
        const winners = rankSuccesses();
        resolve({ winner: winners[0] ?? null, winners, failed, rejected });
      };

      batch.forEach((opt, idx) => {
        const optRank = this.qualityRank(opt);
        void this.probeCandidateViaFetch(opt, targetLang, controllers[idx].signal, probeTimeoutMs).then((res) => {
          pending--;
          if (settled) return;

          if (res.ok) {
            successes.push({ opt, rttMs: res.rttMs, rank: optRank });
            // If this winner is already >= 960 rank (1080p / Auto / Multi-Audio), settle in 0ms!
            // Only wait 25ms if a low-res (<720p) stream beat a still-in-flight HD/Multi-Audio stream.
            const isFastHdOrMulti = optRank >= 960;
            const hasMultiInFlight =
              !opt.multiAudio &&
              batch.some(
                (other, j) =>
                  j !== idx &&
                  other.multiAudio &&
                  !controllers[j].signal.aborted &&
                  !failed.includes(other) &&
                  !rejected.includes(other) &&
                  !successes.some((s) => s.opt.id === other.id),
              );
            const hasHigherInFlight =
              !isFastHdOrMulti &&
              batch.some(
                (other, j) =>
                  j !== idx &&
                  !controllers[j].signal.aborted &&
                  this.qualityRank(other) > optRank &&
                  !failed.includes(other) &&
                  !successes.some((s) => s.opt.id === other.id),
              );
            // Never let a single-language result abort a compatible multi-audio
            // probe merely because the single-language manifest answered first.
            if (pending === 0 || (!hasMultiInFlight && !hasHigherInFlight)) {
              finish();
              return;
            }
            if (!hasMultiInFlight && !graceTimer) {
              graceTimer = setTimeout(() => finish(), 25);
            }
          } else {
            if (res.loadFailed) failed.push(opt);
            else if (res.languageRejected) rejected.push(opt);
            if (pending === 0) {
              finish();
            }
          }
        });
      });
    });
  }

  private async selectFastestInitialSource(
    allSources: SourceOption[],
    fallbackPrimary: SourceOption,
  ): Promise<SourceOption> {
    const multiPool = allSources
      .filter((s) => s.multiAudio && !this.isCandidateFailed(s))
      .sort((a, b) => this.effectiveSpeedScore(a) - this.effectiveSpeedScore(b));
    if (multiPool.length > 0 && !multiPool.some((s) => this.canPreProbeViaFetch(s))) {
      return multiPool[0];
    }

    const preferredPool = allSources.filter((s) => {
      if (this.isCandidateFailed(s) || !this.canPreProbeViaFetch(s)) return false;
      if (s.multiAudio) return true;
      const lang = canonLang(s.audioLang);
      return lang === 'und' || lang === 'en';
    });
    const pool = preferredPool.length > 0
      ? preferredPool
      : allSources.filter((s) => !this.isCandidateFailed(s) && this.canPreProbeViaFetch(s));

    if (pool.length <= 1) {
      return pool[0] ?? fallbackPrimary;
    }

    const sortedPool = [...pool].sort(
      (a, b) =>
        Number(Boolean(b.multiAudio)) - Number(Boolean(a.multiAudio)) ||
        this.qualityTier(a) - this.qualityTier(b) ||
        this.effectiveSpeedScore(a) - this.effectiveSpeedScore(b) ||
        this.qualityRank(b) - this.qualityRank(a),
    );

    const seenFingerprints = new Set<string>();
    const wave: SourceOption[] = [];
    for (const s of sortedPool) {
      const fp = s.fingerprint || s.id;
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);
      wave.push(s);
      if (wave.length >= 6) break;
    }

    if (wave.length <= 1) return wave[0] ?? fallbackPrimary;

    // Backend liveness has already verified these tickets. Keep the optional client ranking short.
    const { winner, failed } = await this.raceCandidatesBatch(wave, null, 1600);
    for (const f of failed) this.markCandidateFailed(f);
    if (winner) {
      this.reorderSourcesHierarchy(null);
      return winner;
    }

    const nextAlive = allSources.find((s) => !this.isCandidateFailed(s));
    return nextAlive ?? fallbackPrimary;
  }

  private async resolveFromBackend(): Promise<void> {
    const cfg = this.input.config;
    if (!cfg.tmdb || this.destroyed) return;

    this.shell.dataset.buffering = 'true';
    this.emit('buffering', {});

    // Preload hls.js concurrently while /api/v1/playback resolves on the backend
    void getHls().catch(() => undefined);

    try {
      const apiBase = cfg.api || '/api/v1/playback';
      const apiUrl = new URL(apiBase, window.location.href);

      // Mint a short-lived playback session token if SSR boot did not already inject one
      if (!cfg.pltoken) {
        const sessionUrl = new URL('/api/v1/session', apiUrl);
        try {
          const sessRes = await fetch(sessionUrl.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: cfg.mediaType || 'movie', tmdb: String(cfg.tmdb) }),
          });
          if (sessRes.ok) {
            const sessJson = (await sessRes.json()) as { pltoken?: string; nonce?: string };
            if (sessJson.pltoken) cfg.pltoken = sessJson.pltoken;
            if (sessJson.nonce) cfg.nonce = sessJson.nonce;
          }
        } catch {
          /* continue — backend may run with REQUIRE_PLAYBACK_TOKEN=0 in custom setups */
        }
      }

      const storedLang = !cfg.lang ? loadPreferredAudio() : null;
      const bootLang = cfg.lang ? String(cfg.lang) : storedLang;

      apiUrl.searchParams.set('type', cfg.mediaType || 'movie');
      apiUrl.searchParams.set('tmdb', String(cfg.tmdb));
      if ((cfg.mediaType || 'movie') === 'tv') {
        apiUrl.searchParams.set('s', String(cfg.season ?? 1));
        apiUrl.searchParams.set('e', String(cfg.episode ?? 1));
      }
      if (cfg.source) apiUrl.searchParams.set('source', String(cfg.source));
      if (bootLang) apiUrl.searchParams.set('lang', bootLang);
      if (cfg.nonce) apiUrl.searchParams.set('nonce', String(cfg.nonce));

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (cfg.pltoken) headers['X-Playback-Token'] = String(cfg.pltoken);
      const canOpenEnvelope =
        Boolean(cfg.pltoken && cfg.nonce) &&
        typeof globalThis.crypto?.subtle?.decrypt === 'function';
      if (canOpenEnvelope) {
        headers['X-Elfura-Envelope'] = '1';
      }

      const res = await fetch(apiUrl.toString(), { headers });
      if (this.destroyed) return;
      if (!res.ok) {
        this.shell.dataset.buffering = 'false';
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        this.emit('error', {
          code: `resolve-${res.status}`,
          message: errBody.error || `Playback resolution returned ${res.status}`,
        });
        return;
      }

      type PlaybackPayloadShape = {
        ok?: boolean;
        s?: number;
        p?: string;
        media?: TitleMediaInfo;
        primary?: SourceOption;
        sources?: SourceOption[];
        segments?: { intro?: [number, number]; outro?: [number, number]; recap?: [number, number] };
      };
      const rawJson = (await res.json()) as PlaybackPayloadShape;
      if (this.destroyed) return;

      const data: PlaybackPayloadShape =
        rawJson?.s === 1 && typeof rawJson.p === 'string' && cfg.pltoken && cfg.nonce
          ? await openSealedEnvelope<PlaybackPayloadShape>(
              rawJson.p,
              String(cfg.pltoken),
              String(cfg.nonce),
            )
          : rawJson;
      if (this.destroyed) return;

      if (!data?.ok || !data.sources?.length) {
        this.shell.dataset.buffering = 'false';
        this.emit('error', { code: 'no-sources', message: 'No playable sources found' });
        return;
      }

      if (data.media) {
        this.mediaInfo = data.media;
      }
      if (!cfg.title && data.media?.title) {
        cfg.title = data.media.title;
      }
      const posterCandidate = data.media?.backdrop || data.media?.poster;
      if (!cfg.poster && posterCandidate) {
        cfg.poster = posterCandidate;
        this.video.poster = posterCandidate;
      }
      if (data.segments) {
        const segIntro = data.segments.intro ?? data.segments.recap;
        if (!cfg.intro && segIntro) {
          cfg.intro = [{ lang: String(segIntro[0]), url: String(segIntro[1]) }];
        }
        if (!cfg.outro && data.segments.outro) {
          cfg.outro = [{ lang: String(data.segments.outro[0]), url: String(data.segments.outro[1]) }];
        }
        this.emit('segments:invalidate', {});
      }

      const resolveSource = (opt: SourceOption): SourceOption => ({
        ...opt,
        url: this.resolveBackendMediaUrl(opt.url),
        audioTracks: opt.audioTracks?.map((track) => ({
          ...track,
          url: this.resolveBackendMediaUrl(track.url),
        })),
        subtitles: opt.subtitles?.map((track) => ({
          ...track,
          url: this.resolveBackendMediaUrl(track.url),
        })),
      });
      if (data.primary) data.primary = resolveSource(data.primary);
      this.sources = data.sources.map(resolveSource);
      this.failedSourceIds.clear();
      this.failedFingerprints.clear();
      this.measuredRttByFp.clear();
      this.initialAudioApplied = false;
      if (this.mediaInfo) this.emit('media', this.mediaInfo);
      this.emit('config', redacted(cfg as unknown as Record<string, unknown>));

      // Warm TV season/episode catalog in background for instant Episode Wheel + Next Episode
      if ((cfg.mediaType || data.media?.type) === 'tv') {
        void this.fetchSeasonEpisodes(cfg.season ?? data.media?.season ?? 1);
      }

      const storedMatchesAny =
        storedLang &&
        this.sources.some(
          (s) =>
            !!s.multiAudio ||
            (s.audioLang && matchScore(storedLang, s.audioLang) >= 0) ||
            (s.availableAudioLangs ?? []).some((l) => matchScore(storedLang, l) >= 0) ||
            (s.audioTracks ?? []).some((a) => matchScore(storedLang, a.lang) >= 0),
        );

      const effectiveBootLang = cfg.lang
        ? String(cfg.lang)
        : storedMatchesAny
          ? storedLang
          : null;
      this.reorderSourcesHierarchy(effectiveBootLang);

      if (cfg.lang) {
        this.initialAudioApplied = true;
        await this.setAudio(String(cfg.lang));
      } else if (storedLang && storedMatchesAny) {
        this.initialAudioApplied = true;
        await this.setAudio(storedLang);
      } else {
        const fallbackPrimary = data.primary ?? this.sources[0];
        const fastest = await this.selectFastestInitialSource(this.sources, fallbackPrimary);
        if (this.destroyed) return;
        await this.activateSourceOption(fastest, false);
      }
    } catch (err) {
      if (!this.destroyed) {
        this.shell.dataset.buffering = 'false';
        this.emit('error', { code: 'resolve-failed', message: String(err) });
      }
    }
  }

  private async activateSourceOption(
    opt: SourceOption,
    preservePosition: boolean,
    manual = false,
  ): Promise<void> {
    const cfg = this.input.config;
    const prevTime = preservePosition && Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
    const wasPlaying = preservePosition && !this.video.paused;

    this.currentSource = opt;
    cfg.src = opt.url;
    cfg.server = opt.id;
    cfg.audioTracks = opt.audioTracks?.map((a) => ({ lang: a.lang, label: a.label, url: a.url })) ?? [];
    cfg.subsrc = opt.subtitles?.map((s) => ({ lang: s.lang, label: s.label, url: s.url })) ?? [];

    const engineHint = opt.type === 'mp4' ? 'native' : opt.type;
    await this.load(opt.url, engineHint);

    if (prevTime > 0.5) {
      const restore = () => {
        this.seek(prevTime);
        if (wasPlaying) void this.play();
      };
      if (this.video.readyState >= 1) restore();
      else this.video.addEventListener('loadedmetadata', restore, { once: true });
    } else if (wasPlaying) {
      void this.play();
    }

    this.emit('sourceChange', {
      id: opt.id,
      sourceId: opt.sourceId,
      label: opt.label,
      type: opt.type,
      quality: opt.quality,
      manual,
    });
  }

  async load(url: string, typeHint?: string): Promise<void> {
    const kind = (typeHint ?? this.input.config.type ?? 'auto') as string;
    const mappedKind = kind === 'mp4' ? 'native' : kind;
    const engine: EngineKind =
      mappedKind === 'auto'
        ? this.currentSource
          ? this.currentSource.type === 'mp4'
            ? 'native'
            : this.currentSource.type
          : sniff(url)
        : (mappedKind as EngineKind);

    this.teardownEngine();
    this.engineKind = engine;
    this.fatalCount = 0;

    // Seed audio & subtitle lists dynamically from active config + discovered raw sources.
    if ((this.input.config.audioTracks?.length ?? 0) > 0 || this.sources.length > 0) {
      this.mergeNativeAudio([]);
    }
    if ((this.input.config.subsrc?.length ?? 0) > 0) this.mergeExternalSubs();

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
    const exactTrack = this.audioTracks.find((t) => t.id === idOrLang);
    const targetLang = exactTrack ? exactTrack.lang : canonLang(idOrLang);
    const displayLabel = exactTrack
      ? exactTrack.label
      : languageLabel(targetLang, idOrLang.includes(':') ? undefined : idOrLang);

    this.initialAudioApplied = true;
    this.desiredAudioLang = targetLang;

    const currentHealthy = !!this.currentSource && !this.isCandidateFailed(this.currentSource);
    const mustPrioritizeMulti =
      targetLang !== 'und' &&
      !this.currentSource?.multiAudio &&
      this.sources.some((s) => s.multiAudio && !this.isCandidateFailed(s));

    // A direct stream must not short-circuit the search when multi-audio is available.
    // Otherwise selecting the same direct language would permanently pin the lower-priority source.
    if (!mustPrioritizeMulti && (currentHealthy || (!this.sources.length && this.audioTracks.length > 0))) {
      const nativeMatch =
        exactTrack?.kind === 'native'
          ? exactTrack
          : this.audioTracks.find((t) => t.kind === 'native' && matchScore(targetLang, t.lang) >= 0);

      if (nativeMatch) {
        this.externalAudio.deactivate();
        if (this.hls && typeof nativeMatch.ref === 'number') {
          this.hls.audioTrack = nativeMatch.ref;
        } else if (this.dash) {
          const native = this.dash
            .getTracksFor('audio')
            .find((t) => matchScore(targetLang, t.lang ?? '') >= 0);
          if (native) this.dash.setCurrentTrack(native);
        }
        this.currentAudio = nativeMatch;
        if (this.input.config.persistAudio && targetLang !== 'und') savePreferredAudio(targetLang);
        this.reorderSourcesHierarchy(targetLang);
        this.emit('audioChange', {
          id: nativeMatch.id,
          lang: nativeMatch.lang,
          label: nativeMatch.label,
          kind: nativeMatch.kind,
        });
        return true;
      }

      // 2) Try sidecar external audio file on the currently active stream
      const externalMatch =
        exactTrack?.kind === 'external'
          ? exactTrack
          : this.audioTracks.find((t) => t.kind === 'external' && matchScore(targetLang, t.lang) >= 0);

      if (externalMatch) {
        const res = await this.externalAudio.activate(externalMatch);
        if (res.ok) {
          this.currentAudio = externalMatch;
          if (this.input.config.persistAudio && targetLang !== 'und') savePreferredAudio(targetLang);
          this.reorderSourcesHierarchy(targetLang);
          this.emit('audioChange', {
            id: externalMatch.id,
            lang: externalMatch.lang,
            label: externalMatch.label,
            kind: externalMatch.kind,
          });
          return true;
        }
        // External file failed — fall through and search all other raw sources for targetLang!
      }

      // 3) Check if current healthy single-dub stream already matches targetLang
      if (
        this.currentSource &&
        !this.currentSource.multiAudio &&
        matchScore(targetLang, this.currentSource.audioLang ?? 'und') >= 0 &&
        (this.video.readyState >= 1 || this.qualityLevels.length > 0)
      ) {
        const activeTrack =
          this.audioTracks.find((t) => matchScore(targetLang, t.lang) >= 0) ?? {
            id: `source:${targetLang}`,
            kind: 'source' as const,
            lang: targetLang,
            label: displayLabel,
            ref: targetLang,
            default: true,
          };
        this.currentAudio = activeTrack;
        if (this.input.config.persistAudio && targetLang !== 'und') savePreferredAudio(targetLang);
        this.reorderSourcesHierarchy(targetLang);
        this.emit('audioChange', {
          id: activeTrack.id,
          lang: activeTrack.lang,
          label: activeTrack.label,
          kind: activeTrack.kind,
        });
        return true;
      }
    }

    // 4) Concurrently race & exhaustively try ALL raw sources that carry targetLang
    return this.searchRawSourcesForLanguage(targetLang, displayLabel);
  }

  /**
   * Races candidate raw sources for `targetLang` concurrently in parallel waves
   * so the fastest lowest-buffer server wins immediately instead of walking
   * servers top-to-bottom. Exhaustively checks every distinct candidate before
   * restoring playback and displaying:
   *   `Sorry, we searched all sources yet didn't find it in "<Language>"`
   */
  private async searchRawSourcesForLanguage(
    targetLang: string,
    displayLabel: string,
    excludeIds = new Set<string>(),
  ): Promise<boolean> {
    const seq = ++this.audioSearchSeq;
    const prevWorkingSource =
      this.currentSource && !this.isCandidateFailed(this.currentSource) && !excludeIds.has(this.currentSource.id)
        ? this.currentSource
        : null;
    const savedTime = Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
    const wasPlaying = !this.video.paused;

    const matchesOrCanCarryLang = (s: SourceOption): boolean => {
      if (targetLang === 'und') {
        return !s.multiAudio && canonLang(s.audioLang) === 'und';
      }
      if (s.audioLang && matchScore(targetLang, s.audioLang) >= 0) return true;
      if ((s.availableAudioLangs ?? []).some((l) => matchScore(targetLang, l) >= 0)) return true;
      if ((s.audioTracks ?? []).some((a) => matchScore(targetLang, a.lang) >= 0)) return true;
      // Provider language summaries can be incomplete. Every multi-audio source
      // remains eligible until its real manifest/engine rejects the target language.
      if (s.multiAudio) return true;
      return false;
    };

    // Multi-audio candidates always precede direct single-language streams.
    const candidates = this.sources
      .filter((s) => !this.isCandidateFailed(s) && !excludeIds.has(s.id) && matchesOrCanCarryLang(s))
      .sort(
        (a, b) =>
          Number(Boolean(b.multiAudio)) - Number(Boolean(a.multiAudio)) ||
          this.effectiveSpeedScore(a) - this.effectiveSpeedScore(b) ||
          this.qualityRank(b) - this.qualityRank(a),
      );

    if (candidates.length > 0) {
      this.shell.dataset.buffering = 'true';
      this.emit('audio:searching', {
        lang: targetLang,
        label: displayLabel,
        count: candidates.length,
      });
    }

    const finalizeChosenCandidate = (cand: SourceOption): boolean => {
      this.shell.dataset.buffering = 'false';
      if (targetLang && targetLang !== 'und') {
        this.recordDiscoveredAudioLangs(cand, [targetLang]);
      }
      // Dynamically update server hierarchy so the fastest winning server (Multi-Audio OR Direct)
      // sits at #1 on top of `this.sources` for `targetLang`!
      this.reorderSourcesHierarchy(targetLang);

      if (savedTime > 0.5) {
        const restore = () => {
          this.seek(savedTime);
          if (wasPlaying) void this.play();
        };
        if (this.video.readyState >= 1) restore();
        else this.video.addEventListener('loadedmetadata', restore, { once: true });
      } else if (wasPlaying) {
        void this.play();
      }

      const matchedTrack =
        this.audioTracks.find((t) => matchScore(targetLang, t.lang) >= 0) ?? {
          id: `source:${targetLang}`,
          kind: 'source' as const,
          lang: targetLang,
          label: displayLabel,
          ref: targetLang,
          default: true,
        };
      this.currentAudio = matchedTrack;
      if (this.input.config.persistAudio && targetLang !== 'und') savePreferredAudio(targetLang);

      this.emit('sourceChange', {
        id: cand.id,
        sourceId: cand.sourceId,
        label: cand.label,
        type: cand.type,
        quality: cand.quality,
        manual: false,
      });
      this.emit('audioChange', {
        id: matchedTrack.id,
        lang: matchedTrack.lang,
        label: matchedTrack.label,
        kind: matchedTrack.kind,
      });
      return true;
    };

    const rejectedFingerprints = new Set<string>();
    const triedEngineIds = new Set<string>();

    // Phase A: 8-way concurrent parallel race across BOTH Multi-Audio & Direct servers (fastest wins!)
    const fetchPool = candidates.filter((c) => this.canPreProbeViaFetch(c));
    let cursor = 0;
    while (cursor < fetchPool.length) {
      if (this.destroyed || this.audioSearchSeq !== seq) return false;

      const wave: SourceOption[] = [];
      const waveFps = new Set<string>();
      while (cursor < fetchPool.length && wave.length < 8) {
        const c = fetchPool[cursor++];
        if (this.isCandidateFailed(c)) continue;
        const fp = c.fingerprint || c.id;
        if (rejectedFingerprints.has(fp) || waveFps.has(fp)) continue;
        waveFps.add(fp);
        wave.push(c);
      }
      if (!wave.length) continue;

      const { winners, failed, rejected } = await this.raceCandidatesBatch(wave, targetLang);
      if (this.destroyed || this.audioSearchSeq !== seq) return false;

      for (const f of failed) this.markCandidateFailed(f);
      for (const r of rejected) {
        triedEngineIds.add(r.id);
        if (r.fingerprint) rejectedFingerprints.add(r.fingerprint);
      }

      if (winners.length > 0) {
        for (const w of winners) {
          if (this.destroyed || this.audioSearchSeq !== seq) return false;
          if (this.isCandidateFailed(w)) continue;
          const fp = w.fingerprint;
          if (fp && rejectedFingerprints.has(fp)) continue;

          triedEngineIds.add(w.id);
          const attachRes = await this.probeRawCandidateForLanguage(w, targetLang, seq);
          if (this.destroyed || this.audioSearchSeq !== seq) return false;
          if (attachRes.ok) {
            return finalizeChosenCandidate(w);
          }
          if (attachRes.loadFailed) this.markCandidateFailed(w);
          if (fp) rejectedFingerprints.add(fp);
        }
        // Do NOT reject the other wave entries here. raceCandidatesBatch may
        // have aborted them before their manifests answered. Phase B below must
        // still give every untried candidate a real engine-level opportunity.
      }
    }

    // Phase B: Engine-level fallback for any remaining untried / external-origin candidates
    for (const cand of candidates) {
      if (this.destroyed || this.audioSearchSeq !== seq) return false;
      if (triedEngineIds.has(cand.id) || this.isCandidateFailed(cand)) continue;
      if (cand.fingerprint && rejectedFingerprints.has(cand.fingerprint)) continue;

      const probeResult = await this.probeRawCandidateForLanguage(cand, targetLang, seq);
      if (this.destroyed || this.audioSearchSeq !== seq) return false;

      if (probeResult.ok) {
        return finalizeChosenCandidate(cand);
      }

      if (probeResult.loadFailed) {
        this.markCandidateFailed(cand);
      } else if (cand.fingerprint) {
        rejectedFingerprints.add(cand.fingerprint);
      }
    }

    // All candidate raw sources were searched and none could play targetLang.
    this.activeProbe = null;
    this.desiredAudioLang = null;

    const cleanName = displayLabel || languageLabel(targetLang);
    const unavailableMessage = `Sorry, we searched all sources yet didn't find it in "${cleanName}"`;

    // Restore playable video so the player does not remain on a dead/unloaded screen
    const fallbackOpt =
      prevWorkingSource ?? this.sources.find((s) => !this.isCandidateFailed(s)) ?? null;
    if (!fallbackOpt) {
      this.emit('error', { code: 'all-sources-failed', message: 'All playable sources failed' });
    }

    if (fallbackOpt && (this.currentSource?.id !== fallbackOpt.id || (this.currentSource && this.isCandidateFailed(this.currentSource)))) {
      await this.activateSourceOption(fallbackOpt, savedTime > 0.5);
      if (savedTime > 0.5 && wasPlaying) void this.play();
    } else {
      this.shell.dataset.buffering = 'false';
    }

    this.emit('audio:unavailable', {
      lang: targetLang,
      label: cleanName,
      triedSources: candidates.length,
      message: unavailableMessage,
    });
    return false;
  }

  private probeRawCandidateForLanguage(
    opt: SourceOption,
    targetLang: string,
    seq: number,
  ): Promise<{ ok: boolean; loadFailed?: boolean }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        finish({ ok: false, loadFailed: true });
      }, 4200);

      const finish = (res: { ok: boolean; loadFailed?: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeProbe?.seq === seq && this.activeProbe.opt.id === opt.id) {
          this.activeProbe = null;
        }
        resolve(res);
      };

      this.activeProbe = { seq, targetLang, opt, settle: finish };

      const cfg = this.input.config;
      this.currentSource = opt;
      cfg.src = opt.url;
      cfg.server = opt.id;
      cfg.audioTracks = opt.audioTracks?.map((a) => ({ lang: a.lang, label: a.label, url: a.url })) ?? [];
      cfg.subsrc = opt.subtitles?.map((s) => ({ lang: s.lang, label: s.label, url: s.url })) ?? [];

      const engineHint = opt.type === 'mp4' ? 'native' : opt.type;
      void this.load(opt.url, engineHint);
    });
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
      if (on && document.fullscreenElement !== this.shell) {
        await this.shell.requestFullscreen();
        this.lockLandscapeOrientation();
      } else if (!on && document.fullscreenElement) {
        this.unlockLandscapeOrientation();
        await document.exitFullscreen();
      }
    } catch (err) {
      this.emit('error', { code: 'fullscreen-failed', message: String(err) });
    }
  }

  private lockLandscapeOrientation(): void {
    try {
      const ori = (
        globalThis.screen as unknown as {
          orientation?: { lock?: (mode: string) => Promise<void> };
        }
      )?.orientation;
      ori?.lock?.('landscape')?.catch?.(() => {});
    } catch {
      /* ignore on desktop / unsupported browsers */
    }
  }

  private unlockLandscapeOrientation(): void {
    try {
      const ori = (
        globalThis.screen as unknown as {
          orientation?: { unlock?: () => void };
        }
      )?.orientation;
      ori?.unlock?.();
    } catch {
      /* ignore */
    }
  }

  getZoomMode(): 'fit' | 'cover' {
    return this.zoomMode;
  }

  setZoomMode(mode: 'fit' | 'cover'): void {
    const clean = mode === 'cover' ? 'cover' : 'fit';
    if (this.zoomMode === clean && this.shell.dataset.zoom === clean) return;
    this.zoomMode = clean;
    this.shell.dataset.zoom = clean;
    this.emit('zoomChange', { mode: clean });
  }

  getAudioBoost(): number {
    return this.audioBoostPct;
  }

  setAudioBoost(pct: number): void {
    const clamped = Math.round(Math.max(100, Math.min(200, Number(pct) || 100)));
    this.audioBoostPct = clamped;

    if (clamped <= 100 && !this.audioBoostCtx) {
      this.emit('audioBoostChange', { pct: 100 });
      return;
    }

    try {
      if (!this.audioBoostCtx) {
        const AudioCtx =
          globalThis.AudioContext ??
          (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          const srcNode = ctx.createMediaElementSource(this.video);
          const shelf = ctx.createBiquadFilter();
          shelf.type = 'highshelf';
          shelf.frequency.value = 2200;
          shelf.gain.value = 0;

          const limiter = ctx.createDynamicsCompressor();
          limiter.threshold.value = -2.5;
          limiter.knee.value = 6;
          limiter.ratio.value = 14;
          limiter.attack.value = 0.003;
          limiter.release.value = 0.14;

          const gain = ctx.createGain();
          gain.gain.value = 1;

          srcNode.connect(shelf);
          shelf.connect(limiter);
          limiter.connect(gain);
          gain.connect(ctx.destination);

          this.audioBoostCtx = ctx;
          this.audioBoostShelf = shelf;
          this.audioBoostGain = gain;
        }
      }

      if (this.audioBoostCtx && this.audioBoostCtx.state === 'suspended') {
        void this.audioBoostCtx.resume().catch(() => {});
      }
      if (this.audioBoostGain) {
        this.audioBoostGain.gain.value = clamped / 100;
      }
      if (this.audioBoostShelf) {
        this.audioBoostShelf.gain.value = ((clamped - 100) / 100) * 3.5;
      }
    } catch {
      /* ignore WebAudio limitation on restricted environments */
    }

    this.emit('audioBoostChange', { pct: clamped });
  }

  getSubtitleOffset(): number {
    return this.subtitleOffsetSec;
  }

  setSubtitleOffset(sec: number): void {
    const clean = Math.round(Math.max(-30, Math.min(30, Number(sec) || 0)) * 20) / 20;
    this.subtitleOffsetSec = Object.is(clean, -0) ? 0 : clean;
    this.emit('subtitleOffsetChange', { offsetSec: this.subtitleOffsetSec });
  }

  nudgeSubtitleOffset(deltaSec: number): number {
    this.setSubtitleOffset(this.subtitleOffsetSec + deltaSec);
    return this.subtitleOffsetSec;
  }

  getSeasonCatalog(season?: number): SeasonCatalogInfo | null {
    const s = Math.max(1, Math.floor(season ?? this.input.config.season ?? 1));
    return this.seasonCatalogCache.get(s) ?? null;
  }

  getNextEpisodeTarget(): NextEpisodeTarget | null {
    return this.nextEpisodeTarget;
  }

  async fetchSeasonEpisodes(seasonInput?: number): Promise<SeasonCatalogInfo> {
    const cfg = this.input.config;
    const tmdbId = String(cfg.tmdb || this.mediaInfo?.tmdbId || '');
    const season = Math.max(1, Math.floor(seasonInput ?? cfg.season ?? this.mediaInfo?.season ?? 1));

    const cached = this.seasonCatalogCache.get(season);
    if (cached) {
      this.recomputeNextEpisodeTarget();
      return cached;
    }

    const synthesizeFallback = (): SeasonCatalogInfo => {
      const curEp = Math.max(1, Number(cfg.episode ?? this.mediaInfo?.episode ?? 1));
      const knownSeasons = this.mediaInfo?.seasons?.length
        ? this.mediaInfo.seasons
        : [{ seasonNumber: season, name: `Season ${season}`, episodeCount: Math.max(12, curEp + 2) }];
      const seasonMeta = knownSeasons.find((x) => x.seasonNumber === season);
      const count = Math.max(seasonMeta?.episodeCount || 0, season === (cfg.season ?? 1) ? curEp + 2 : 12, 12);
      const episodes: EpisodeItemInfo[] = [];
      for (let i = 1; i <= count; i++) {
        episodes.push({
          episodeNumber: i,
          seasonNumber: season,
          name:
            season === (cfg.season ?? 1) && i === curEp && this.mediaInfo?.episodeName
              ? this.mediaInfo.episodeName
              : `Episode ${i}`,
          overview: '',
          runtime: null,
          rating: null,
          airDate: '',
          still: null,
        });
      }
      return { tmdbId, season, seasons: knownSeasons, episodes };
    };

    if (!tmdbId) {
      const syn = synthesizeFallback();
      this.seasonCatalogCache.set(season, syn);
      this.recomputeNextEpisodeTarget();
      this.emit('episodesCatalog', syn);
      return syn;
    }

    try {
      const apiBase = cfg.api || '/api/v1/playback';
      const epUrl = new URL('/api/v1/episodes', new URL(apiBase, window.location.href));
      epUrl.searchParams.set('tmdb', tmdbId);
      epUrl.searchParams.set('s', String(season));
      if (cfg.nonce) epUrl.searchParams.set('nonce', String(cfg.nonce));

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (cfg.pltoken) headers['X-Playback-Token'] = String(cfg.pltoken);
      const canOpenEnvelope =
        Boolean(cfg.pltoken && cfg.nonce) &&
        typeof globalThis.crypto?.subtle?.decrypt === 'function';
      if (canOpenEnvelope) headers['X-Elfura-Envelope'] = '1';

      const res = await fetch(epUrl.toString(), { headers });
      if (res.ok) {
        type EpEnvelope = Partial<SeasonCatalogInfo> & { ok?: boolean; s?: number; p?: string };
        const raw = (await res.json()) as EpEnvelope;
        const data: EpEnvelope =
          raw?.s === 1 && typeof raw.p === 'string' && cfg.pltoken && cfg.nonce
            ? await openSealedEnvelope<EpEnvelope>(raw.p, String(cfg.pltoken), String(cfg.nonce))
            : raw;

        if (data?.ok && Array.isArray(data.episodes) && data.episodes.length > 0) {
          const cat: SeasonCatalogInfo = {
            tmdbId,
            season,
            seasons:
              Array.isArray(data.seasons) && data.seasons.length > 0
                ? data.seasons
                : [{ seasonNumber: season, name: `Season ${season}`, episodeCount: data.episodes.length }],
            episodes: data.episodes,
          };
          this.seasonCatalogCache.set(season, cat);
          this.recomputeNextEpisodeTarget();
          this.emit('episodesCatalog', cat);
          return cat;
        }
      }
    } catch {
      /* fall through to synthesized episode list */
    }

    const syn = synthesizeFallback();
    this.seasonCatalogCache.set(season, syn);
    this.recomputeNextEpisodeTarget();
    this.emit('episodesCatalog', syn);
    return syn;
  }

  private recomputeNextEpisodeTarget(): void {
    const cfg = this.input.config;
    const isTv = (cfg.mediaType || this.mediaInfo?.type) === 'tv';
    if (!isTv) {
      this.nextEpisodeTarget = null;
      this.emit('nextEpisodeReady', null);
      return;
    }

    const curS = Math.max(1, Number(cfg.season ?? this.mediaInfo?.season ?? 1));
    const curE = Math.max(1, Number(cfg.episode ?? this.mediaInfo?.episode ?? 1));
    const cat = this.seasonCatalogCache.get(curS);

    let next: NextEpisodeTarget | null = null;
    if (cat && cat.episodes.length > 0) {
      const inSeason = cat.episodes.find((e) => e.episodeNumber === curE + 1);
      if (inSeason) {
        next = { season: curS, episode: inSeason.episodeNumber, name: inSeason.name };
      } else {
        const nextSeason = cat.seasons.find((s) => s.seasonNumber === curS + 1 && s.episodeCount > 0);
        if (nextSeason) {
          next = { season: nextSeason.seasonNumber, episode: 1, name: `${nextSeason.name} · E1` };
        }
      }
    } else {
      next = { season: curS, episode: curE + 1 };
    }

    this.nextEpisodeTarget = next;
    this.emit('nextEpisodeReady', next);
  }

  private async prewarmNextEpisode(): Promise<void> {
    const cfg = this.input.config;
    if (!cfg.tmdb || this.destroyed) return;
    const target = this.nextEpisodeTarget;
    if (!target) return;

    const key = `${cfg.tmdb}:${target.season}:${target.episode}`;
    if (this.prewarmedKeyTriggered === key) return;
    this.prewarmedKeyTriggered = key;

    try {
      const apiBase = cfg.api || '/api/v1/playback';
      const apiUrl = new URL(apiBase, window.location.href);
      apiUrl.searchParams.set('type', 'tv');
      apiUrl.searchParams.set('tmdb', String(cfg.tmdb));
      apiUrl.searchParams.set('s', String(target.season));
      apiUrl.searchParams.set('e', String(target.episode));
      if (cfg.source) apiUrl.searchParams.set('source', String(cfg.source));
      const prefLang =
        this.desiredAudioLang ??
        (cfg.lang ? String(cfg.lang) : null) ??
        loadPreferredAudio();
      if (prefLang && prefLang !== 'und') apiUrl.searchParams.set('lang', prefLang);
      if (cfg.nonce) apiUrl.searchParams.set('nonce', String(cfg.nonce));

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (cfg.pltoken) headers['X-Playback-Token'] = String(cfg.pltoken);
      const canOpenEnvelope =
        Boolean(cfg.pltoken && cfg.nonce) &&
        typeof globalThis.crypto?.subtle?.decrypt === 'function';
      if (canOpenEnvelope) headers['X-Elfura-Envelope'] = '1';

      const res = await fetch(apiUrl.toString(), { headers });
      if (!res.ok || this.destroyed) return;

      type PlaybackPayloadShape = {
        ok?: boolean;
        s?: number;
        p?: string;
        media?: TitleMediaInfo;
        primary?: SourceOption;
        sources?: SourceOption[];
        segments?: { intro?: [number, number]; outro?: [number, number]; recap?: [number, number] };
      };
      const rawJson = (await res.json()) as PlaybackPayloadShape;
      const data: PlaybackPayloadShape =
        rawJson?.s === 1 && typeof rawJson.p === 'string' && cfg.pltoken && cfg.nonce
          ? await openSealedEnvelope<PlaybackPayloadShape>(
              rawJson.p,
              String(cfg.pltoken),
              String(cfg.nonce),
            )
          : rawJson;

      if (!data?.ok || !data.sources?.length || this.destroyed) return;

      const topCandidate = data.primary ?? data.sources[0];
      // Warm manifest ticket in RAM so hls.js starts playback in ~0.2s when clicked
      if (this.canPreProbeViaFetch(topCandidate)) {
        const ctrl = new AbortController();
        void this.probeCandidateViaFetch(
          topCandidate,
          prefLang && prefLang !== 'und' ? canonLang(prefLang) : null,
          ctrl.signal,
        ).catch(() => {});
      }

      this.prewarmedNext = {
        season: target.season,
        episode: target.episode,
        media: data.media,
        sources: data.sources,
        fastest: topCandidate,
        segments: data.segments,
      };
    } catch {
      /* non-fatal background pre-warm */
    }
  }

  async loadEpisode(seasonInput: number, episodeInput: number): Promise<void> {
    const cfg = this.input.config;
    const season = Math.max(1, Math.floor(Number(seasonInput) || 1));
    const episode = Math.max(1, Math.floor(Number(episodeInput) || 1));
    cfg.mediaType = 'tv';
    cfg.season = season;
    cfg.episode = episode;
    cfg.title = undefined;
    cfg.intro = undefined;
    cfg.outro = undefined;
    this.prewarmedKeyTriggered = '';

    // Update browser path seamlessly without dropping fullscreen if running on /embed/tv/:id/:s/:e
    try {
      const m = window.location.pathname.match(/^(\/embed\/tv\/[^/]+)\/\d+\/\d+(\/?)$/);
      if (m) {
        const nextUrl = `${m[1]}/${season}/${episode}${m[2]}${window.location.search}${window.location.hash}`;
        window.history.replaceState(null, '', nextUrl);
      }
    } catch {
      /* ignore sandboxed history restrictions */
    }

    this.emit('episodeChange', { season, episode });

    const pre = this.prewarmedNext;
    this.prewarmedNext = null;

    if (pre && pre.season === season && pre.episode === episode && pre.sources.length > 0) {
      if (pre.media) {
        this.mediaInfo = pre.media;
        if (pre.media.title) cfg.title = pre.media.title;
        const posterCand = pre.media.backdrop || pre.media.poster;
        if (posterCand) {
          cfg.poster = posterCand;
          this.video.poster = posterCand;
        }
      }
      if (pre.segments) {
        const segIntro = pre.segments.intro ?? pre.segments.recap;
        if (segIntro) cfg.intro = [{ lang: String(segIntro[0]), url: String(segIntro[1]) }];
        if (pre.segments.outro) cfg.outro = [{ lang: String(pre.segments.outro[0]), url: String(pre.segments.outro[1]) }];
      }
      this.emit('segments:invalidate', {});

      this.sources = pre.sources;
      this.failedSourceIds.clear();
      this.failedFingerprints.clear();
      this.initialAudioApplied = false;
      if (this.mediaInfo) this.emit('media', this.mediaInfo);
      void this.fetchSeasonEpisodes(season);

      const keepLang =
        this.desiredAudioLang ?? (cfg.lang ? canonLang(String(cfg.lang)) : null) ?? loadPreferredAudio();
      this.reorderSourcesHierarchy(keepLang);

      if (keepLang && keepLang !== 'und') {
        this.initialAudioApplied = true;
        await this.setAudio(keepLang);
      } else {
        await this.activateSourceOption(pre.fastest, false);
      }
      void this.play();
      return;
    }

    await this.resolveFromBackend();
    void this.play();
  }

  async nextEpisode(): Promise<boolean> {
    if (!this.nextEpisodeTarget) {
      this.recomputeNextEpisodeTarget();
    }
    const target = this.nextEpisodeTarget;
    if (!target) return false;
    await this.loadEpisode(target.season, target.episode);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.teardownEngine();
    this.externalAudio.destroy();
    this.renderer?.destroy();
    if (this.audioBoostCtx) {
      void this.audioBoostCtx.close().catch(() => {});
      this.audioBoostCtx = null;
    }
    this.bus.clear();
    this.video.removeAttribute('src');
    this.video.load();
  }

  /* ------------------------------------------------------------------ */
  /* Engines                                                             */
  /* ------------------------------------------------------------------ */

  private clearStartupWatchdog(): void {
    if (this.startupWatchdogTimer) {
      clearTimeout(this.startupWatchdogTimer);
      this.startupWatchdogTimer = null;
    }
  }

  private armStartupWatchdog(expectedSourceId: string | undefined): void {
    this.clearStartupWatchdog();
    if (!expectedSourceId || this.sources.length < 2 || this.activeProbe) return;
    this.startupWatchdogTimer = setTimeout(() => {
      this.startupWatchdogTimer = null;
      if (
        this.destroyed ||
        this.activeProbe ||
        this.currentSource?.id !== expectedSourceId ||
        this.video.readyState >= 1
      ) {
        return;
      }
      this.failover();
    }, 4500);
  }

  private teardownEngine(): void {
    this.clearStartupWatchdog();
    this.hls?.destroy();
    this.hls = null;
    if (this.dash) {
      this.dash.reset();
      this.dash = null;
    }
    this.externalAudio.deactivate();
    this.audioTracks = [];
    this.subtitleTracks = [];
    this.qualityLevels = [];
    this.currentAudio = null;
    this.currentSubtitle = null;
    this.cues = [];
    this.renderer?.setCues([]);
    this.effectiveHeight = 0;
  }

  /**
   * Select from the incoming manifest, never from `this.audioTracks` (which may
   * still belong to the previously playing source during a language probe).
   * Returns true only when the requested language is confirmed by the manifest
   * or by explicit source metadata; an empty manifest alone is not treated as
   * proof that a language is absent during the earlier fetch-probe phase.
   */
  private applyHlsProbeAudioSelection(
    probe: { targetLang: string; opt: SourceOption },
    manifestAudioTracks: { id: number; lang?: string; name?: string }[],
    hls: { audioTrack: number },
  ): boolean {
    const hit = manifestAudioTracks.find((track) => {
      const langCode = canonLang(track.lang);
      const nameCode = canonLang(track.name);
      return (
        (langCode !== 'und' && matchScore(probe.targetLang, langCode) >= 0) ||
        (nameCode !== 'und' && matchScore(probe.targetLang, nameCode) >= 0)
      );
    });
    if (hit) {
      hls.audioTrack = hit.id;
      return true;
    }

    const sourceMetadataMatch =
      matchScore(probe.targetLang, probe.opt.audioLang ?? 'und') >= 0 ||
      (probe.opt.availableAudioLangs ?? []).some(
        (lang) => matchScore(probe.targetLang, lang) >= 0,
      ) ||
      (probe.opt.audioTracks ?? []).some(
        (track) => matchScore(probe.targetLang, track.lang) >= 0,
      );
    // A single undubbed/untagged playlist may inherit explicit source language
    // metadata. Multiple manifest tracks without a match are a real rejection.
    return manifestAudioTracks.length <= 1 && sourceMetadataMatch;
  }

  private async loadHls(url: string): Promise<void> {
    const cfg = this.input.config;
    const Hls = await getHls();
    this.HlsClass = Hls;
    if (this.destroyed) return;

    if (!Hls.isSupported()) {
      if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
        this.engineKind = 'native';
        this.loadNative(url);
      } else {
        this.activeProbe?.settle({ ok: false, loadFailed: true });
        this.emit('error', { code: 'hls-unsupported', message: 'No MSE and no native HLS' });
      }
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      capLevelToPlayerSize: true,
      abrEwmaDefaultEstimate: 1_200_000,
      backBufferLength: 60,
      maxBufferLength: 18,
      maxMaxBufferLength: 45,
      startFragPrefetch: true,
      manifestLoadingTimeOut: 5500,
      levelLoadingTimeOut: 5500,
      fragLoadingTimeOut: 7000,
      xhrSetup: (xhr, reqUrl) => {
        // Only send X-Playback-Token to Elfura's own backend — never trigger CORS preflight
        // or expose session tokens to offloaded external anonymous segment CDNs.
        if (cfg.pltoken && this.isBackendOwnedUrl(reqUrl)) {
          xhr.setRequestHeader('X-Playback-Token', String(cfg.pltoken));
        }
      },
    });
    this.hls = hls;

    let startupFragErrors = 0;
    this.armStartupWatchdog(this.currentSource?.id);

    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      // Guard against HEVC-only levels on MSE engines without hardware HEVC support
      const hasPlayableCodec =
        data.levels.length === 0 ||
        this.supportsHevc() ||
        data.levels.some((l) => !/\b(?:hvc1|hev1)\b/i.test(String(l.videoCodec || l.codecSet || '')));
      if (!hasPlayableCodec) {
        this.handleFatal(Hls.ErrorTypes.MEDIA_ERROR, url, true);
        return;
      }

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

      const probe = this.activeProbe;
      if (probe && this.currentSource?.id === probe.opt.id) {
        queueMicrotask(() => {
          if (this.activeProbe?.seq !== probe.seq || this.hls !== hls) return;
          if (!this.applyHlsProbeAudioSelection(probe, data.audioTracks ?? [], hls)) {
            probe.settle({ ok: false, loadFailed: false });
            return;
          }

          // Require an actual media fragment / buffer append before confirming alive
          // so dead segments (403/404) or codec errors never falsely pass probing!
          const confirmAlive = () => {
            hls.off(Hls.Events.FRAG_LOADED, confirmAlive);
            hls.off(Hls.Events.BUFFER_APPENDED, confirmAlive);
            probe.settle({ ok: true });
          };
          hls.on(Hls.Events.FRAG_LOADED, confirmAlive);
          hls.on(Hls.Events.BUFFER_APPENDED, confirmAlive);
        });
      }
    });

    hls.on(Hls.Events.FRAG_LOADED, () => {
      startupFragErrors = 0;
      this.clearStartupWatchdog();
    });

    // The truth behind "Auto": what ABR is really serving right now.
    hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const level = this.qualityLevels.find((l) => l.id === data.level);
      if (!level) return;
      this.effectiveHeight = level.height;
      this.emit('qualityEffective', { height: level.height, label: level.label, mode: this.qualityMode });
    });

    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_e, data) => {
      const mapped = data.audioTracks.map((t, i) => ({
        id: t.id ?? i,
        lang: t.lang ?? 'und',
        label: t.name || undefined,
        default: !!t.default,
      }));
      if (this.currentSource && mapped.length > 0) {
        const discovered = mapped
          .map((m) => (canonLang(m.lang) !== 'und' ? canonLang(m.lang) : canonLang(m.label)))
          .filter((c) => c !== 'und');
        if (discovered.length > 0) {
          this.recordDiscoveredAudioLangs(this.currentSource, discovered);
        }
      }
      // Lock the requested audio track (e.g. Hindi on a Multi-Audio master!) SYNCHRONOUSLY
      // BEFORE hls.js starts fetching Default Track 0 (English) segments — zero wasted RTT!
      const wantedLang =
        this.activeProbe?.targetLang ||
        this.desiredAudioLang ||
        (this.input.config.lang ? canonLang(this.input.config.lang) : null);
      if (wantedLang && wantedLang !== 'und') {
        const hit = mapped.find((m) => {
          const c = canonLang(m.lang) !== 'und' ? canonLang(m.lang) : canonLang(m.label);
          return c !== 'und' && matchScore(wantedLang, c) >= 0;
        });
        if (hit && hls.audioTrack !== hit.id) {
          hls.audioTrack = hit.id;
        }
      }
      this.mergeNativeAudio(mapped);
    });

    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_e, data) => {
      this.subtitleTracks = (data.subtitleTracks ?? []).map((t) => ({
        id: `native:${t.id}`,
        kind: 'native' as const,
        lang: canonLang(t.lang || t.name),
        label: languageLabel(t.lang ?? 'und', t.name || undefined),
        url: t.url,
      }));
      this.mergeExternalSubs();
      this.emit('subtitleTracks', this.subtitleTracks);
    });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      const details = String(data.details || '');
      const unrecoverableCodec =
        details === 'bufferAddCodecError' || details === 'manifestIncompatibleCodecsError';
      if (unrecoverableCodec) {
        this.handleFatal(data.type, url, true);
        return;
      }

      // If an offloaded external segment fails (e.g. mobile ISP DNS-blocks a raw CDN),
      // transparently switch this stream to `&p=1` (100% backend relay) before abandoning it.
      const errExtra = data as unknown as { frag?: { url?: string }; url?: string };
      const failedTargetUrl = String(errExtra.frag?.url || errExtra.url || '');
      if (
        !this.activeProbe &&
        /^(?:fragLoadError|fragLoadTimeOut)$/i.test(details) &&
        failedTargetUrl &&
        !this.isBackendOwnedUrl(failedTargetUrl) &&
        this.isBackendOwnedUrl(url) &&
        !url.includes('p=1')
      ) {
        const proxiedUrl = this.withForcedProxyParam(url);
        cfg.src = proxiedUrl;
        if (this.currentSource && this.currentSource.url === url) {
          this.currentSource = { ...this.currentSource, url: proxiedUrl };
        }
        void this.load(proxiedUrl, 'hls');
        return;
      }

      if (
        !data.fatal &&
        this.video.readyState === 0 &&
        /^(?:fragLoadError|fragLoadTimeOut|keyLoadError|levelLoadError|audioTrackLoadError)$/i.test(details)
      ) {
        startupFragErrors++;
        if (startupFragErrors >= 2) {
          this.handleFatal(data.type, url, true);
          return;
        }
      }
      if (!data.fatal) return;
      this.handleFatal(data.type, url, false);
    });

    hls.loadSource(this.decorate(url));
    hls.attachMedia(this.video);
    void this.handleAutoplay();
  }

  private async loadDash(url: string): Promise<void> {
    const cfg = this.input.config;
    const Dash = await getDash();
    if (this.destroyed) return;
    const player = Dash().create();
    this.dash = player;
    const extras = player as unknown as DashExtras;
    if (cfg.pltoken && extras.extend) {
      extras.extend(
        'RequestModifier',
        () => ({
          modifyRequestHeader: (xhr: XMLHttpRequest, info?: { url?: string }) => {
            if (!info?.url || this.isBackendOwnedUrl(info.url)) {
              xhr.setRequestHeader('X-Playback-Token', String(cfg.pltoken));
            }
            return xhr;
          },
          modifyRequestURL: (u: string) => u,
        }),
        true,
      );
    }
    player.initialize(this.video, this.decorate(url), false);

    player.on(Dash.events.STREAM_INITIALIZED, () => {
      const dashAudio = player.getTracksFor('audio');
      this.mergeNativeAudio(
        dashAudio.map((t: MediaInfo, i: number) => ({
          id: i,
          lang: t.lang ?? 'und',
          label: t.labels?.length ? String(t.labels[0].text) : undefined,
          default: i === 0,
        })),
      );
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
      this.applyQualityCap();

      this.subtitleTracks = player.getTracksFor('text').map((t: MediaInfo, i: number) => ({
        id: `native:text:${i}`,
        kind: 'native' as const,
        lang: canonLang(t.lang),
        label: languageLabel(t.lang ?? 'und'),
      }));
      this.mergeExternalSubs();
      this.emit('subtitleTracks', this.subtitleTracks);

      const probe = this.activeProbe;
      if (probe && this.currentSource?.id === probe.opt.id) {
        const match = dashAudio.find((t: MediaInfo) => matchScore(probe.targetLang, t.lang ?? '') >= 0);
        if (match) {
          player.setCurrentTrack(match);
          probe.settle({ ok: true });
        } else if (probe.opt.multiAudio || dashAudio.length > 1) {
          probe.settle({ ok: false, loadFailed: false });
        } else if (matchScore(probe.targetLang, probe.opt.audioLang ?? 'und') >= 0) {
          probe.settle({ ok: true });
        } else {
          probe.settle({ ok: false, loadFailed: false });
        }
      }
    });

    player.on(Dash.events.QUALITY_CHANGE_RENDERED, (e: { mediaType?: string; newQuality?: number }) => {
      if (e.mediaType !== 'video') return;
      const level = this.qualityLevels.find((l) => l.id === e.newQuality);
      if (!level) return;
      this.effectiveHeight = level.height;
      this.emit('qualityEffective', { height: level.height, label: level.label, mode: this.qualityMode });
    });

    player.on(Dash.events.ERROR, (e: { error?: unknown; message?: string }) => {
      if (this.activeProbe) {
        this.activeProbe.settle({ ok: false, loadFailed: true });
        return;
      }
      this.emit('error', { code: 'dash-error', message: e.message ?? String(e.error ?? 'unknown') });
      this.failover();
    });

    void this.handleAutoplay();
  }

  private loadNative(url: string): void {
    const probe = this.activeProbe;
    if (probe && this.currentSource?.id === probe.opt.id) {
      const onLoaded = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        if (matchScore(probe.targetLang, probe.opt.audioLang ?? 'und') >= 0 || probe.opt.multiAudio) {
          probe.settle({ ok: true });
        } else {
          probe.settle({ ok: false, loadFailed: false });
        }
      };
      this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
    }
    this.video.src = this.decorate(url);
    this.video.onerror = () => {
      if (this.activeProbe) {
        this.activeProbe.settle({ ok: false, loadFailed: true });
        return;
      }
      this.emit('error', { code: 'native-error', message: this.video.error?.message ?? 'media error' });
      this.failover();
    };
    void this.handleAutoplay();
  }

  private decorate(url: string): string {
    const cfg = this.input.config;
    if (!cfg.pltoken || !cfg.nonce || !this.isBackendOwnedUrl(url)) return url;
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
    if (!q || q === 'auto') return;
    const cap = Number(q);
    if (!Number.isFinite(cap)) return;
    const allowed = this.qualityLevels.filter((l) => l.height > 0 && l.height <= cap);
    if (this.hls) {
      this.hls.autoLevelCapping = allowed.length ? Math.max(...allowed.map((l) => l.id)) : -1;
    } else if (this.dash && allowed.length) {
      const top = allowed.reduce((a, b) => (a.bitrate >= b.bitrate ? a : b));
      const extras = this.dash as unknown as DashExtras;
      extras.updateSettings?.({
        streaming: { abr: { maxBitrate: { video: Math.ceil(top.bitrate / 1000) } } },
      });
    }
  }

  private handleFatal(type: string, url: string, immediateFailover = false): void {
    if (this.activeProbe) {
      this.activeProbe.settle({ ok: false, loadFailed: true });
      return;
    }
    this.fatalCount++;
    const Hls = this.HlsClass;
    if (!immediateFailover && this.hls && Hls) {
      if (type === Hls.ErrorTypes.MEDIA_ERROR && this.fatalCount < 2) {
        this.hls.recoverMediaError();
        return;
      }
      if (type === Hls.ErrorTypes.NETWORK_ERROR && this.fatalCount < 2) {
        this.hls.startLoad();
        return;
      }
    }
    this.emit('error', { code: 'fatal', type, fatalCount: this.fatalCount, url });
    this.failover();
  }

  /**
   * Walk `sources` on fatal error. If an audio language is actively selected,
   * first try all remaining raw sources of that selected language before
   * showing the unavailable-language notice and falling back.
   */
  private failover(): void {
    if (this.sources.length > 1) {
      if (this.currentSource) this.markCandidateFailed(this.currentSource);

      if (this.desiredAudioLang) {
        const lang = this.desiredAudioLang;
        void this.searchRawSourcesForLanguage(lang, languageLabel(lang), new Set(this.failedSourceIds));
        return;
      }

      const curIdx = this.currentSource ? this.sources.findIndex((s) => s.id === this.currentSource!.id) : -1;
      const ordered = [...this.sources.slice(curIdx + 1), ...this.sources.slice(0, Math.max(0, curIdx))].filter(
        (s) => !this.isCandidateFailed(s),
      );
      ordered.sort((a, b) => (a.latencyHintMs ?? 600) - (b.latencyHintMs ?? 600));
      const next = ordered[0];
      if (!next) {
        this.shell.dataset.buffering = 'false';
        this.emit('error', { code: 'all-sources-failed', message: 'All playable sources failed' });
        return;
      }
      this.emit('server:switch', {
        from: this.currentSource?.label ?? null,
        to: next.label,
        reason: 'fatal-error',
      });
      void this.activateSourceOption(next, true);
      return;
    }

    if (this.sources.length === 1) {
      this.markCandidateFailed(this.sources[0]);
      this.shell.dataset.buffering = 'false';
      this.emit('error', { code: 'all-sources-failed', message: 'The only playable source failed' });
      return;
    }

    const cfg = this.input.config;
    const servers = cfg.servers ?? [];
    if (servers.length < 2) {
      this.shell.dataset.buffering = 'false';
      this.emit('error', { code: 'all-sources-failed', message: 'All playable servers failed' });
      return;
    }
    const currentIdx = servers.findIndex((s) => s.url === cfg.src);
    const next = servers[currentIdx + 1];
    if (!next) return;
    this.emit('server:switch', { from: cfg.server ?? servers[currentIdx]?.lang ?? null, to: next.lang, reason: 'fatal-error' });
    cfg.src = next.url;
    cfg.server = next.lang;
    void this.load(next.url);
  }

  /* ------------------------------------------------------------------ */
  /* Dynamic Tracks (zero hardcoded audio/subtitle lists)                */
  /* ------------------------------------------------------------------ */

  private mergeNativeAudio(native: { id: number; lang: string; label?: string; default?: boolean }[]): void {
    const external = (this.input.config.audioTracks ?? []).map((x) => ({ lang: x.lang, label: x.label, url: x.url }));

    // Single-dub HLS/DASH manifests (e.g. `NAME="Audio"` with no LANGUAGE attribute)
    // inherit the known canonical language of `this.currentSource` so no bogus "Original" track appears.
    const singleSourceCanon =
      this.currentSource && !this.currentSource.multiAudio && this.currentSource.audioLang
        ? canonLang(this.currentSource.audioLang)
        : 'und';
    const normalizedNative =
      native.length === 1 &&
      singleSourceCanon !== 'und' &&
      canonLang(native[0].lang) === 'und' &&
      canonLang(native[0].label) === 'und'
        ? [
            {
              ...native[0],
              lang: singleSourceCanon,
              label: languageLabel(singleSourceCanon),
            },
          ]
        : native;

    // Dynamically gather audio languages actually reported across resolved raw sources
    const discoveredSourceLangs: { lang: string; label?: string; active?: boolean }[] = [];
    if (this.currentSource && !this.currentSource.multiAudio) {
      discoveredSourceLangs.push({
        lang: this.currentSource.audioLang ?? 'und',
        active: true,
      });
    }
    for (const s of this.sources) {
      if (this.isCandidateFailed(s)) continue;
      if (!s.multiAudio && s.audioLang) {
        discoveredSourceLangs.push({
          lang: s.audioLang,
          active: s.id === this.currentSource?.id,
        });
      }
      for (const l of s.availableAudioLangs ?? []) {
        discoveredSourceLangs.push({ lang: l });
      }
      for (const a of s.audioTracks ?? []) {
        discoveredSourceLangs.push({ lang: a.lang, label: a.label });
      }
    }

    this.audioTracks = buildTrackList({ native: normalizedNative, external, discoveredSourceLangs });

    // Reflect active desired/source language in currentAudio unless an engine probe is active
    if (this.audioTracks.length > 0 && !this.activeProbe) {
      const targetMatchLang =
        this.desiredAudioLang && this.desiredAudioLang !== 'und'
          ? this.desiredAudioLang
          : singleSourceCanon !== 'und'
            ? singleSourceCanon
            : null;
      const preferred =
        (targetMatchLang
          ? this.audioTracks.find((t) => matchScore(targetMatchLang, t.lang) >= 0)
          : null) ??
        (!this.currentAudio ? this.audioTracks.find((t) => t.default) ?? this.audioTracks[0] : null);
      if (preferred) this.currentAudio = preferred;
    }

    this.emit('audioTracks', this.audioTracks);
    if (!this.activeProbe) this.applyInitialAudio();
  }

  private mergeExternalSubs(): void {
    const external = (this.input.config.subsrc ?? []).map((x, i) => ({
      id: `external:${canonLang(x.lang || x.label)}:${i}`,
      kind: 'external' as const,
      lang: canonLang(x.lang || x.label),
      label: languageLabel(x.lang, x.label),
      url: x.url,
    }));
    const merged: SubtitleTrack[] = [];
    const seen = new Map<string, SubtitleTrack>();
    for (const track of [...this.subtitleTracks, ...external]) {
      // Same URL is always redundant; otherwise collapse only identical language + label
      // so meaningful variants such as English (Forced) and English (SDH) survive.
      const key = track.url
        ? `url:${track.url}`
        : `track:${track.lang}:${track.label.trim().toLowerCase()}`;
      const duplicate = seen.get(key);
      if (duplicate) {
        if (this.currentSubtitle?.id === track.id) this.currentSubtitle = duplicate;
        continue;
      }
      seen.set(key, track);
      merged.push(track);
    }
    this.subtitleTracks = merged;
    this.emit('subtitleTracks', this.subtitleTracks);
    this.applyInitialSubtitle();
  }

  private applyInitialPrefs(): void {
    this.applyInitialAudio();
    this.applyInitialSubtitle();
  }

  private applyInitialAudio(): void {
    if (this.initialAudioApplied || !this.audioTracks.length) return;
    const explicitLang = this.input.config.lang;
    const storedLang = loadPreferredAudio();
    const wanted = explicitLang ?? storedLang;
    if (!wanted) {
      this.initialAudioApplied = true;
      return;
    }

    const match = this.audioTracks.find((t) => matchScore(wanted, t.lang) >= 0);
    if (explicitLang) {
      this.initialAudioApplied = true;
      void this.setAudio(explicitLang);
    } else if (match) {
      this.initialAudioApplied = true;
      void this.setAudio(match.id);
    } else {
      this.initialAudioApplied = true;
    }
  }

  private applyInitialSubtitle(): void {
    if (this.currentSubtitle || !this.subtitleTracks.length) return;
    if (this.input.config.subtitles === false) return;
    const want = this.input.config.sublang;
    const pick =
      (want && this.subtitleTracks.find((t) => matchScore(want, t.lang) >= 0)) ??
      null;
    if (pick) void this.setSubtitle(pick.id);
  }

  /**
   * Native HLS subtitles arrive as a media playlist of subtitle segments, not one
   * file. Resolve all non-comment segment URIs (including `/api/v1/stream?t=...`
   * tickets), concatenate in order, and parse with our own subtitle engine.
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
        const segs = body
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'));
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
    v.addEventListener('loadedmetadata', () => this.clearStartupWatchdog());
    v.addEventListener('playing', () => {
      this.clearStartupWatchdog();
      this.emit('buffered', {});
    });
    v.addEventListener('durationchange', () => {
      this.emit('durationchange', { duration: v.duration });
      this.emit('segments:invalidate', {});
    });
    v.addEventListener('timeupdate', () => {
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      const payload = { time: v.currentTime, duration: d };
      this.bus.emit('timeupdate', payload);
      this.bridge.postTime(payload);

      if (
        (this.input.config.mediaType === 'tv' || this.mediaInfo?.type === 'tv') &&
        d > 20 &&
        v.currentTime / d >= 0.78 &&
        this.nextEpisodeTarget
      ) {
        void this.prewarmNextEpisode();
      }
    });
    v.addEventListener('volumechange', () => this.emit('volumechange', { volume: v.volume, muted: v.muted }));
    v.addEventListener('ratechange', () => this.emit('speedchange', { speed: v.playbackRate }));
    document.addEventListener('fullscreenchange', () => {
      const isFs = document.fullscreenElement === this.shell;
      if (isFs) this.lockLandscapeOrientation();
      else this.unlockLandscapeOrientation();
      this.emit('fullscreen', { on: isFs });
    });
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
    cmd('setSource', async (d) => this.setSource(String(val(d))));
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
    cmd('setSubtitleOffset', (d) => {
      this.setSubtitleOffset(Number(val(d)));
      return this.getSubtitleOffset();
    });
    cmd('setAudioBoost', (d) => {
      this.setAudioBoost(Number(val(d)));
      return this.getAudioBoost();
    });
    cmd('setZoomMode', (d) => {
      this.setZoomMode(String(val(d)) === 'cover' ? 'cover' : 'fit');
      return this.getZoomMode();
    });
    cmd('loadEpisode', async (d) => {
      const raw = d as { season?: number; episode?: number } | undefined;
      await this.loadEpisode(Number(raw?.season || 1), Number(raw?.episode || 1));
      return { season: this.input.config.season, episode: this.input.config.episode };
    });
    cmd('next', async () => {
      const switched = await this.nextEpisode();
      if (!switched) this.emit('episode:next', {});
      return switched;
    });

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

/**
 * Decrypts AES-256-GCM playback envelopes (`{ ok: true, s: 1, p }`) minted by
 * `/api/v1/playback` using WebCrypto so DevTools Network Preview never exposes
 * plaintext source metadata or stream tickets.
 */
async function openSealedEnvelope<T>(
  b64UrlPayload: string,
  pltoken: string,
  nonce: string,
): Promise<T> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable');
  const padded = b64UrlPayload.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const binStr = atob(padded + '='.repeat(padLen));
  const wire = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) wire[i] = binStr.charCodeAt(i);
  if (wire.byteLength < 29) throw new Error('truncated envelope');
  const iv = wire.slice(0, 12);
  const ctAndTag = wire.slice(12);
  const keySeed = new TextEncoder().encode(`${pltoken}:${nonce}:elfura-pb-v1`);
  const rawKey = await subtle.digest('SHA-256', keySeed);
  const cryptoKey = await subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, cryptoKey, ctAndTag);
  return JSON.parse(new TextDecoder().decode(plainBuf)) as T;
}

