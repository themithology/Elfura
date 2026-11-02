/**
 * Elfura Player — Audio track layer
 * =================================
 *
 * Two kinds of track exist and they behave differently. Conflating them is the
 * usual source of "why does switching language stutter?" bugs.
 *
 *  A) NATIVE tracks — muxed into the manifest.
 *       HLS : EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=...,LANGUAGE="hi",DEFAULT=YES
 *       DASH: <AdaptationSet contentType="audio" lang="hi">
 *     Switching is a clean in-band operation: hls.js/dash.js detach the old
 *     SourceBuffer and append the new language without touching the clock.
 *     No video interruption, no re-buffer of what you already have.
 *
 *  B) EXTERNAL tracks — a separate audio file per language (?audioTracks=).
 *     Common when dubs are produced/hosted apart from the video. There is no
 *     way to switch these in-band without remuxing, so the player keeps the
 *     video element running (muted) and drives a second <audio> element locked
 *     to the video clock. Drift is corrected continuously.
 *
 * Everything above the two adapters sees one unified AudioTrack list.
 */

export type TrackKind = 'native' | 'external';

export interface AudioTrack {
  /** Stable id for the API. Native tracks are prefixed so ids never collide. */
  id: string;
  kind: TrackKind;
  /** BCP-47 as declared by the manifest / caller. */
  lang: string;
  /** Human label; falls back to a language-name lookup. */
  label: string;
  /** Native: index into hls.audioTracks. External: the media URL. */
  ref: number | string;
  default?: boolean;
  /** Codec hint when known (mp4a.40.2, ec-3, ...). */
  codec?: string;
  channels?: number;
}

/* ------------------------------------------------------------------ */
/* Language matching                                                   */
/* ------------------------------------------------------------------ */

const LANG_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', kn: 'Kannada',
  ml: 'Malayalam', bn: 'Bengali', mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi',
  ur: 'Urdu', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', tr: 'Turkish', id: 'Indonesian', th: 'Thai', vi: 'Vietnamese',
  und: 'Unknown', mul: 'Multiple',
};

export function languageLabel(lang: string, explicit?: string): string {
  if (explicit) return explicit;
  const primary = lang.split('-')[0].toLowerCase();
  const base = LANG_NAMES[primary];
  if (!base) return lang.toUpperCase();
  const region = lang.split('-')[1];
  return region ? `${base} (${region.toUpperCase()})` : base;
}

/**
 * Rank how well `candidate` satisfies `wanted`. Lower is better. -1 = no match.
 *   0 exact tag      hi-IN == hi-IN
 *   1 primary subtag hi    == hi-IN
 *   2 case/alias     en-GB == en-gb
 */
export function matchScore(wanted: string, candidate: string): number {
  const w = wanted.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (!w || !c || c === 'und') return -1;
  if (w === c) return 0;
  if (w.split('-')[0] === c.split('-')[0]) return 1;
  return -1;
}

export function pickTrack(
  tracks: AudioTrack[],
  wantedLang?: string | null,
  storedLang?: string | null,
): AudioTrack | null {
  if (!tracks.length) return null;
  for (const pref of [wantedLang, storedLang]) {
    if (!pref) continue;
    let best: AudioTrack | null = null;
    let bestScore = Infinity;
    for (const t of tracks) {
      const s = matchScore(pref, t.lang);
      if (s >= 0 && s < bestScore) {
        bestScore = s;
        best = t;
      }
    }
    if (best) return best;
  }
  return tracks.find((t) => t.default) ?? tracks[0];
}

/* ------------------------------------------------------------------ */
/* External-audio sync engine                                          */
/* ------------------------------------------------------------------ */

/** Above this drift we hard-seek the audio element; below it we nudge rate. */
const HARD_SEEK_THRESHOLD = 0.35;
const SOFT_DRIFT_THRESHOLD = 0.06;
const NUDGE = 0.04; // +/- playbackRate applied to audio to converge

export class ExternalAudioSync {
  private audio = new Audio();
  private attached: AudioTrack | null = null;
  private timer = 0;
  private video: HTMLVideoElement | null = null;

  constructor() {
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
  }

