/**
 * Elfura Player — Dynamic Audio Track Layer
 * =========================================
 * Zero hardcoded audio tracks, zero hardcoded language dictionaries.
 *
 * Audio tracks are discovered strictly at runtime from:
 *  A) NATIVE tracks — parsed from the active HLS/DASH manifest (`#EXT-X-MEDIA`
 *     or `<AdaptationSet contentType="audio">`). Switching is instant in-band.
 *  B) EXTERNAL tracks — sidecar audio files attached to the active stream.
 *  C) SOURCE tracks — additional audio languages dynamically reported across
 *     the resolved raw stream candidates for this specific title. Selecting
 *     one searches all raw sources carrying that language in rank order.
 *
 * Language canonicalization (ISO 639-1, ISO 639-2 3-letter codes like `hin`,
 * `jpn`, `kan`, `tam`, `tel`, and BCP-47 tags like `es-419`, `pt-BR`) uses the
 * platform's built-in `Intl.Locale` and `Intl.DisplayNames` APIs.
 */

export type TrackKind = 'native' | 'external' | 'source';

export interface AudioTrack {
  /** Stable id for the API. Prefixed by kind so ids never collide. */
  id: string;
  kind: TrackKind;
  /** Canonical BCP-47 tag (e.g. 'hi', 'en', 'ja', 'es-419', 'und'). */
  lang: string;
  /** Human label derived dynamically from Intl.DisplayNames or manifest metadata. */
  label: string;
  /** Native: index into hls.audioTracks. External: media URL. Source: canonical lang tag. */
  ref: number | string;
  default?: boolean;
  codec?: string;
  channels?: number;
}

/* ------------------------------------------------------------------ */
/* Runtime BCP-47 / ISO 639-1 / ISO 639-2 canonicalization via Intl    */
/* ------------------------------------------------------------------ */

const displayDialect =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'language' })
    : null;

const displayStandard =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' })
    : null;

let reverseDisplayMap: Map<string, string> | null = null;
function lookupTagByEnglishName(lowerName: string): string | undefined {
  if (!displayDialect) return undefined;
  if (!reverseDisplayMap) {
    reverseDisplayMap = new Map<string, string>();
    const register = (tag: string) => {
      try {
        const loc = new Intl.Locale(tag);
        const canonical = loc.baseName.toLowerCase();
        for (const dn of [displayDialect, displayStandard]) {
          const rendered = dn?.of(loc.baseName);
          if (rendered && rendered.toLowerCase() !== canonical) {
            reverseDisplayMap!.set(rendered.toLowerCase(), canonical);
          }
        }
      } catch {
        /* ignore unassigned 2-letter combinations */
      }
    };
    for (let a = 97; a <= 122; a++) {
      for (let b = 97; b <= 122; b++) {
        register(String.fromCharCode(a, b));
      }
    }
    for (const regional of ['es-419', 'pt-BR', 'zh-Hans', 'zh-Hant', 'fil']) {
      register(regional);
    }
  }
  return reverseDisplayMap.get(lowerName);
}

const GENERIC_OR_WATERMARK_NAME_RE =
  /^(?:moviehub\w*|tg\s*(?:flix|vid|hub|kai|out)\w*|orion|vidrift|vidsync|castle|vidzee|audio|track\s*\d*|sound|stream|default|und|unknown)$/i;

export function canonLang(raw?: string | null): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return 'und';
  const lower = trimmed.toLowerCase();
  if (lower === 'original' || lower === 'default' || lower === 'und' || lower === 'unknown') {
    return 'und';
  }
  if (lower === 'mul' || lower === 'multi' || lower === 'multi-audio') {
    return 'mul';
  }

  const byEnglishName = lookupTagByEnglishName(lower);
  if (byEnglishName) return byEnglishName;

  const candidateTag = trimmed.replace(/_/g, '-');
  if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function' && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(candidateTag)) {
    try {
      const loc = new Intl.Locale(candidateTag);
      const base = loc.baseName.toLowerCase();
      if (!base || base === 'und') return 'und';
      // Guard against invalid 2-letter tags that Intl.DisplayNames cannot resolve
      if (displayDialect && loc.language.length === 2) {
        const check = displayDialect.of(loc.language);
        if (!check || check.toLowerCase() === loc.language) return 'und';
      }
      return base;
    } catch {
      /* fall through */
    }
  }
  return 'und';
}

export function languageLabel(lang: string, explicit?: string): string {
  const cleanExplicit = explicit?.trim();
  const canon = canonLang(lang || cleanExplicit);

  if (canon === 'mul') return 'Multi-Audio';

  if (canon !== 'und' && displayDialect) {
    try {
      const loc = new Intl.Locale(canon);
      const intlName = displayDialect.of(loc.baseName);
      if (intlName && intlName.toLowerCase() !== canon) {
        // Preserve helpful qualifiers like "(Forced)" or "(SDH)" from manifest NAME
        if (cleanExplicit && /\((?:forced|sdh|cc|commentary)\)/i.test(cleanExplicit)) {
          const qual = cleanExplicit.match(/\((?:forced|sdh|cc|commentary)\)/i)?.[0] ?? '';
          return `${intlName} ${qual}`.trim();
        }
        return intlName;
      }
    } catch {
      /* fall through */
    }
  }

  if (cleanExplicit && !GENERIC_OR_WATERMARK_NAME_RE.test(cleanExplicit)) {
    return cleanExplicit;
  }

  return canon !== 'und' ? canon.toUpperCase() : 'Original';
}

