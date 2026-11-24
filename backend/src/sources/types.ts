/**
 * Elfura Backend — Uniform Source Adapter & Response Contracts
 * ============================================================
 * Every upstream source is molded into `RawSourceResult` internally and then
 * sealed into `UniformPlaybackResponse` at the registry boundary.
 *
 * Strict Anonymity Rule (see RULES.md):
 *   - No upstream provider names or raw CDN URLs ever cross into
 *     `UniformPlaybackResponse`.
 */

import type { MediaMetadata } from '../tmdb.js';

/** Operator diagnostics entry collected during a single resolution (never sent to player clients). */
export interface DiagEntry {
  adapter: string;
  lane: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface SourceQuery {
  type: 'movie' | 'tv';
  tmdbId: string;
  anilistId?: string;
  anilistEpisode?: number;
  /** When present, adapters append lane-level diagnostics for /api/v1/diagnostics. */
  diag?: DiagEntry[];
  /** Warm the adapter cache with lanes that finish after a fast initial result. */
  onLateResult?: (result: RawSourceResult) => void;
  /**
   * Subtitle-only adapters (they produce no stream of their own) append their
   * tracks here; the registry attaches them to the streams it already found for
   * this title. A subtitle lane must never fabricate a video candidate to carry
   * them — that would rank as a playable stream.
   */
  extraSubtitles?: RawTrackRef[];
  imdbId?: string | null;
  title?: string;
  year?: string;
  releaseDate?: string;
  latestDate?: string;
  originalLanguage?: string;
  season?: number;
  episode?: number;
  preferredLang?: string;
  /** Lazy metadata resolver so adapters never block waiting on TMDB unless needed for fallback. */
  resolveMetaFallback?: () => Promise<{
    title?: string;
    rawTitle?: string;
    episodeName?: string;
    genres?: string[];
    year?: string;
    releaseDate?: string;
    latestDate?: string;
    originalLanguage?: string;
    imdbId?: string | null;
  }>;
  signal?: AbortSignal;
}

export interface RawTrackRef {
  lang: string;
  label: string;
  url: string;
  format?: 'vtt' | 'srt' | 'ass';
  default?: boolean;
  headers?: Record<string, string>;
}

export interface RawStreamCandidate {
  /** Internal key for deduplication only (never sent to client). */
  key: string;
  /** Internal canonical stream identity (hashed into an opaque digest at the registry boundary). */
  fingerprint?: string;
  /** Internal lane attribution, populated only during operator diagnostics. */
  diagnosticLane?: string;
  /** Upstream-reported or adapter-measured edge latency in milliseconds. */
  latencyMs?: number;
  /**
   * Whole-stream size in bytes, measured from a real segment (see
   * `LivenessProbeOutcome.measuredBytes`). Never a provider claim: the size
   * decides which stream a viewer gets when two carry the same language, so a
   * guess here would quietly prefer the wrong copy of the film.
   */
  measuredBytes?: number;
  /** Highest bitrate the manifest declares, for comparison with `measuredBytes`. */
  declaredBitrateBps?: number;
  /**
   * The runtime this title should have, in seconds, when an adapter or the
   * registry knows it from metadata. Only used to turn a declared bitrate into
   * an estimated size when no real measurement exists.
   */
  expectedRuntimeSec?: number;
  type: 'hls' | 'dash' | 'mp4';
  url: string;
  headers?: Record<string, string>;
  /** Restrict probe, relay and every HLS child to this exact HTTPS origin. */
  restrictedOrigin?: string;
  quality: string;
  /** Distinct rendition heights (desc) when the stream is a multi-quality ABR ladder. */
  qualityLadder?: number[];
  /** Number of quality options when known (1 = single fixed quality). */
  qualityOptions?: number;
  /** Manifest rendition heights are known to be unreliable; keep ABR but hide manual labels. */
  qualityLabelsUnreliable?: boolean;
  /** Primary BCP-47 language if single-dub stream, verified from manifest evidence. */
  audioLang?: string;
  /** Provider-declared language only; never use as verified audio or for language selection. */
  claimedAudioLang?: string;
  /** Probe bounded MP4 metadata for actual single-track audio language. */
  probeMp4Audio?: boolean;
  /** Provider-declared source mode, not a verified language/manifest track. */
  audioVariant?: 'sub' | 'dub';
  /** Provider-declared subtitle presentation, not independently verified. */
  animeSubtitleMode?: 'hard' | 'soft';
  audioLabel?: string;
  /** Dynamically discovered BCP-47 language codes carried inside a multi-audio stream. */
  availableAudioLangs?: string[];
  /** True when the manifest itself carries multiple muxed audio tracks. */
  multiAudio?: boolean;
  /**
   * Evidence measured during THIS request, carried with the candidate.
   *
   * The liveness cache holds cross-request observations so a title can be
   * ranked without re-probing it every time. With payload caching disabled
   * (small-RAM deployments) that cache is empty, and ranking still has to be
   * driven by the probe that this very request just ran — otherwise verified
   * multi-audio streams lose their promotion and fast lanes lose their
   * measured latency ordering. Carrying it here keeps correctness independent
   * of whether any cache is switched on.
   */
  measuredThisRequest?: {
    alive: boolean;
    /** Single verified audio language, when this request measured one. */
    audioLang?: string;
    rttMs?: number;
    discoveredAudioLangs?: string[];
    durationSec?: number;
    measuredBytes?: number;
    declaredBitrateBps?: number;
  };
  /** Direct non-manifest external audio files (m4a/mp3/aac) for ExternalAudioSync. */
  audioTracks?: RawTrackRef[];
  /** Subtitle files (VTT / SRT / ASS). */
  subtitles?: RawTrackRef[];
  /** Optional backup stream URL for this candidate. */
  standbyUrl?: string;
  standbyHeaders?: Record<string, string>;
  /** Lower rank = higher priority. */
  rank: number;
}

export interface SkipSegments {
  intro?: [number, number];
  outro?: [number, number];
  recap?: [number, number];
}

export interface RawSourceResult {
  candidates: RawStreamCandidate[];
  segments?: SkipSegments;
  metaHint?: {
    title?: string;
    year?: string;
    imdbId?: string | null;
  };
}

export type SourceTrait = 'aggregator' | 'animeEpisode' | 'hardSubtitle' | 'slowManifest' | 'hevcFirst';

export interface SourceAdapter {
  /** Public canonical source id, e.g. 'source-1'. */
  readonly id: string;
  /** Public branded display name, e.g. 'Source 1'. */
  readonly label: string;
  enabled(): boolean;
  /**
   * What this lane structurally is, for the few places that must treat lanes
   * differently. Declared once, next to the adapter, instead of every consumer
   * keeping its own list of provider ids — those lists are why adding a source
   * used to mean editing the player.
   *
   * `aggregator`   fronts several independent upstreams, so a manual selection
   *                should exhaust its own servers before switching groups.
   * `animeEpisode` serves TV anime episodes with its own subtitle tracks and is
   *                skipped for movies.
   * `hardSubtitle` ships burned-in subtitles for some candidates.
   * `slowManifest` needs the longer manifest/fragment budget.
   * `hevcFirst` may offer HEVC-only manifests; the player must inspect the
   *                manifest before attaching dash.js on devices without HEVC.
   */
  readonly traits?: readonly SourceTrait[];
  /**
   * How long this lane's own discovery may take before it is abandoned.
   *
   * Omit to share `resolveTimeoutMs` with everyone else. Set it only for a lane
   * that genuinely aggregates upstreams before it can answer, and justify the
   * number in a comment next to the value — a long timeout is a promise to make
   * every resolve wait, so it has to be earned.
   */
  readonly discoveryTimeoutMs?: number;
  resolve(query: SourceQuery): Promise<RawSourceResult>;
  /**
   * Resolve time-range metadata independently from stream racing. This keeps a
   * fast adapter from finalizing playback before another adapter's intro/outro
   * metadata has arrived.
   */
  resolveSegments?(query: SourceQuery): Promise<SkipSegments | undefined>;
}

/* ------------------------------------------------------------------ */
/* Uniform Client-Facing Response (Part 2 -> Part 1)                   */
/* ------------------------------------------------------------------ */

export interface UniformStreamOption {
  /** Unique option id, e.g. 'source-1:1' */
  id: string;
  /** Source adapter id, e.g. 'source-1' */
  sourceId: string;
  /** Clean branded label ONLY, e.g. 'Source 1 · Multi-Audio' or 'Source 1 · Hindi' */
  label: string;
  type: 'hls' | 'dash' | 'mp4';
  /** Uniform proxy URL (`/api/proxy?u=...`) — never a raw upstream URL */
  url: string;
  quality: string;
  /** Distinct rendition heights (desc) for multi-quality ABR streams. */
  qualityLadder?: number[];
  /** Number of quality options when known (>1 ranks above single/unknown). */
  qualityOptions?: number;
  qualityLabelsUnreliable?: boolean;
  /** Opaque 12-char HMAC digest identifying shared upstream streams without leaking URLs */
  fingerprint?: string;
  /** Confirmed anime priority lane with reachable manifest; not proof of full playback. */
  animePriority?: boolean;
  /** Anime lane not confirmed reachable by the liveness probe. */
  animeUnverified?: boolean;
  /** Optional edge latency hint in ms for initial candidate ordering */
  latencyHintMs?: number;
  /** Measured whole-stream size in bytes, when one could be measured. */
  measuredBytes?: number;
  /** Provider-declared peak bitrate in bits/second, when the manifest states one. */
  declaredBitrateBps?: number;
  audioLang?: string;
  /**
   * Structural traits of the lane that produced this option (see SourceTrait).
   * The player needs a few of these — an aggregator's manual selection must
   * exhaust its own servers first, a slow lane gets a longer budget, an
   * HEVC-first lane is inspected before dash.js attaches. Sending them once here
   * is what lets a new source be added without touching Part 1.
   */
  traits?: SourceTrait[];
  /** Provider-declared SUB/DUB source mode, never an asserted manifest language. */
  audioVariant?: 'sub' | 'dub';
  availableAudioLangs?: string[];
  multiAudio?: boolean;
  audioTracks: { lang: string; label: string; url: string }[];
  subtitles: { lang: string; label: string; url: string; format?: 'vtt' | 'srt' | 'ass' }[];
}

export interface UniformPlaybackResponse {
  ok: true;
  media: MediaMetadata;
  primary: UniformStreamOption;
  sources: UniformStreamOption[];
  /** Late snapshots include partial updates; clients may avoid per-source rediscovery storms. */
  waveUpdates?: boolean;
  /** Enabled generic source ids for asynchronous recovery, never provider details. */
  sourceGroups?: string[];
  /** Source ids that had not produced anything when this response was sealed. */
  pendingSources?: string[];
  segments?: SkipSegments;
  /**
   * What the streams in THIS response are actually made of, in bytes.
   *
   * `mean` is the average across every listed stream that could be measured,
   * `max` is the best one (which is also `primary` unless language ranked above
   * it). `measured`/`total` says how many lanes actually produced a number, so a
   * mean over one stream out of twenty is not read as an average. Streams that
   * could not be measured are excluded, never counted as zero.
   */
  size?: {
    meanBytes: number;
    maxBytes: number;
    measured: number;
    total: number;
    /** Which language the mean is over, when the caller asked for one. */
    lang?: string;
  };
}
