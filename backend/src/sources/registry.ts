/**
 * Elfura Backend — Modular Source Registry & Uniform Response Builder
 * ===================================================================
 * Orchestrates registered `SourceAdapter` modules concurrently with TMDB
 * metadata resolution, caches raw results in bounded RAM (zero disk writes),
 * strips all internal provider strings, and seals every URL into stateless
 * AES-256-GCM `/api/v1/stream?t=...` tickets.
 */

import crypto from 'node:crypto';
import type { BackendConfig } from '../config.js';
import { sealStreamTicket } from '../security.js';
import { fetchTmdbMetadata } from '../tmdb.js';
import { normalizeLang } from './lang.js';
import { createSource1Adapter } from './source1.js';
import { createSource2Adapter } from './source2.js';
import type {
  RawSourceResult,
  RawStreamCandidate,
  SkipSegments,
  SourceAdapter,
  SourceQuery,
  UniformPlaybackResponse,
  UniformStreamOption,
} from './types.js';

const MAX_ADAPTER_CACHE_ENTRIES = 256;
const ADAPTER_CACHE_TTL_MS = 4 * 60_000;

export class SourceRegistry {
  private readonly adapters: SourceAdapter[];
  private readonly cfg: BackendConfig;
  private readonly ramCache = new Map<string, { expiresAt: number; result: RawSourceResult }>();
  private readonly inFlight = new Map<string, Promise<RawSourceResult>>();

  constructor(cfg: BackendConfig) {
    this.cfg = cfg;
    // Plug-and-play SourceAdapter registry (Part 1 requires zero changes when adding sources).
    this.adapters = [
      createSource1Adapter(cfg.source1),
      createSource2Adapter(cfg.source2),
    ];
  }

  listPublicSources(): { id: string; label: string }[] {
    return this.adapters.filter((a) => a.enabled()).map((a) => ({ id: a.id, label: a.label }));
  }