/**
 * Rank how well `candidate` satisfies `wanted`. Lower is better. -1 = no match.
 *   0 exact canonical tag  hi-in == hi-in  or  hi == hin
 *   1 primary subtag       hi    == hi-in
 */
export function matchScore(wanted: string, candidate: string): number {
  const w = canonLang(wanted);
  const c = canonLang(candidate);
  if (!w || !c) return -1;
  if (w === 'und' || c === 'und') return w === 'und' && c === 'und' ? 0 : -1;
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

const HARD_SEEK_THRESHOLD = 0.35;
const SOFT_DRIFT_THRESHOLD = 0.06;
const NUDGE = 0.04;

export class ExternalAudioSync {
  private audio = new Audio();
  private attached: AudioTrack | null = null;
  private timer = 0;
  private video: HTMLVideoElement | null = null;

  constructor() {
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
  }

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
/* Dynamic Track Registry                                              */
/* ------------------------------------------------------------------ */

/**
 * Dynamically merges:
 *  - native manifest tracks,
 *  - external sidecar tracks, and
 *  - additional languages dynamically discovered across resolved raw sources
 *    for this title (never hardcoded).
 */
export function buildTrackList(input: {
  native?: { lang: string; label?: string; id: number; default?: boolean; codec?: string; channels?: number }[];
  external?: { lang: string; label?: string; url: string }[];
  discoveredSourceLangs?: { lang: string; label?: string; active?: boolean }[];
}): AudioTrack[] {
  const out: AudioTrack[] = [];
  const labelCounts = new Map<string, number>();

  const uniqueLabel = (base: string): string => {
    const k = base.toLowerCase();
    const count = (labelCounts.get(k) ?? 0) + 1;
    labelCounts.set(k, count);
    return count > 1 ? `${base} #${count}` : base;
  };

  for (const n of input.native ?? []) {
    const cLang = canonLang(n.lang || n.label);
    out.push({
      id: `native:${n.id}`,
      kind: 'native',
      lang: cLang,
      label: uniqueLabel(languageLabel(cLang, n.label)),
      ref: n.id,
      default: n.default,
      codec: n.codec,
      channels: n.channels,
    });
  }

  for (const [i, x] of (input.external ?? []).entries()) {
    const cLang = canonLang(x.lang || x.label);
    if (out.some((t) => t.kind === 'native' && matchScore(cLang, t.lang) === 0)) continue;
    out.push({
      id: `external:${cLang}:${i}`,
      kind: 'external',
      lang: cLang,
      label: uniqueLabel(languageLabel(cLang, x.label)),
      ref: x.url,
    });
  }

  const discovered = input.discoveredSourceLangs ?? [];
  if (discovered.length > 0) {
    // If active stream is a single-audio dub whose single native track reported 'und'
    // ("Audio"), upgrade its lang/label to the active source's known dub language.
    const activeSourceEntry = discovered.find((d) => d.active);
    if (out.length === 1 && out[0].lang === 'und' && activeSourceEntry) {
      const activeLang = canonLang(activeSourceEntry.lang || activeSourceEntry.label);
      if (activeLang !== 'und') {
        out[0].lang = activeLang;
        out[0].label = languageLabel(activeLang, activeSourceEntry.label);
      }
      out[0].default = true;
    } else if (out.length === 0 && activeSourceEntry) {
      const activeLang = canonLang(activeSourceEntry.lang || activeSourceEntry.label);
      out.push({
        id: `source:${activeLang}`,
        kind: 'source',
        lang: activeLang,
        label: uniqueLabel(languageLabel(activeLang, activeSourceEntry.label)),
        ref: activeLang,
        default: true,
      });
    }

    for (const d of discovered) {
      const cLang = canonLang(d.lang || d.label);
      const alreadyCovered = out.some((t) =>
        cLang === 'und' ? t.lang === 'und' : matchScore(cLang, t.lang) === 0,
      );
      if (alreadyCovered) continue;
      out.push({
        id: `source:${cLang}`,
        kind: 'source',
        lang: cLang,
        label: uniqueLabel(languageLabel(cLang, d.label)),
        ref: cLang,
        default: !!d.active,
      });
    }
  }

  const kindRank = (k: TrackKind) => (k === 'native' ? 0 : k === 'external' ? 1 : 2);
  return out.sort(
    (a, b) =>
      Number(!!b.default) - Number(!!a.default) ||
      kindRank(a.kind) - kindRank(b.kind) ||
      a.label.localeCompare(b.label),
  );
}
