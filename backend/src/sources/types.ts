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

export interface SourceQuery {
  type: 'movie' | 'tv';
  tmdbId: string;
  imdbId?: string | null;
  title?: string;
  year?: string;
  season?: number;
  episode?: number;
  preferredLang?: string;
  /** Lazy metadata resolver so adapters never block waiting on TMDB unless needed for fallback. */
  resolveMetaFallback?: () => Promise<{
    title?: string;
    year?: string;
    imdbId?: string | null;
  }>;
  signal?: AbortSignal;
}

export interface RawTrackRef {
  lang: string;
  label: string;
  url: string;
  headers?: Record<string, string>;
}

export interface RawStreamCandidate {
  /** Internal key for deduplication only (never sent to client). */
  key: string;
  /** Internal canonical stream identity (hashed into an opaque digest at the registry boundary). */
  fingerprint?: string;
  /** Upstream-reported or adapter-measured edge latency in milliseconds. */
  latencyMs?: number;
  type: 'hls' | 'dash' | 'mp4';
  url: string;
  headers?: Record<string, string>;
  quality: string;
  /** Primary BCP-47 language if single-dub stream (e.g. 'hi', 'en'). */
  audioLang?: string;
  audioLabel?: string;
  /** Dynamically discovered BCP-47 language codes carried inside a multi-audio stream. */
  availableAudioLangs?: string[];
  /** True when the manifest itself carries multiple muxed audio tracks. */
  multiAudio?: boolean;
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

export interface SourceAdapter {
  /** Public canonical source id, e.g. 'source-1'. */
  readonly id: string;
  /** Public branded display name, e.g. 'Source 1'. */
  readonly label: string;
  enabled(): boolean;
  resolve(query: SourceQuery): Promise<RawSourceResult>;
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
  /** Uniform relay URL (`/api/v1/stream?t=...`) — never raw upstream URL */
  url: string;
  quality: string;
  /** Opaque 12-char HMAC digest identifying shared upstream streams without leaking URLs */
  fingerprint?: string;
  /** Optional edge latency hint in ms for initial candidate ordering */
  latencyHintMs?: number;
  audioLang?: string;
  availableAudioLangs?: string[];
  multiAudio?: boolean;
  audioTracks: { lang: string; label: string; url: string }[];
  subtitles: { lang: string; label: string; url: string }[];
}

export interface UniformPlaybackResponse {
  ok: true;
  media: MediaMetadata;
  primary: UniformStreamOption;
  sources: UniformStreamOption[];
  segments?: SkipSegments;
}