  private getCachedAdapterResult(key: string): RawSourceResult | null {
    const entry = this.ramCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.ramCache.delete(key);
      return null;
    }
    this.ramCache.delete(key);
    this.ramCache.set(key, entry);
    return entry.result;
  }

  private setCachedAdapterResult(key: string, result: RawSourceResult): void {
    if (!result.candidates.length) return;
    if (this.ramCache.has(key)) this.ramCache.delete(key);
    while (this.ramCache.size >= MAX_ADAPTER_CACHE_ENTRIES) {
      const oldest = this.ramCache.keys().next().value;
      if (oldest === undefined) break;
      this.ramCache.delete(oldest);
    }
    this.ramCache.set(key, {
      expiresAt: Date.now() + ADAPTER_CACHE_TTL_MS,
      result,
    });
  }

  private resolveAdapterWithCache(
    adapter: SourceAdapter,
    baseKey: string,
    query: SourceQuery,
  ): Promise<RawSourceResult> {
    const cached = this.getCachedAdapterResult(baseKey);
    if (cached) return Promise.resolve(cached);

    const existing = this.inFlight.get(baseKey);
    if (existing) return existing;

    const p = adapter
      .resolve({ ...query, preferredLang: undefined })
      .then((res) => {
        this.setCachedAdapterResult(baseKey, res);
        return res;
      })
      .finally(() => {
        this.inFlight.delete(baseKey);
      });

    this.inFlight.set(baseKey, p);
    return p;
  }

  async resolvePlayback(params: {
    type: 'movie' | 'tv';
    tmdbId: string;
    season?: number;
    episode?: number;
    sourceId?: string;
    preferredLang?: string;
    streamPathPrefix?: string;
  }): Promise<UniformPlaybackResponse | null> {
    const activeAdapters = this.adapters.filter(
      (a) => a.enabled() && (!params.sourceId || a.id === params.sourceId),
    );
    if (!activeAdapters.length) return null;

    const streamBase = params.streamPathPrefix || '/api/v1/stream';

    // Launch TMDB metadata AND all source adapters concurrently (zero serial wait!)
    const mediaPromise = fetchTmdbMetadata(this.cfg.tmdb, {
      type: params.type,
      tmdbId: params.tmdbId,
      season: params.season,
      episode: params.episode,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.resolveTimeoutMs);

    const query: SourceQuery = {
      type: params.type,
      tmdbId: params.tmdbId,
      season: params.season,
      episode: params.episode,
      preferredLang: params.preferredLang,
      resolveMetaFallback: () => mediaPromise,
      signal: controller.signal,
    };

    let settled: PromiseSettledResult<{
      adapter: SourceAdapter;
      result: RawSourceResult;
    }>[];

    try {
      settled = await Promise.allSettled(
        activeAdapters.map(async (adapter) => {
          const cacheKey = `${adapter.id}:${params.type}:${params.tmdbId}:${params.season ?? 0}:${params.episode ?? 0}`;
          return {
            adapter,
            result: await this.resolveAdapterWithCache(adapter, cacheKey, query),
          };
        }),
      );
    } finally {
      clearTimeout(timer);
    }

    const media = await mediaPromise;

    const uniformOptions: UniformStreamOption[] = [];
    let mergedSegments: SkipSegments | undefined;

    for (const entry of settled) {
      if (entry.status !== 'fulfilled') continue;
      const { adapter, result } = entry.value;

      if (!mergedSegments && result.segments) {
        mergedSegments = result.segments;
      }
      if (!media.title && result.metaHint?.title) {
        media.title =
          params.type === 'tv' && params.season && params.episode
            ? `${result.metaHint.title} · S${params.season}E${params.episode}`
            : result.metaHint.title;
      }
      if (!media.year && result.metaHint?.year) media.year = result.metaHint.year;
      if (!media.imdbId && result.metaHint?.imdbId) media.imdbId = result.metaHint.imdbId;

      const labelCounts = new Map<string, number>();
      let optionSeq = 0;

      for (const cand of result.candidates) {
        const sealed = this.sealCandidate(adapter, cand, ++optionSeq, labelCounts, streamBase);
        uniformOptions.push(sealed);

        // If candidate includes a distinct standby backup URL, expose as automatic failover slot
        if (cand.standbyUrl && cand.standbyUrl !== cand.url) {
          const backupCand: RawStreamCandidate = {
            ...cand,
            key: `${cand.key}#standby`,
            fingerprint: `${cand.fingerprint || cand.key}#standby`,
            url: cand.standbyUrl,
            headers: cand.standbyHeaders ?? cand.headers,
            standbyUrl: undefined,
          };
          uniformOptions.push(this.sealCandidate(adapter, backupCand, ++optionSeq, labelCounts, streamBase));
        }
      }
    }

    if (!uniformOptions.length) return null;

    // When a preferred audio language is requested, promote matching streams
    // across all active adapters ordered by match quality + edge latency hint.
    if (params.preferredLang) {
      const prefCode = normalizeLang(params.preferredLang).code;
      if (prefCode && prefCode !== 'und') {
        const prefPrimary = prefCode.split('-')[0];
        const scoreOpt = (opt: UniformStreamOption): number => {
          if (opt.audioLang === prefCode || opt.availableAudioLangs?.includes(prefCode)) return 0;
          if (
            opt.audioLang?.split('-')[0] === prefPrimary ||
            opt.availableAudioLangs?.some((l) => l.split('-')[0] === prefPrimary)
          ) {
            return 1;
          }
          if (opt.multiAudio && !opt.availableAudioLangs?.length) return 2;
          return 3;
        };
        uniformOptions.sort(
          (a, b) =>
            scoreOpt(a) - scoreOpt(b) ||
            (a.latencyHintMs ?? 999) - (b.latencyHintMs ?? 999),
        );
      }
    }

    return {
      ok: true,
      media,
      primary: uniformOptions[0],
      sources: uniformOptions,
      ...(mergedSegments ? { segments: mergedSegments } : {}),
    };
  }

  private sealCandidate(
    adapter: SourceAdapter,
    cand: RawStreamCandidate,
    seq: number,
    labelCounts: Map<string, number>,
    streamBase: string,
  ): UniformStreamOption {
    // Build strictly anonymized display label using ONLY adapter.label + audio/quality traits
    let trait = '';
    if (cand.multiAudio) {
      trait = 'Multi-Audio';
    } else if (cand.audioLabel && cand.audioLabel !== 'Original') {
      trait = cand.audioLabel;
    } else if (cand.quality && cand.quality !== 'auto') {
      trait = cand.quality.toUpperCase();
    }

    const baseLabel = trait ? `${adapter.label} · ${trait}` : adapter.label;
    const count = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, count);
    const displayLabel = count === 1 ? baseLabel : `${baseLabel} #${count}`;

    const opaqueFingerprint = crypto
      .createHmac('sha256', this.cfg.secret)
      .update(cand.fingerprint || cand.url)
      .digest('hex')
      .slice(0, 12);

    const streamTicket = sealStreamTicket(this.cfg.secret, {
      u: cand.url,
      ...(cand.headers && Object.keys(cand.headers).length ? { h: cand.headers } : {}),
      k: cand.type === 'mp4' ? 'a' : 'm',
    });

    const audioTracks = (cand.audioTracks ?? []).map((t) => ({
      lang: t.lang,
      label: t.label,
      url: `${streamBase}?t=${encodeURIComponent(
        sealStreamTicket(this.cfg.secret, {
          u: t.url,
          ...(t.headers && Object.keys(t.headers).length ? { h: t.headers } : {}),
          k: 'a',
        }),
      )}`,
    }));

    const subtitles = (cand.subtitles ?? []).map((s) => ({
      lang: s.lang,
      label: s.label,
      url: `${streamBase}?t=${encodeURIComponent(
        sealStreamTicket(this.cfg.secret, {
          u: s.url,
          ...(s.headers && Object.keys(s.headers).length ? { h: s.headers } : {}),
          k: 's',
        }),
      )}`,
    }));

    const latencyHintMs =
      typeof cand.latencyMs === 'number' && Number.isFinite(cand.latencyMs) && cand.latencyMs > 0
        ? Math.round(cand.latencyMs)
        : undefined;

    return {
      id: `${adapter.id}:${seq}`,
      sourceId: adapter.id,
      label: displayLabel,
      type: cand.type,
      url: `${streamBase}?t=${encodeURIComponent(streamTicket)}`,
      quality: cand.quality || 'auto',
      fingerprint: opaqueFingerprint,
      ...(latencyHintMs !== undefined ? { latencyHintMs } : {}),
      ...(cand.audioLang ? { audioLang: cand.audioLang } : {}),
      ...(cand.availableAudioLangs?.length ? { availableAudioLangs: cand.availableAudioLangs } : {}),
      ...(cand.multiAudio ? { multiAudio: true } : {}),
      audioTracks,
      subtitles,
    };
  }
}
