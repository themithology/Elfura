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
import { fetchOpenSubtitlesFallback } from '../subtitles.js';
import { fetchTmdbMetadata } from '../tmdb.js';
import { normalizeLang } from './lang.js';
import { cachedCandidateEvidence, cachedCandidateEvidenceAgeMs, diagnoseCandidatePlayback, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { createSource1Adapter, fetchFromVidBolt } from './source1.js';
import { createSource3Adapter } from './source3.js';
import { createSource4Adapter } from './source4.js';
import { createSource5Adapter } from './source5.js';
import { createSource7Adapter } from './source7.js';
import { createSource8Adapter } from './source8.js';
import { createSource9Adapter } from './source9.js';
import { createSource10Adapter } from './source10.js';
import { createSource11Adapter } from './source11.js';
import { createSource12Adapter } from './source12.js';
import { createSource13Adapter } from './source13.js';
import { createSource14Adapter } from './source14.js';
import { createSource15Adapter } from './source15.js';
import { createSource16Adapter } from './source16.js';
import { selectPlaybackCandidates, MAX_SINGLE_TRACK_FALLBACKS, MAX_SEPARATE_DUBS } from './selection.js';
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
  private readonly segmentCache = new Map<
    string,
    { expiresAt: number; result: SkipSegments | undefined }
  >();
  private readonly segmentInFlight = new Map<string, Promise<SkipSegments | undefined>>();

  constructor(cfg: BackendConfig) {
    this.cfg = cfg;
    // Plug-and-play SourceAdapter registry (Part 1 requires zero changes when adding sources).
    this.adapters = [
      // Source 1 contains direct upstreams independently identified in Aethoflix.
      // VidBolt/Orion is a direct upstream used by Aethoflix. No Aethoflix
      // or ZXC mirror requests are made by this group.
      {
        id: 'source-1', label: 'Source 1', enabled: () => cfg.source1.enabled,
        resolve: async (query) => {
          const start = Date.now();
          const candidates = await fetchFromVidBolt(cfg.source1.vidboltOrigin || 'https://vidbolt.xyz', query);
          query.diag?.push({ adapter: 'source-1', lane: 'D', ok: candidates.length > 0, ms: Date.now() - start, detail: `candidates=${candidates.length}` });
          return { candidates: candidates.map(c => query.diag ? { ...c, diagnosticLane: 'D' } : c) };
        },
      },
      createSource1Adapter(cfg.source1, 2, { includeVidBolt: false }),
      createSource3Adapter(cfg.source3),
      createSource4Adapter(() => cfg.source4?.enabled ?? process.env.ELFURA_BINGR_ENABLED !== '0'),
      createSource5Adapter(() => cfg.source5?.enabled ?? process.env.ELFURA_NXSHA_ENABLED !== '0'),
      createSource7Adapter(() => cfg.source7?.enabled ?? false),
      createSource8Adapter(() => cfg.source8?.enabled ?? false),
      createSource9Adapter(() => cfg.source9?.enabled ?? false),
      createSource10Adapter(() => cfg.source10?.enabled ?? false),
      createSource11Adapter(() => cfg.source11?.enabled ?? false),
      createSource12Adapter(() => cfg.source12?.enabled ?? false),
      createSource13Adapter(() => cfg.source13?.enabled ?? false),
      createSource14Adapter(() => cfg.source14?.enabled ?? false),
      createSource15Adapter(() => cfg.source15?.enabled ?? false),
      createSource16Adapter(() => cfg.source16?.enabled ?? process.env.ELFURA_ANIVEXA_ENABLED !== '0'),
    ];
  }

  listPublicSources(): { id: string; label: string }[] {
    return this.adapters.filter((a) => a.enabled()).map((a) => ({ id: a.id, label: a.label }));
  }

  /**
   * Operator diagnostics: resolve one title through every adapter WITHOUT the
   * response cache, reporting discovered candidates, manifest reachability,
   * and bounded media-segment probes. Contains no upstream URLs or headers.
   */
  async diagnosePlayback(params: {
    type: 'movie' | 'tv';
    tmdbId: string;
    season?: number;
    episode?: number;
    anilistId?: string;
    anilistEpisode?: number;
    preferredLang?: string;
  }) {
    const diag: import('./types.js').DiagEntry[] = [];
    const query: SourceQuery = {
      type: params.type,
      tmdbId: params.tmdbId,
      anilistId: params.anilistId,
      anilistEpisode: params.anilistEpisode,
      season: params.season,
      episode: params.episode,
      preferredLang: params.preferredLang,
      diag,
      resolveMetaFallback: () => fetchTmdbMetadata(this.cfg.tmdb, params),
      signal: AbortSignal.timeout(15_000),
    };
    const diagnosticCandidates = new Map<string, RawStreamCandidate[]>();
    const diagnosticRaw = new Map<string, RawStreamCandidate[]>();
    const adapters = await Promise.all(
      this.adapters
        .filter((a) => a.enabled())
        .map(async (adapter) => {
          const t0 = Date.now();
          try {
            const result = await adapter.resolve(query);
            const raw = result.candidates;
            diagnosticRaw.set(adapter.id, raw);
            const { candidates: verified, verifiedAliveCount } =
              await verifyAndFilterCandidatesDetailed(raw);
            diagnosticCandidates.set(adapter.id, verified);
            return {
              id: adapter.id,
              ms: Date.now() - t0,
              raw: raw.length,
              retained: verified.length,
              manifestReachable: verifiedAliveCount,
              manifestMultiAudio: verified.filter((c) => {
                const evidence = cachedCandidateEvidence(c);
                return !!evidence?.alive && new Set(evidence.discoveredAudioLangs ?? []).size > 1;
              }).length,
              // Raw claims and independently measured manifest evidence are
              // intentionally separate. Never return URLs, headers or tokens.
              options: raw.slice(0, 20).map((candidate) => {
                const evidence = cachedCandidateEvidence(candidate);
                return {
                  fingerprint: crypto.createHmac('sha256', this.cfg.secret)
                    .update(candidate.url).digest('hex').slice(0, 12),
                  type: candidate.type,
                  claimedAudio: candidate.claimedAudioLang ?? candidate.audioLang ?? null,
                  claimedMultiAudio: !!candidate.multiAudio,
                  manifestMultiAudio: !!evidence?.alive && new Set(evidence.discoveredAudioLangs ?? []).size > 1,
                  manifestStatus: evidence?.alive ? 'reachable' : evidence?.confirmedDead ? 'failed' : 'unknown',
                  claimedQuality: /^[a-z0-9 ._-]{1,32}$/i.test(candidate.quality) ? candidate.quality : 'unknown',
                  probe: evidence ? {
                    alive: evidence.alive,
                    confirmedDead: evidence.confirmedDead,
                    ms: evidence.rttMs ?? null,
                    cachedObservationAgeMs: cachedCandidateEvidenceAgeMs(candidate),
                    checkedLayer: candidate.type === 'mp4' ? 'mp4-range-response' : 'manifest-and-child-playlists',
                    mediaSegmentCheckedHere: false,
                    manifestKind: evidence.manifestKind ?? null,
                    audioRenditions: evidence.manifestAudioRenditions ?? null,
                    audioLanguages: evidence.discoveredAudioLangs ?? [],
                    videoVariants: evidence.manifestVideoVariants ?? null,
                    qualityHeights: evidence.qualityLadder ?? [],
                  } : null,
                };
              }),
              types: verified.reduce<Record<string, number>>((acc, c) => {
                acc[c.type] = (acc[c.type] ?? 0) + 1;
                return acc;
              }, {}),
              error: null as string | null,
            };
          } catch (err) {
            return {
              id: adapter.id,
              ms: Date.now() - t0,
              raw: 0,
              retained: 0,
              manifestReachable: 0,
              manifestMultiAudio: 0,
              types: {} as Record<string, number>,
              error: err instanceof Error ? err.name : 'error',
            };
          }
        }),
    );
    const entries = this.adapters.flatMap(adapter =>
      (diagnosticCandidates.get(adapter.id) ?? []).map(candidate => ({adapter,candidate})));
    const selectedEntries = selectPlaybackCandidates(entries, params.preferredLang);
    const selected = selectedEntries.map(({adapter,candidate}) => ({
      sourceId:adapter.id,
      fingerprint:crypto.createHmac('sha256',this.cfg.secret).update(candidate.url).digest('hex').slice(0,12),
      multiAudio:!!candidate.multiAudio,
      languages:candidate.availableAudioLangs ?? [],
      manifestReachable:!!cachedCandidateEvidence(candidate)?.alive,
    }));

    // Check the first stream the resolver would offer from each source, then
    // spend any remaining small budget on a Hindi-labeled alternate. This is
    // deliberately about real selected candidates, not arbitrary root domains.
    const samples: { adapter: SourceAdapter; candidate: RawStreamCandidate }[] = [];
    const seenUrls = new Set<string>();
    const addSample = (adapter: SourceAdapter, candidate?: RawStreamCandidate) => {
      if (!candidate || seenUrls.has(candidate.url) || samples.length >= 8) return;
      seenUrls.add(candidate.url);
      samples.push({ adapter, candidate });
    };
    for (const adapter of this.adapters) {
      addSample(adapter, selectedEntries.find(x => x.adapter.id === adapter.id)?.candidate);
    }
    for (const adapter of this.adapters) {
      const hindi = (diagnosticCandidates.get(adapter.id) ?? []).find(c => c.audioLang === 'hi');
      addSample(adapter, hindi);
    }
    const playbackChecks: Record<string, unknown>[] = [];
    for (let offset = 0; offset < samples.length; offset += 4) {
      const batch = await Promise.all(samples.slice(offset, offset + 4).map(async ({adapter,candidate}) => ({
        sourceId: adapter.id,
        fingerprint: crypto.createHmac('sha256', this.cfg.secret).update(candidate.url).digest('hex').slice(0,12),
        type: candidate.type,
        claimedAudio: candidate.claimedAudioLang ?? candidate.audioLang ?? null,
        check: await diagnoseCandidatePlayback(candidate, this.cfg.relayMode),
      })));
      playbackChecks.push(...batch);
    }
    const lanes = diag.map(entry => {
      const candidates = (diagnosticRaw.get(entry.adapter) ?? []).filter(c => c.diagnosticLane === entry.lane);
      const evidence = candidates.map(c => cachedCandidateEvidence(c));
      return { ...entry, candidateCount: candidates.length, manifestReachable: evidence.filter(e => e?.alive).length,
        manifestFailed: evidence.filter(e => e?.confirmedDead).length,
        manifestUnknown: evidence.filter(e => !e || (!e.alive && !e.confirmedDead)).length,
        manifestMultiAudio: evidence.filter(e => e?.alive && new Set(e.discoveredAudioLangs ?? []).size > 1).length };
    });
    return { adapters, lanes, selected, playbackChecks, policy: { maxSingleTrackFallbacks: MAX_SINGLE_TRACK_FALLBACKS, maxSeparateDubs: MAX_SEPARATE_DUBS, multiAudioRequiresManifestLanguages: 2, playbackChecksAreServerSide: true, browserPlaybackChecked: false, note: 'A range read confirms the backend can retrieve a small sample media segment. It does not prove browser playback; relay delivery is reported as planned, not exercised.' } };
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
      .resolve({ ...query, preferredLang: undefined, onLateResult: (result) => this.setCachedAdapterResult(baseKey, result) })
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

  private resolveSegmentsWithCache(
    adapter: SourceAdapter,
    baseKey: string,
    query: SourceQuery,
  ): Promise<SkipSegments | undefined> {
    if (!adapter.resolveSegments) return Promise.resolve(undefined);

    const cached = this.segmentCache.get(baseKey);
    if (cached) {
      if (Date.now() <= cached.expiresAt) {
        // Refresh LRU position even when the cached result is undefined.
        this.segmentCache.delete(baseKey);
        this.segmentCache.set(baseKey, cached);
        return Promise.resolve(cached.result);
      }
      this.segmentCache.delete(baseKey);
    }

    const existing = this.segmentInFlight.get(baseKey);
    if (existing) return existing;

    const resolveSegments = adapter.resolveSegments.bind(adapter);
    const p = resolveSegments({ ...query, preferredLang: undefined })
      .catch(() => undefined)
      .then((result) => {
        if (this.segmentCache.has(baseKey)) this.segmentCache.delete(baseKey);
        while (this.segmentCache.size >= MAX_ADAPTER_CACHE_ENTRIES) {
          const oldest = this.segmentCache.keys().next().value;
          if (oldest === undefined) break;
          this.segmentCache.delete(oldest);
        }
        this.segmentCache.set(baseKey, {
          expiresAt: Date.now() + ADAPTER_CACHE_TTL_MS,
          result,
        });
        return result;
      })
      .finally(() => {
        this.segmentInFlight.delete(baseKey);
      });

    this.segmentInFlight.set(baseKey, p);
    return p;
  }

  async resolvePlayback(params: {
    type: 'movie' | 'tv';
    tmdbId: string;
    season?: number;
    episode?: number;
    sourceId?: string;
    anilistId?: string;
    anilistEpisode?: number;
    preferredLang?: string;
    streamPathPrefix?: string;
  }): Promise<UniformPlaybackResponse | null> {
    const resolveStartedAt = Date.now();
    // One end-to-end budget, not additive provider + liveness + metadata waits.
    const deadline = resolveStartedAt + (params.anilistId ? 12_000 : 4800);
    const remaining = () => Math.max(0, deadline - Date.now());
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
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

    let readyMedia: Awaited<typeof mediaPromise> | undefined;
    void mediaPromise.then((m) => { readyMedia = m; }).catch(() => {});
    const subtitleState: { value: Awaited<ReturnType<typeof fetchOpenSubtitlesFallback>> | null } = { value: null };
    // Warm OpenSubtitles fallback concurrently as soon as TMDB resolves `imdbId`
    const earlyOpenSubsPromise = this.cfg.subtitles?.enabled
      ? mediaPromise
          .then((m) =>
            m.imdbId
              ? fetchOpenSubtitlesFallback(this.cfg.subtitles, {
                  type: params.type,
                  imdbId: m.imdbId,
                  season: params.season,
                  episode: params.episode,
                })
              : null,
          )
          .catch(() => null)
      : Promise.resolve(null);
    void earlyOpenSubsPromise.then((subs) => { subtitleState.value = subs; }).catch(() => {});

    const query: SourceQuery = {
      type: params.type,
      tmdbId: params.tmdbId,
      anilistId: params.anilistId,
      anilistEpisode: params.anilistEpisode,
      season: params.season,
      episode: params.episode,
      preferredLang: params.preferredLang,
      resolveMetaFallback: () => mediaPromise,
      signal: AbortSignal.timeout(this.cfg.resolveTimeoutMs),
    };

    // Launch all active adapters in parallel; if one adapter finishes quickly with candidates
    // while another is stuck in a multi-second upstream cold scan (>2.6s slower), proceed early
    // once fast candidates pass verification while letting the slower adapter warm `ramCache` in background!
    const slots: ({ adapter: SourceAdapter; result: RawSourceResult } | null)[] =
      activeAdapters.map(() => null);
    let doneCount = 0;
    let firstWithCandidatesDone = false;
    let earlyRelease: (() => void) | null = null;
    let lagTimer: ReturnType<typeof setTimeout> | null = null;

    const cacheKeys = activeAdapters.map(
      (adapter) =>
        `${adapter.id}:${params.type}:${params.tmdbId}:${params.anilistId ?? ''}:${params.anilistEpisode ?? 0}:${params.season ?? 0}:${params.episode ?? 0}`,
    );
    // Segment lookup is deliberately independent of the adapter race. A fast
    // Source 2 response must not discard Source 1's slower intro/outro metadata.
    const segmentResults: (SkipSegments | undefined)[] = activeAdapters.map(() => undefined);
    const segmentTasks = activeAdapters.map((adapter, idx) =>
      this.resolveSegmentsWithCache(adapter, cacheKeys[idx], query)
        .then((value) => { segmentResults[idx] = value; }).catch(() => {}),
    );

    const adapterTasks = activeAdapters.map(async (adapter, idx) => {
      const cacheKey = cacheKeys[idx];
      try {
        const result = await this.resolveAdapterWithCache(adapter, cacheKey, query);
        slots[idx] = { adapter, result };
        if (result.candidates.length > 0 && !firstWithCandidatesDone) {
          firstWithCandidatesDone = true;
          if (activeAdapters.length > 1 && doneCount + 1 < activeAdapters.length) {
            lagTimer = setTimeout(() => earlyRelease?.(), 450);
          }
        }
      } catch {
        /* adapter failed */
      } finally {
        doneCount++;
        if (doneCount >= activeAdapters.length) {
          earlyRelease?.();
        }
      }
    });

    await Promise.race([
      Promise.allSettled(adapterTasks),
      new Promise<void>((r) => {
        earlyRelease = r;
      }),
      wait(Math.min(3400, remaining())),
    ]);
    if (lagTimer) clearTimeout(lagTimer);

    const verifyCurrentSlots = async () => {
      const ready = slots.filter(
        (x): x is { adapter: SourceAdapter; result: RawSourceResult } => x !== null,
      );
      const tagged = ready.flatMap((entry, adapterIdx) =>
        entry.result.candidates.map((cand) => ({
          ...cand,
          key: `${adapterIdx}::${cand.key}`,
        })),
      );
      const { candidates: vFlat, verifiedAliveCount } =
        await verifyAndFilterCandidatesDetailed(tagged, AbortSignal.timeout(Math.max(1, Math.min(1300, remaining()))));
      const byIdx = new Map<number, RawStreamCandidate[]>();
      for (const vc of vFlat) {
        const sep = vc.key.indexOf('::');
        const aIdx = Number(vc.key.slice(0, sep));
        const origKey = vc.key.slice(sep + 2);
        const list = byIdx.get(aIdx) ?? [];
        list.push({ ...vc, key: origKey });
        byIdx.set(aIdx, list);
      }
      return {
        entries: ready.map((entry, idx) => ({
          adapter: entry.adapter,
          result: entry.result,
          liveCandidates: byIdx.get(idx) ?? [],
        })),
        totalLive: vFlat.length,
        verifiedLive: verifiedAliveCount,
        vFlat,
      };
    };

    let verifiedBatch = await verifyCurrentSlots();

    // An AniList lookup must not let Anivexa monopolize the startup window.
    // If no candidate has verified yet, give every outstanding adapter most of
    // the remaining budget; if playback is already verified, allow a short
    // grace period for the standard sources to join the response.
    if (params.anilistId && doneCount < activeAdapters.length && remaining() > 1500) {
      const waitBudget = verifiedBatch.verifiedLive > 0
        ? Math.min(3000, Math.max(0, remaining() - 1300))
        : Math.max(0, remaining() - 1300);
      await Promise.race([Promise.allSettled(adapterTasks), wait(waitBudget)]);
      verifiedBatch = await verifyCurrentSlots();
    } else if (doneCount < activeAdapters.length && verifiedBatch.verifiedLive === 0 && remaining() > 400) {
      await Promise.race([Promise.allSettled(adapterTasks), wait(Math.min(800, Math.max(0, remaining() - 300)))]);
      verifiedBatch = await verifyCurrentSlots();
    }

    // Metadata, skip markers and subtitles are enrichments; none may hold the
    // first playable stream hostage. Their requests continue warming caches.
    // A brief opportunistic window retains metadata and skip markers when
    // they're already close, without making their upstream timeout additive.
    if (remaining() > 0) await Promise.race([
      Promise.allSettled([mediaPromise, ...segmentTasks]),
      wait(Math.min(1200, remaining())),
    ]);
    const media = readyMedia ?? {
      type: params.type, tmdbId: params.tmdbId, imdbId: null,
      ...(params.type === 'tv' ? { season: params.season ?? 1, episode: params.episode ?? 1 } : {}),
      title: '', year: '', overview: '', poster: null, backdrop: null, logo: null,
    };
    const verifiedEntries = verifiedBatch.entries;

    const uniformOptions: UniformStreamOption[] = [];
    let mergedSegments: SkipSegments | undefined;
    for (const segments of segmentResults) if (!mergedSegments && segments) mergedSegments = segments;
    const candidateEntries: {adapter: SourceAdapter; candidate: RawStreamCandidate}[] = [];
    for (const { adapter, result, liveCandidates } of verifiedEntries) {
      if (!mergedSegments && result.segments) mergedSegments = result.segments;
      if (!media.title && result.metaHint?.title) {
        media.title = params.type === 'tv' && params.season && params.episode
          ? `${result.metaHint.title} · S${params.season}E${params.episode}` : result.metaHint.title;
      }
      if (!media.year && result.metaHint?.year) media.year = result.metaHint.year;
      if (!media.imdbId && result.metaHint?.imdbId) media.imdbId = result.metaHint.imdbId;
      for (const cand of liveCandidates) {
        candidateEntries.push({adapter,candidate:cand});
        if (cand.standbyUrl && cachedCandidateEvidence({ ...cand, url:cand.standbyUrl, headers:cand.standbyHeaders ?? cand.headers })?.alive) {
          candidateEntries.push({adapter,candidate:{...cand,key:`${cand.key}#standby`,fingerprint:`${cand.fingerprint || cand.key}#standby`,url:cand.standbyUrl,headers:cand.standbyHeaders ?? cand.headers,standbyUrl:undefined,standbyHeaders:undefined}});
        }
      }
    }
    const counts = new Map<string, Map<string, number>>();
    const sequences = new Map<string, number>();
    for (const {adapter,candidate} of selectPlaybackCandidates(candidateEntries, params.preferredLang)) {
      if (!counts.has(adapter.id)) counts.set(adapter.id, new Map());
      const seq = (sequences.get(adapter.id) ?? 0) + 1;
      sequences.set(adapter.id,seq);
      uniformOptions.push(this.sealCandidate(adapter,candidate,seq,counts.get(adapter.id)!,streamBase));
    }

    if (!uniformOptions.length) {
      // Operator-only diagnostics (server console; never sent to clients).
      const detail = verifiedEntries
        .map(
          (e) =>
            `${e.adapter.id}: raw=${e.result.candidates.length} verified=${e.liveCandidates.length}`,
        )
        .join(' ');
      console.warn(
        `[elfura-resolve] NO STREAMS type=${params.type} tmdb=${params.tmdbId} s=${params.season ?? '-'} e=${params.episode ?? '-'} :: ${detail}`,
      );
      return null;
    }

    // Only OpenSubtitles tracks are exposed. No provider subtitle fallback.
    const shouldResolveOpenSubtitles = Boolean(media.imdbId) && Boolean(this.cfg.subtitles?.enabled);

    if (shouldResolveOpenSubtitles && media.imdbId) {
      // Never issue a serial second request or wait beyond the startup budget.
      if (!subtitleState.value && remaining() > 0) await Promise.race([earlyOpenSubsPromise, wait(Math.min(100, remaining()))]);
      const rawFallbackSubs = subtitleState.value ?? [];

      if (rawFallbackSubs.length > 0) {
        const sealedFallbackSubs = rawFallbackSubs.map((s) => ({
          lang: s.lang,
          label: s.label,
          ...(s.format ? { format: s.format } : {}),
          url: `${streamBase}?t=${encodeURIComponent(
            sealStreamTicket(this.cfg.secret, {
              u: s.url,
              ...(s.headers && Object.keys(s.headers).length ? { h: s.headers } : {}),
              k: 's',
            }),
          )}`,
        }));

        for (const opt of uniformOptions) {
          opt.subtitles = [...sealedFallbackSubs];
        }
      }
    }

    // Hierarchy: genuine multi-audio streams (several languages muxed in one
    // manifest) lead, then multi-quality ABR streams (a real rendition
    // ladder), then known single-quality streams, and only then streams
    // whose quality is unknown. Stable within each tier.
    const qualityTierOf = (o: UniformStreamOption): number => {
      const n = o.qualityLadder?.length ?? o.qualityOptions ?? 0;
      if (n > 1) return 0;
      if (n === 1 || (o.quality && o.quality !== 'auto')) return 1;
      return 2;
    };
    const animeVariantTier = (o: UniformStreamOption, language?: string): number => {
      if (!o.audioVariant) return 2;
      const primary = language ? normalizeLang(language).code.split('-')[0] : '';
      const preferred = primary === 'en' ? 'dub' : 'sub';
      return o.audioVariant === preferred ? 0 : 1;
    };
    if (!params.preferredLang) {
      uniformOptions.sort(
        (a, b) =>
          Number(!!params.anilistId && b.sourceId === 'source-16') - Number(!!params.anilistId && a.sourceId === 'source-16') ||
          Number(!!b.multiAudio) - Number(!!a.multiAudio) ||
          qualityTierOf(a) - qualityTierOf(b) ||
          animeVariantTier(a) - animeVariantTier(b),
      );
    }

    // When a preferred audio language is requested, promote matching streams
    // across ALL active adapters ordered dynamically by real server speed —
    // explicitly treating Multi-Audio streams that carry `prefCode` as top-tier
    // citizens alongside direct dubs (with a -65ms ABR CDN bonus over slow single-dub re-encodes).
    if (params.preferredLang) {
      const prefCode = normalizeLang(params.preferredLang).code;
      if (prefCode && prefCode !== 'und') {
        const prefPrimary = prefCode.split('-')[0];
        const scoreOpt = (opt: UniformStreamOption): number => {
          const exactDirect = opt.audioLang === prefCode;
          const exactMulti = !!opt.availableAudioLangs?.includes(prefCode);
          const subtagDirect = opt.audioLang?.split('-')[0] === prefPrimary;
          const subtagMulti = !!opt.availableAudioLangs?.some((l) => l.split('-')[0] === prefPrimary);
          if (exactDirect || exactMulti || subtagDirect || subtagMulti) return 0;
          if (opt.multiAudio && !opt.availableAudioLangs?.length) return 1;
          return 2;
        };
        const effectiveSpeedMs = (opt: UniformStreamOption): number => {
          const base = opt.latencyHintMs ?? 550;
          return opt.multiAudio ? base - 65 : base;
        };
        uniformOptions.sort(
          (a, b) =>
            Number(!!params.anilistId && b.sourceId === 'source-16') - Number(!!params.anilistId && a.sourceId === 'source-16') ||
            scoreOpt(a) - scoreOpt(b) ||
            animeVariantTier(a, prefCode) - animeVariantTier(b, prefCode) ||
            qualityTierOf(a) - qualityTierOf(b) ||
            effectiveSpeedMs(a) - effectiveSpeedMs(b),
        );
      }
    }

    const resolveMs = Date.now() - resolveStartedAt;
    if (resolveMs > 8000) {
      console.warn(
        `[elfura-resolve] SLOW ${resolveMs}ms type=${params.type} tmdb=${params.tmdbId} options=${uniformOptions.length}`,
      );
    }

    return {
      ok: true,
      media,
      primary: uniformOptions[0],
      sources: uniformOptions,
      sourceGroups: activeAdapters.map(adapter => adapter.id),
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

    const singleDubHint =
      !cand.multiAudio && cand.audioLang && cand.audioLang !== 'und' ? cand.audioLang : undefined;

    const streamTicket = sealStreamTicket(this.cfg.secret, {
      u: cand.url,
      ...(cand.headers && Object.keys(cand.headers).length ? { h: cand.headers } : {}),
      k: cand.type === 'mp4' ? 'a' : 'm',
      ...(singleDubHint ? { l: singleDubHint } : {}),
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
      ...(cand.qualityLabelsUnreliable ? { qualityLabelsUnreliable: true } : {}),
      ...(cand.qualityLadder?.length ? { qualityLadder: cand.qualityLadder } : {}),
      ...((cand.qualityOptions ?? cand.qualityLadder?.length) !== undefined
        ? { qualityOptions: cand.qualityOptions ?? cand.qualityLadder?.length }
        : {}),
      fingerprint: opaqueFingerprint,
      ...(latencyHintMs !== undefined ? { latencyHintMs } : {}),
      ...(cand.audioLang ? { audioLang: cand.audioLang } : {}),
      ...(cand.audioVariant ? { audioVariant: cand.audioVariant } : {}),
      ...(cand.availableAudioLangs?.length ? { availableAudioLangs: cand.availableAudioLangs } : {}),
      ...(cand.multiAudio ? { multiAudio: true } : {}),
      audioTracks,
      subtitles: [],
    };
  }
}