  /** The video element whose clock we follow. */
  bind(video: HTMLVideoElement): void {
    this.video = video;
    const sync = () => this.syncOnce();
    video.addEventListener('seeking', sync);
    video.addEventListener('seeked', sync);
    video.addEventListener('play', () => void this.audio.play().catch(() => {}));
    video.addEventListener('pause', () => this.audio.pause());
    video.addEventListener('ratechange', () => {
      this.audio.playbackRate = video.playbackRate;
    });
    video.addEventListener('volumechange', () => {
      this.audio.volume = video.volume;
      this.audio.muted = video.muted;
    });
    this.audio.volume = video.volume;
    this.audio.muted = video.muted;
    this.audio.playbackRate = video.playbackRate;
  }

  /**
   * Activate an external track. The video element is muted while an external
   * track owns the audio path so the two never fight.
   */
  async activate(track: AudioTrack): Promise<{ ok: boolean; error?: string }> {
    const url = String(track.ref);
    if (this.attached?.id === track.id) return { ok: true };

    const v = this.video;
    const t = v ? v.currentTime : 0;
    const wasPlaying = v ? !v.paused : false;

    this.audio.src = url;
    this.audio.currentTime = t;
    this.attached = track;
    if (v) v.muted = true;

    try {
      await this.audio.load();
      this.audio.currentTime = v ? v.currentTime : t;
      if (wasPlaying) await this.audio.play();
      this.startWatchdog();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Return audio duties to the video element. */
  deactivate(): void {
    this.stopWatchdog();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.attached = null;
    if (this.video) this.video.muted = false;
  }

  get activeTrack(): AudioTrack | null {
    return this.attached;
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    // 250ms is enough to catch drift without burning CPU or thrashing rate.
    this.timer = window.setInterval(() => this.syncOnce(), 250);
  }

  private stopWatchdog(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }

  private syncOnce(): void {
    const v = this.video;
    if (!v || !this.attached) return;
    if (v.paused) {
      if (!this.audio.paused) this.audio.pause();
      return;
    }
    if (this.audio.paused) void this.audio.play().catch(() => {});

    const drift = this.audio.currentTime - v.currentTime;
    if (Math.abs(drift) > HARD_SEEK_THRESHOLD) {
      this.audio.currentTime = v.currentTime;
      this.audio.playbackRate = v.playbackRate;
    } else if (Math.abs(drift) > SOFT_DRIFT_THRESHOLD) {
      // Converge smoothly instead of jumping: slightly faster/slower audio.
      const dir = drift > 0 ? -1 : 1;
      this.audio.playbackRate = Math.min(2, Math.max(0.5, v.playbackRate * (1 + dir * NUDGE)));
    } else if (this.audio.playbackRate !== v.playbackRate) {
      this.audio.playbackRate = v.playbackRate;
    }
  }

  destroy(): void {
    this.deactivate();
    this.audio.src = '';
  }
}

/* ------------------------------------------------------------------ */
/* Preference persistence                                              */
/* ------------------------------------------------------------------ */

const AUDIO_KEY = 'elfura:audio-lang:v1';

export function loadPreferredAudio(): string | null {
  try {
    return localStorage.getItem(AUDIO_KEY);
  } catch {
    return null;
  }
}

export function savePreferredAudio(lang: string): void {
  try {
    localStorage.setItem(AUDIO_KEY, lang);
  } catch {
    /* storage disabled — non-fatal */
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

/**
 * Merges native and external tracks into one de-duplicated, stably-sorted list.
 * Native tracks win on ties because they switch more cleanly.
 */
export function buildTrackList(input: {
  native?: { lang: string; label?: string; id: number; default?: boolean; codec?: string; channels?: number }[];
  external?: { lang: string; label?: string; url: string }[];
}): AudioTrack[] {
  const out: AudioTrack[] = [];

  for (const n of input.native ?? []) {
    out.push({
      id: `native:${n.id}`,
      kind: 'native',
      lang: (n.lang || 'und').toLowerCase(),
      label: languageLabel(n.lang || 'und', n.label),
      ref: n.id,
      default: n.default,
      codec: n.codec,
      channels: n.channels,
    });
  }

  for (const [i, x] of (input.external ?? []).entries()) {
    // Skip an external track if the manifest already carries that language natively.
    if (out.some((t) => t.kind === 'native' && matchScore(x.lang, t.lang) === 0)) continue;
    out.push({
      id: `external:${x.lang}:${i}`,
      kind: 'external',
      lang: (x.lang || 'und').toLowerCase(),
      label: languageLabel(x.lang, x.label),
      ref: x.url,
    });
  }

  // Defaults first, then alphabetical by label for a stable menu.
  return out.sort((a, b) => Number(!!b.default) - Number(!!a.default) || a.label.localeCompare(b.label));
}
