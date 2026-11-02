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
  fingerprint?: string;
  latencyHintMs?: number;
  audioLang?: string;
  availableAudioLangs?: string[];
  multiAudio?: boolean;
  audioTracks: { lang: string; label: string; url: string }[];
  subtitles: { lang: string; label: string; url: string }[];
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
  private initialAudioApplied = false;
  private desiredAudioLang: string | null = null;
  private audioSearchSeq = 0;
  private activeProbe: {
    seq: number;
    targetLang: string;
    opt: SourceOption;
    settle: (res: { ok: boolean; loadFailed?: boolean }) => void;
  } | null = null;
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
    this.renderer.bindClock(() => this.video.currentTime);
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
      canPip: typeof v.requestPictureInPicture === 'function' && !v.disablePictureInPicture,
      canFullscreen: typeof this.shell.requestFullscreen === 'function',
    };
  }

  getSources(): SourceOption[] {
    return this.sources;
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

  async setSource(id: string): Promise<boolean> {
    const opt = this.sources.find((s) => s.id === id || s.sourceId === id);
    if (!opt) return false;
    this.audioSearchSeq++;
    this.activeProbe = null;
    this.failedSourceIds.clear();
    this.failedFingerprints.clear();
    this.desiredAudioLang = opt.audioLang && opt.audioLang !== 'und' ? canonLang(opt.audioLang) : null;
    this.initialAudioApplied = true;
    await this.activateSourceOption(opt, true, true);
    return true;
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

  private canPreProbeViaFetch(opt: SourceOption): boolean {
    if (typeof fetch !== 'function') return false;
    try {
      const base = new URL(window.location.href);
      const target = new URL(opt.url, base);
      return (target.protocol === 'http:' || target.protocol === 'https:') && target.origin === base.origin;
    } catch {
      return false;
    }
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
    return res + (opt.multiAudio ? 250 : 0);
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
  ): Promise<{ ok: boolean; loadFailed: boolean; rttMs: number }> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

    const cfg = this.input.config;
    const headers: Record<string, string> = {};
    if (cfg.pltoken) headers['X-Playback-Token'] = String(cfg.pltoken);

    const resolvedUrl = new URL(this.decorate(opt.url), window.location.href).toString();
    const timeoutSig =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.any([signal, AbortSignal.timeout(4500)])
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
        if (!ok) return { ok: false, loadFailed: true, rttMs: nowMs() };
        if (targetLang && targetLang !== 'und') {
          const matches =
            matchScore(targetLang, opt.audioLang ?? 'und') >= 0 ||
            (opt.audioTracks ?? []).some((a) => matchScore(targetLang, a.lang) >= 0) ||
            !!opt.multiAudio;
          if (!matches) return { ok: false, loadFailed: false, rttMs: nowMs() };
        }
        return { ok: true, loadFailed: false, rttMs: nowMs() };
      }

      const res = await fetch(resolvedUrl, { headers, signal: timeoutSig });
      if (!res.ok) return { ok: false, loadFailed: true, rttMs: nowMs() };
      const text = await res.text();
      const lead = text.trimStart();

      if (opt.type === 'dash' || lead.includes('<MPD')) {
        if (!lead.includes('<MPD')) return { ok: false, loadFailed: true, rttMs: nowMs() };
        return { ok: true, loadFailed: false, rttMs: nowMs() };
      }

      if (!lead.startsWith('#EXTM3U')) {
        return { ok: false, loadFailed: true, rttMs: nowMs() };
      }

      const lines = text.split(/\r?\n/);
      let matchedAudioUri: string | null = null;
      const audioMediaLines = lines.filter((l) => /^#EXT-X-MEDIA:.*TYPE=AUDIO\b/i.test(l.trim()));

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
              return { ok: false, loadFailed: false, rttMs: nowMs() };
            }
          } else if (opt.multiAudio && !opt.availableAudioLangs?.length && matchScore(targetLang, opt.audioLang ?? 'und') < 0) {
            return { ok: false, loadFailed: false, rttMs: nowMs() };
          }
        }
      }

      // If master playlist has child variant/audio playlists, verify & warm one child playlist too
      if (/#EXT-X-STREAM-INF\b/i.test(text)) {
        let childTarget = matchedAudioUri;
        if (!childTarget) {
          for (let i = 0; i < lines.length; i++) {
            if (/^#EXT-X-STREAM-INF\b/i.test(lines[i].trim())) {
              for (let j = i + 1; j < lines.length; j++) {
                const candLine = lines[j].trim();
                if (!candLine) continue;
                if (!candLine.startsWith('#')) childTarget = candLine;
                break;
              }
              if (childTarget) break;
            }
          }
        }
        if (childTarget) {
          const childUrl = new URL(this.decorate(childTarget), resolvedUrl).toString();
          const childRes = await fetch(childUrl, { headers, signal: timeoutSig });
          if (!childRes.ok) return { ok: false, loadFailed: true, rttMs: nowMs() };
          const childText = await childRes.text();
          if (!childText.trimStart().startsWith('#EXTM3U')) {
            return { ok: false, loadFailed: true, rttMs: nowMs() };
          }
        }
      }

      return { ok: true, loadFailed: false, rttMs: nowMs() };
    } catch {
      if (signal.aborted) return { ok: false, loadFailed: false, rttMs: nowMs() };
      return { ok: false, loadFailed: true, rttMs: nowMs() };
    }
  }

  /**
   * Concurrently races a batch of candidate servers and returns the fastest
   * healthy server (with a 65ms tie-breaker if a higher-resolution server is
   * right behind it), aborting slower in-flight probes immediately.
   */
  private async raceCandidatesBatch(
    batch: SourceOption[],
    targetLang: string | null,
  ): Promise<{ winner: SourceOption | null; failed: SourceOption[] }> {
    if (batch.length === 0) return { winner: null, failed: [] };

    const controllers = batch.map(() => new AbortController());
    const failed: SourceOption[] = [];
    const successes: { opt: SourceOption; rttMs: number; rank: number }[] = [];
    let pending = batch.length;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    return new Promise((resolve) => {
      const finish = (winner: SourceOption | null) => {
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
        resolve({ winner, failed });
      };

      const pickBestSuccess = (): SourceOption | null => {
        if (!successes.length) return null;
        successes.sort((a, b) => b.rank - a.rank || a.rttMs - b.rttMs);
        return successes[0].opt;
      };

      batch.forEach((opt, idx) => {
        const optRank = this.qualityRank(opt);
        void this.probeCandidateViaFetch(opt, targetLang, controllers[idx].signal).then((res) => {
          pending--;
          if (settled) return;

          if (res.ok) {
            successes.push({ opt, rttMs: res.rttMs, rank: optRank });
            // Check if any still-in-flight candidate in this batch has higher quality rank
            const hasHigherInFlight = batch.some(
              (other, j) => j !== idx && !controllers[j].signal.aborted && this.qualityRank(other) > optRank &&
                !failed.includes(other) && !successes.some((s) => s.opt.id === other.id),
            );
            if (!hasHigherInFlight || pending === 0) {
              finish(pickBestSuccess());
              return;
            }
            if (!graceTimer) {
              graceTimer = setTimeout(() => finish(pickBestSuccess()), 65);
            }
          } else {
            if (res.loadFailed) failed.push(opt);
            if (pending === 0) {
              finish(pickBestSuccess());
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
    // Gather top distinct-fingerprint general/default candidates across all sources
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
        (a.multiAudio === b.multiAudio ? 0 : a.multiAudio ? -1 : 1) ||
        (a.latencyHintMs ?? 600) - (b.latencyHintMs ?? 600) ||
        this.qualityRank(b) - this.qualityRank(a),
    );

    const seenFingerprints = new Set<string>();
    const wave: SourceOption[] = [];
    for (const s of sortedPool) {
      const fp = s.fingerprint || s.id;
      if (seenFingerprints.has(fp)) continue;
      seenFingerprints.add(fp);
      wave.push(s);
      if (wave.length >= 4) break;
    }

    if (wave.length <= 1) return wave[0] ?? fallbackPrimary;

    const { winner, failed } = await this.raceCandidatesBatch(wave, null);
    for (const f of failed) this.markCandidateFailed(f);
    if (winner) return winner;

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

      apiUrl.searchParams.set('type', cfg.mediaType || 'movie');
      apiUrl.searchParams.set('tmdb', String(cfg.tmdb));
      if ((cfg.mediaType || 'movie') === 'tv') {
        apiUrl.searchParams.set('s', String(cfg.season ?? 1));
        apiUrl.searchParams.set('e', String(cfg.episode ?? 1));
      }
      if (cfg.source) apiUrl.searchParams.set('source', String(cfg.source));
      if (cfg.lang) apiUrl.searchParams.set('lang', String(cfg.lang));
      if (cfg.nonce) apiUrl.searchParams.set('nonce', String(cfg.nonce));

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (cfg.pltoken) headers['X-Playback-Token'] = String(cfg.pltoken);

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

      const data = (await res.json()) as {
        ok?: boolean;
        media?: { title?: string; poster?: string | null; backdrop?: string | null };
        primary?: SourceOption;
        sources?: SourceOption[];
        segments?: { intro?: [number, number]; outro?: [number, number]; recap?: [number, number] };
      };
      if (this.destroyed) return;

      if (!data?.ok || !data.sources?.length) {
        this.shell.dataset.buffering = 'false';
        this.emit('error', { code: 'no-sources', message: 'No playable sources found' });
        return;
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

      this.sources = data.sources;
      this.failedSourceIds.clear();
      this.failedFingerprints.clear();
      this.initialAudioApplied = false;
      this.emit('config', redacted(cfg as unknown as Record<string, unknown>));
      this.emit('sources', this.sources);

      const storedLang = !cfg.lang ? loadPreferredAudio() : null;
      const storedMatchesAny =
        storedLang &&
        this.sources.some(
          (s) =>
            (s.audioLang && matchScore(storedLang, s.audioLang) >= 0) ||
            (s.availableAudioLangs ?? []).some((l) => matchScore(storedLang, l) >= 0) ||
            (s.audioTracks ?? []).some((a) => matchScore(storedLang, a.lang) >= 0),
        );

      if (cfg.lang) {
        this.initialAudioApplied = true;
        await this.setAudio(String(cfg.lang));
      } else if (storedLang && storedMatchesAny) {
        this.initialAudioApplied = true;
        await this.setAudio(storedLang);
      } else {
        const fallbackPrimary = data.primary ?? data.sources[0];
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

    // 1) Try instant in-band native track on the currently active healthy stream
    if (currentHealthy || (!this.sources.length && this.audioTracks.length > 0)) {
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

    const matchesLang = (s: SourceOption): boolean => {
      if (targetLang === 'und') {
        return !s.multiAudio && canonLang(s.audioLang) === 'und';
      }
      if (s.audioLang && matchScore(targetLang, s.audioLang) >= 0) return true;
      if ((s.availableAudioLangs ?? []).some((l) => matchScore(targetLang, l) >= 0)) return true;
      if ((s.audioTracks ?? []).some((a) => matchScore(targetLang, a.lang) >= 0)) return true;
      return false;
    };

    const priorityMatches = this.sources
      .filter((s) => !this.isCandidateFailed(s) && !excludeIds.has(s.id) && matchesLang(s))
      .sort(
        (a, b) =>
          (a.latencyHintMs ?? 600) - (b.latencyHintMs ?? 600) ||
          this.qualityRank(b) - this.qualityRank(a),
      );
    const untriedMultiAudio =
      targetLang === 'und'
        ? []
        : this.sources
            .filter(
              (s) =>
                !this.isCandidateFailed(s) &&
                !excludeIds.has(s.id) &&
                !priorityMatches.some((p) => p.id === s.id) &&
                !!s.multiAudio &&
                !s.availableAudioLangs?.length,
            )
            .sort((a, b) => (a.latencyHintMs ?? 600) - (b.latencyHintMs ?? 600));

    const candidates = [...priorityMatches, ...untriedMultiAudio];

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

    // Phase A: Concurrent parallel waves for relay-backed candidates (fastest server wins!)
    const fetchPool = candidates.filter((c) => this.canPreProbeViaFetch(c));
    let cursor = 0;
    while (cursor < fetchPool.length) {
      if (this.destroyed || this.audioSearchSeq !== seq) return false;

      const wave: SourceOption[] = [];
      const waveFps = new Set<string>();
      while (cursor < fetchPool.length && wave.length < 5) {
        const c = fetchPool[cursor++];
        if (this.isCandidateFailed(c)) continue;
        const fp = c.fingerprint || c.id;
        if (rejectedFingerprints.has(fp) || waveFps.has(fp)) continue;
        waveFps.add(fp);
        wave.push(c);
      }
      if (!wave.length) continue;

      const { winner, failed } = await this.raceCandidatesBatch(wave, targetLang);
      if (this.destroyed || this.audioSearchSeq !== seq) return false;

      for (const f of failed) this.markCandidateFailed(f);

      if (winner) {
        triedEngineIds.add(winner.id);
        const attachRes = await this.probeRawCandidateForLanguage(winner, targetLang, seq);
        if (this.destroyed || this.audioSearchSeq !== seq) return false;
        if (attachRes.ok) {
          return finalizeChosenCandidate(winner);
        }
        if (attachRes.loadFailed) this.markCandidateFailed(winner);
        if (winner.fingerprint) rejectedFingerprints.add(winner.fingerprint);
        // Re-scan remaining pool in case another candidate in `wave` was also healthy
        cursor = Math.max(0, cursor - wave.length);
      } else {
        for (const w of wave) {
          if (w.fingerprint) rejectedFingerprints.add(w.fingerprint);
          triedEngineIds.add(w.id);
        }
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
      }, 8500);

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
      backBufferLength: 60,
      maxBufferLength: 20,
      maxMaxBufferLength: 60,
      startFragPrefetch: true,
      manifestLoadingTimeOut: 8000,
      levelLoadingTimeOut: 8000,
      fragLoadingTimeOut: 10000,
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

      const probe = this.activeProbe;
      if (probe && this.currentSource?.id === probe.opt.id) {
        queueMicrotask(() => {
          if (this.activeProbe?.seq !== probe.seq || this.hls !== hls) return;
          const nativeMatch = this.audioTracks.find(
            (t) => t.kind === 'native' && matchScore(probe.targetLang, t.lang) >= 0,
          );
          if (nativeMatch && typeof nativeMatch.ref === 'number') {
            hls.audioTrack = nativeMatch.ref;
          } else if (probe.opt.multiAudio || (data.audioTracks?.length ?? 0) > 1) {
            probe.settle({ ok: false, loadFailed: false });
            return;
          } else if (matchScore(probe.targetLang, probe.opt.audioLang ?? 'und') < 0) {
            probe.settle({ ok: false, loadFailed: false });
            return;
          }

          const confirmAlive = () => {
            hls.off(Hls.Events.LEVEL_LOADED, confirmAlive);
            hls.off(Hls.Events.AUDIO_TRACK_LOADED, confirmAlive);
            hls.off(Hls.Events.FRAG_LOADED, confirmAlive);
            probe.settle({ ok: true });
          };
          hls.on(Hls.Events.LEVEL_LOADED, confirmAlive);
          hls.on(Hls.Events.AUDIO_TRACK_LOADED, confirmAlive);
          hls.on(Hls.Events.FRAG_LOADED, confirmAlive);
        });
      }
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
        lang: canonLang(t.lang || t.name),
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
          modifyRequestHeader: (xhr: XMLHttpRequest) => {
            xhr.setRequestHeader('X-Playback-Token', String(cfg.pltoken));
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

  private handleFatal(type: string, url: string): void {
    if (this.activeProbe) {
      this.activeProbe.settle({ ok: false, loadFailed: true });
      return;
    }
    this.fatalCount++;
    const Hls = this.HlsClass;
    if (this.hls && Hls) {
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
      if (!next) return;
      this.emit('server:switch', {
        from: this.currentSource?.label ?? null,
        to: next.label,
        reason: 'fatal-error',
      });
      void this.activateSourceOption(next, true);
      return;
    }

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
  /* Dynamic Tracks (zero hardcoded audio/subtitle lists)                */
  /* ------------------------------------------------------------------ */

  private mergeNativeAudio(native: { id: number; lang: string; label?: string; default?: boolean }[]): void {
    const external = (this.input.config.audioTracks ?? []).map((x) => ({ lang: x.lang, label: x.label, url: x.url }));

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

    this.audioTracks = buildTrackList({ native, external, discoveredSourceLangs });

    // Reflect active single-dub source in currentAudio unless an initial preference is pending
    if (!this.currentAudio && this.audioTracks.length > 0 && !this.activeProbe) {
      const def = this.audioTracks.find((t) => t.default) ?? this.audioTracks[0];
      if (def) this.currentAudio = def;
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
    const merged = [...this.subtitleTracks];
    for (const e of external) {
      const dup = merged.some(
        (t) => (e.url && t.url === e.url) || (t.kind === 'native' && t.lang === e.lang && t.label === e.label),
      );
      if (!dup) merged.push(e);
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
