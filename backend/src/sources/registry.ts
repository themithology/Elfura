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
import { createSource17Adapter } from './source17.js';
import { createSource18Adapter } from './source18.js';
import { createSource19Adapter } from './source19.js';
import { createSource20Adapter } from './source20.js';
import { createSource21Adapter } from './source21.js';
import { durationFits, durationToleranceSec } from './duration.js';
import { installNetTap, summarizeNet, tapRequests, type NetRecord } from './net-tap.js';
import { selectPlaybackCandidates, MAX_LISTED_SOURCES, MAX_SEPARATE_DUBS } from './selection.js';
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

/** Extra time given to still-running adapters once the first source has candidates. */
const EARLY_GRACE_MS = 700;
/** No adapter may be cut before this point, however fast the first one was. */
const MIN_JOIN_MS = 1400;
/** Floor for a single verification probe window (ms), independent of the budget. */
const PROBE_MIN_WINDOW_MS = 1200;
/** One-off extension granted when nothing has verified at the end of the budget. */
const RESCUE_EXTENSION_MS = 700;
/** Wall-clock ceiling for a resolve that has not verified anything yet (ms). */
const RESCUE_CEILING_MS = 5200;
/** Upper bound for the adapter race when nothing has candidates yet. */
const ADAPTER_RACE_MS = 3600;
/** Window for a single-adapter recovery call (`?source=source-N`). */
const SINGLE_SOURCE_BUDGET_MS = 9000;
/** End-to-end budget for one playback resolve (operator tunable, 3 s floor). */
/** Diagnostics only: the environment variable that can switch each source off. */
const SOURCE_ENV_FLAGS: Record<string, string> = {
  'source-1': 'SOURCE1_ENABLED',
  'source-3': 'SOURCE3_ENABLED',
  'source-4': 'ELFURA_BINGR_ENABLED',
  'source-5': 'ELFURA_NXSHA_ENABLED',
  'source-7': 'ELFURA_SCREENSCAPE_ENABLED',
  'source-8': 'ELFURA_VIDZEE_ENABLED',
  'source-9': 'ELFURA_VIXSRC_ENABLED',
  'source-10': 'ELFURA_VIDNEST_ENABLED',
  'source-11': 'ELFURA_VAPLAYER_ENABLED',
  'source-12': 'ELFURA_VIDZEN_ENABLED',
  'source-13': 'ELFURA_XPASS_ENABLED',
  'source-14': 'ELFURA_RIVE_CITADEL_ENABLED',
  'source-15': 'ELFURA_MAPPLE_ENABLED',
  'source-16': 'ELFURA_ANIVEXA_ENABLED',
  'source-17': 'ELFURA_ANIVORTEX_ENABLED',
  'source-18': 'ELFURA_SUBDUB_ENABLED',
  'source-19': 'ELFURA_DESIDUB_ENABLED',
  'source-20': 'ELFURA_VIDORA_ENABLED',
  'source-21': 'ELFURA_WATCHOUT_ENABLED',
};


/** Anime lanes keep their own original language (Japanese); everything else
 * that ships a bare "Original"/"ORG" tag is Hindi, as verified on the live
 * catalogue. Overridable with ELFURA_ORIGINAL_LANG (e.g. 'ja', 'und'). */
const ANIME_SOURCES = new Set(['source-16', 'source-17']);
const ORIGINAL_AUDIO_TOKENS = /^(?:orig(?:inal)?|org|original\s+audio(?:\s+track)?|default)$/i;

export function retagOriginalAudio(
  adapter: SourceAdapter,
  candidate: RawStreamCandidate,
): RawStreamCandidate {
  if (ANIME_SOURCES.has(adapter.id)) return candidate;
  const target = (process.env.ELFURA_ORIGINAL_LANG ?? 'hi').trim().toLowerCase();
  if (!target || target === 'und') return candidate;
  const label = String(candidate.audioLabel ?? '').trim();
  if (!ORIGINAL_AUDIO_TOKENS.test(label)) return candidate;
  const resolved = normalizeLang(target);
  return {
    ...candidate,
    audioLang: resolved.code,
    audioLabel: resolved.label,
  };
}

const resolveBudgetMs = (): number => {
  const raw = Number(process.env.ELFURA_RESOLVE_BUDGET_MS || 4600);
  return Number.isFinite(raw) ? Math.max(3000, Math.min(20_000, raw)) : 4600;
};
/** Candidates probed in the shared verification batch, spread across sources. */
const VERIFY_BREADTH_TARGET = 36;
/** Lanes any single source may contribute to one response. Eight, not four: a
 * source that carries five language dubs should list five lanes, and the
 * response-wide caps still bound the total. */
const MAX_LANES_PER_SOURCE = 8;

/** Order a source's lanes so every distinct audio language gets a slot before
 * any second quality of the same language. Without this, a source that returns
 * one file per language spent its whole window on 480p copies of one dub and
 * the rest of its languages never reached the response. */
export function languageFirstOrder(candidates: RawStreamCandidate[]): RawStreamCandidate[] {
  const seen = new Set<string>();
  const firsts: RawStreamCandidate[] = [];
  const rest: RawStreamCandidate[] = [];
  const firstSeen = new Set<RawStreamCandidate>();
  for (const candidate of candidates) {
    const lang = candidate.audioLang ? normalizeLang(candidate.audioLang).code : '';
    if (!lang || lang === 'und') {
      firsts.push(candidate);
      firstSeen.add(candidate);
      continue;
    }
    if (seen.has(lang)) {
      rest.push(candidate);
      continue;
    }
    seen.add(lang);
    firsts.push(candidate);
    firstSeen.add(candidate);
  }
  return [...firsts, ...rest];
}

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
    // Record what each adapter actually talked to, so a resolve that yields
    // nothing can explain itself in the console.
    installNetTap();

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
      createSource17Adapter(() => cfg.source17?.enabled !== false),
      createSource18Adapter(() => cfg.source18?.enabled ?? process.env.ELFURA_SUBDUB_ENABLED !== '0'),
      createSource19Adapter(() => cfg.source19?.enabled ?? process.env.ELFURA_DESIDUB_ENABLED !== '0'),
      createSource20Adapter(() => cfg.source20?.enabled ?? process.env.ELFURA_VIDORA_ENABLED !== '0'),
      createSource21Adapter(() => cfg.source21?.enabled ?? process.env.ELFURA_WATCHOUT_ENABLED !== '0'),
    ];
  }

  /**
   * Which adapters are off, and which environment variable turned each one off.
   * A stale `.env` kept from an older install is the single most common reason a
   * source "disappears", so the answer belongs in the boot log.
   */
  describeSources(): { enabled: string[]; disabled: { id: string; flag: string }[] } {
    const enabled: string[] = [];
    const disabled: { id: string; flag: string }[] = [];
    for (const adapter of this.adapters) {
      if (adapter.enabled()) enabled.push(adapter.id);
      else disabled.push({ id: adapter.id, flag: SOURCE_ENV_FLAGS[adapter.id] ?? '(configured off)' });
    }
    return { enabled, disabled };
  }

  /**
   * Ask every enabled adapter for one title directly, with a fresh request log.
   * Used by the boot self-test and by operators diagnosing an empty list.
   */
  async selfTestAll(
    params: { type: 'movie' | 'tv'; tmdbId: string; season?: number; episode?: number },
  ): Promise<{ id: string; raw: number; ms: number; net: string }[]> {
    return Promise.all(
      this.adapters
        .filter((adapter) => adapter.enabled())
        .map(async (adapter) => {
          const started = Date.now();
          const query: SourceQuery = {
            type: params.type,
            tmdbId: params.tmdbId,
            season: params.season,
            episode: params.episode,
            signal: AbortSignal.timeout(this.cfg.resolveTimeoutMs),
          };
          try {
            const tapped = await tapRequests(() => adapter.resolve(query));
            return {
              id: adapter.id,
              raw: tapped.value.candidates.length,
              ms: Date.now() - started,
              net: summarizeNet(tapped.net),
            };
          } catch (err) {
            return {
              id: adapter.id,
              raw: 0,
              ms: Date.now() - started,
              net: `threw ${err instanceof Error ? err.name : 'Error'}`,
            };
          }
        }),
    );
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
    return { adapters, lanes, selected, playbackChecks, policy: { maxListedSources: MAX_LISTED_SOURCES, maxSeparateDubs: MAX_SEPARATE_DUBS, multiAudioRequiresManifestLanguages: 2, playbackChecksAreServerSide: true, browserPlaybackChecked: false, note: 'A range read confirms the backend can retrieve a small sample media segment. It does not prove browser playback; relay delivery is reported as planned, not exercised.' } };
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
    /**
     * "Late join" pass: only sources whose discovery already finished (their
     * result is in the RAM cache) are reported. Nothing is started and nothing
     * is waited for, so a client can call this a second time and merge whatever
     * arrived after the first response.
     */
    late?: boolean;
  }): Promise<UniformPlaybackResponse | null> {
    const resolveStartedAt = Date.now();
    // One end-to-end budget, not additive provider + liveness + metadata waits.
    const lateOnly = params.late === true;
    // A recovery call for one adapter is not first paint: nothing is waiting on
    // it, and its only job is completeness. Cutting it at the shared 3.6 s race
    // meant slow-but-working adapters (a 2.6 s catalogue fetch plus a lane fetch)
    // never appeared in the list at all.
    const singleSource = typeof params.sourceId === 'string' && params.sourceId.length > 0;
    const deadline =
      resolveStartedAt +
      (lateOnly ? 2_200 : params.anilistId ? 12_000 : singleSource ? SINGLE_SOURCE_BUDGET_MS : resolveBudgetMs());
    // Fairness window for the adapter race (see EARLY_GRACE_MS / MIN_JOIN_MS).
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

    // Per-adapter outcome, kept for the "nothing resolved" report: with ten
    // sources, "which one failed and why" must be readable from the log.
    const adapterReport = new Map<string, { ms: number; raw?: number; error?: string }>();
    const adapterNet = new Map<string, NetRecord[]>();
    if (lateOnly) {
      activeAdapters.forEach((adapter, idx) => {
        const cached = this.getCachedAdapterResult(cacheKeys[idx]);
        if (cached) slots[idx] = { adapter, result: cached };
      });
    }
    const adapterTasks = lateOnly ? [] : activeAdapters.map(async (adapter, idx) => {
      const cacheKey = cacheKeys[idx];
      const startedAt = Date.now();
      try {
        const tapped = await tapRequests(() => this.resolveAdapterWithCache(adapter, cacheKey, query));
        const result = tapped.value;
        adapterNet.set(adapter.id, tapped.net);
        slots[idx] = { adapter, result };
        adapterReport.set(adapter.id, { ms: Date.now() - startedAt, raw: result.candidates.length });
        if (!result.candidates.length) {
          console.warn(
            `[elfura-sources] ${adapter.id} ${params.type}/${params.tmdbId}: 0 candidates in ` +
              `${Date.now() - startedAt}ms :: ${summarizeNet(tapped.net)}`,
          );
        }
        if (result.candidates.length > 0 && !firstWithCandidatesDone) {
          firstWithCandidatesDone = true;
          if (activeAdapters.length > 1 && doneCount + 1 < activeAdapters.length) {
            // Never let the fastest source decide the window for everyone else:
            // wait out a minimum join period, then a short grace, so a source
            // that needs ~2 s is not cut because another answered in 700 ms.
            const elapsed = Date.now() - resolveStartedAt;
            const grace = Math.max(EARLY_GRACE_MS, MIN_JOIN_MS - elapsed);
            lagTimer = setTimeout(() => earlyRelease?.(), grace);
          }
        }
      } catch (err) {
        adapterReport.set(adapter.id, {
          ms: Date.now() - startedAt,
          error: err instanceof Error ? err.name : 'Error',
        });
      } finally {
        doneCount++;
        if (doneCount >= activeAdapters.length) {
          earlyRelease?.();
        }
      }
    });

    if (!lateOnly) {
      await Promise.race([
        Promise.allSettled(adapterTasks),
        new Promise<void>((r) => {
          earlyRelease = r;
        }),
        wait(singleSource ? remaining() : Math.min(ADAPTER_RACE_MS, remaining())),
      ]);
    }
    if (lagTimer) clearTimeout(lagTimer);

    const verifyCurrentSlots = async (probeFloorMs = PROBE_MIN_WINDOW_MS) => {
      const ready = slots.filter(
        (x): x is { adapter: SourceAdapter; result: RawSourceResult } => x !== null,
      );
      // Breadth first: probe each adapter's best lanes before any adapter's
      // leftovers. A single source with 20 candidates must not starve every
      // other source out of the shared verification budget.
      const perAdapter = ready.map((entry) => languageFirstOrder(entry.result.candidates));
      const breadth = Math.max(2, Math.floor(VERIFY_BREADTH_TARGET / Math.max(1, perAdapter.length)));
      const tagged: RawStreamCandidate[] = [];
      for (let i = 0; i < breadth; i += 1) {
        for (let adapterIdx = 0; adapterIdx < perAdapter.length; adapterIdx += 1) {
          const cand = perAdapter[adapterIdx][i];
          if (cand) tagged.push({ ...cand, key: `${adapterIdx}::${cand.key}` });
        }
      }
      const { candidates: vFlat, verifiedAliveCount } =
        await verifyAndFilterCandidatesDetailed(
          tagged,
          // The probe decides whether a title is playable at all, so it gets a
          // real floor even when the response budget is nearly spent. Collapsing
          // this to a few milliseconds turned short budgets into empty lists.
          AbortSignal.timeout(
            Math.max(
              lateOnly ? 900 : probeFloorMs,
              Math.min(lateOnly ? 1_300 : 2_000, remaining()),
            ),
          ),
        );
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

    // A short source list is worse than a slightly slower start: when fewer than
    // three sources have produced candidates, keep listening for the adapters
    // that are still working instead of shipping what happened to arrive first.
    const readySources = () =>
      slots.filter((slot) => slot !== null && slot.result.candidates.length > 0).length;
    const stillPending = lateOnly ? 0 : activeAdapters.length - doneCount;
    if (stillPending >= 2 && readySources() < 3 && remaining() > 1500) {
      await Promise.race([
        Promise.allSettled(adapterTasks),
        wait(Math.min(1300, Math.max(0, remaining() - 1400))),
      ]);
    }

    let verifiedBatch = await verifyCurrentSlots();

    // An AniList lookup must not let Anivexa monopolize the startup window.
    // If no candidate has verified yet, give every outstanding adapter most of
    // the remaining budget; if playback is already verified, allow a short
    // grace period for the standard sources to join the response.
    if (!lateOnly && params.anilistId && doneCount < activeAdapters.length && remaining() > 1500) {
      const waitBudget = verifiedBatch.verifiedLive > 0
        ? Math.min(3000, Math.max(0, remaining() - 1300))
        : Math.max(0, remaining() - 1300);
      await Promise.race([Promise.allSettled(adapterTasks), wait(waitBudget)]);
      verifiedBatch = await verifyCurrentSlots();
    } else if (!lateOnly && doneCount < activeAdapters.length && verifiedBatch.verifiedLive === 0 && remaining() > 400) {
      await Promise.race([Promise.allSettled(adapterTasks), wait(Math.min(800, Math.max(0, remaining() - 300)))]);
      verifiedBatch = await verifyCurrentSlots();
    }

    // Rescue pass. If the clock is the only reason the list is empty, buy one
    // bounded extension instead of reporting "no sources" for a title that is
    // merely late. Deliberately unconditional on the remaining budget: an empty
    // answer is always worse than ~1.2 s of extra wait.
    if (
      !lateOnly &&
      !params.anilistId &&
      verifiedBatch.verifiedLive === 0 &&
      doneCount < activeAdapters.length
    ) {
      const slack = RESCUE_CEILING_MS - (Date.now() - resolveStartedAt);
      if (slack > 300) {
        await Promise.race([
          Promise.allSettled(adapterTasks),
          wait(Math.min(RESCUE_EXTENSION_MS, slack)),
        ]);
        verifiedBatch = await verifyCurrentSlots(Math.min(800, slack));
      }
    }

    // Metadata, skip markers and subtitles are enrichments; none may hold the
    // first playable stream hostage. Their requests continue warming caches.
    // A brief opportunistic window retains metadata and skip markers when
    // they're already close, without making their upstream timeout additive.
    if (!lateOnly && remaining() > 0) {
      // Once something is playable, metadata is pure polish: keep the window
      // short so a slow TMDB call cannot add a second of dead air to a stream
      // that is already verified. With nothing playable yet, wait longer.
      const enrichmentWindow = verifiedBatch.verifiedLive > 0 ? 700 : 1200;
      await Promise.race([
        Promise.allSettled([mediaPromise, ...segmentTasks]),
        wait(Math.min(enrichmentWindow, remaining())),
      ]);
    }
    const media = readyMedia ?? {
      type: params.type, tmdbId: params.tmdbId, imdbId: null,
      ...(params.type === 'tv' ? { season: params.season ?? 1, episode: params.episode ?? 1 } : {}),
      title: '', year: '', overview: '', poster: null, backdrop: null, logo: null,
    };
    const verifiedEntries = verifiedBatch.entries;
    if (process.env.ELFURA_DEBUG_SOURCES === '1') {
      const perSource = activeAdapters.map((adapter) => {
        const hit = verifiedEntries.find((e) => e.adapter.id === adapter.id);
        return hit
          ? `${adapter.id}:raw=${hit.result.candidates.length},live=${hit.liveCandidates.length}`
          : `${adapter.id}:no-result`;
      });
      console.warn(
        `[elfura-sources] ${Date.now() - resolveStartedAt}ms ${params.type}/${params.tmdbId} ${perSource.join(' ')}`,
      );
    }

    const uniformOptions: UniformStreamOption[] = [];
    let mergedSegments: SkipSegments | undefined;
    for (const segments of segmentResults) if (!mergedSegments && segments) mergedSegments = segments;
    const candidateEntries: {adapter: SourceAdapter; candidate: RawStreamCandidate}[] = [];
    // Wrong-cut guard: a stream that plays but is a trailer, a recap or a double
    // episode is worse than no stream, because it looks like a working source.
    const expectedRuntimeSec = media.runtime && media.runtime > 0 ? media.runtime * 60 : null;
    const runtimeToleranceSec = durationToleranceSec(params.type, expectedRuntimeSec);
    const droppedByRuntime: { id: string; measuredSec: number }[] = [];
    // Lanes the runtime guard rejected stay rejected: the coverage pass below
    // must not smuggle a wrong-length clip back into the list.
    const blockedByRuntime = new Set<string>();
    const allLiveCandidates: {adapter: SourceAdapter; candidate: RawStreamCandidate}[] = [];
    // Escape hatch for an operator who would rather see a wrong-length stream
    // than no stream at all.
    const runtimeGuardEnabled = process.env.ELFURA_RUNTIME_GUARD !== '0';
    for (const { adapter, result, liveCandidates } of verifiedEntries) {
      if (!mergedSegments && result.segments) mergedSegments = result.segments;
      if (!media.title && result.metaHint?.title) {
        media.title = params.type === 'tv' && params.season && params.episode
          ? `${result.metaHint.title} · S${params.season}E${params.episode}` : result.metaHint.title;
      }
      if (!media.year && result.metaHint?.year) media.year = result.metaHint.year;
      if (!media.imdbId && result.metaHint?.imdbId) media.imdbId = result.metaHint.imdbId;
      for (const cand of liveCandidates) {
        allLiveCandidates.push({ adapter, candidate: cand });
        const measuredSec = cachedCandidateEvidence(cand)?.durationSec ?? null;
        if (runtimeGuardEnabled && !durationFits(measuredSec, expectedRuntimeSec, runtimeToleranceSec)) {
          droppedByRuntime.push({ id: adapter.id, measuredSec: measuredSec ?? 0 });
          blockedByRuntime.add(cand.url);
          continue;
        }
        candidateEntries.push({adapter,candidate:cand});
        if (cand.standbyUrl && cachedCandidateEvidence({ ...cand, url:cand.standbyUrl, headers:cand.standbyHeaders ?? cand.headers })?.alive) {
          candidateEntries.push({adapter,candidate:{...cand,key:`${cand.key}#standby`,fingerprint:`${cand.fingerprint || cand.key}#standby`,url:cand.standbyUrl,headers:cand.standbyHeaders ?? cand.headers,standbyUrl:undefined,standbyHeaders:undefined}});
        }
      }
    }
    // A filter must never be able to empty the list. If the runtime guard would
    // remove every verified stream, the measurement or the expected runtime is
    // wrong — keep them all and say so, because "no sources" is never better.
    if (droppedByRuntime.length && !candidateEntries.length && allLiveCandidates.length) {
      console.warn(
        `[elfura-resolve] runtime guard DISABLED for ${params.type}/${params.tmdbId}: it would have ` +
          `removed every verified stream (expected ${Math.round((expectedRuntimeSec ?? 0) / 60)}min ` +
          `±${Math.round(runtimeToleranceSec / 60)}min; measured ` +
          `${droppedByRuntime.map((row) => `${Math.round(row.measuredSec / 60)}min`).join(',') || 'none'}). ` +
          `Keeping them all.`,
      );
      for (const entry of allLiveCandidates) candidateEntries.push(entry);
      droppedByRuntime.length = 0;
      blockedByRuntime.clear();
    }

    // Coverage pass: every adapter that answered contributes its usable lanes,
    // not only the ones whose probe finished inside the budget. Verified lanes
    // are already in `candidateEntries` and sort first downstream; these fill in
    // behind them so a title never shows two streams when nineteen sources
    // actually replied. Candidates probed and found dead are never added, and
    // the last rail keeps a total verification blackout from emptying the list.
    {
      const seenUrls = new Set(candidateEntries.map((entry) => entry.candidate.url));
      let appended = 0;
      for (const slot of slots) {
        if (!slot) continue;
        let added = 0;
        for (const cand of languageFirstOrder(slot.result.candidates)) {
          if (added >= MAX_LANES_PER_SOURCE) break;
          if (seenUrls.has(cand.url) || blockedByRuntime.has(cand.url)) continue;
          const evidence = cachedCandidateEvidence(cand);
          if (evidence && !evidence.alive) continue;
          if (evidence && !durationFits(evidence.durationSec ?? null, expectedRuntimeSec, runtimeToleranceSec)) continue;
          seenUrls.add(cand.url);
          candidateEntries.push({ adapter: slot.adapter, candidate: cand });
          added += 1;
          appended += 1;
        }
      }
      if (appended) {
        console.info(
          `[elfura-resolve] ${params.type}/${params.tmdbId}: listed ${appended} extra lane(s) ` +
            `beyond the verified set (per-source cap ${MAX_LANES_PER_SOURCE}, verified first).`,
        );
      }
    }

    // "ORG"/"Original" from an upstream means the Hindi track on every one of
    // these providers; name it honestly instead of showing a vague original.
    for (const entry of candidateEntries) {
      entry.candidate = retagOriginalAudio(entry.adapter, entry.candidate);
    }

    const counts = new Map<string, Map<string, number>>();
    const sequences = new Map<string, number>();
    for (const {adapter,candidate} of selectPlaybackCandidates(candidateEntries, params.preferredLang)) {
      if (!counts.has(adapter.id)) counts.set(adapter.id, new Map());
      const seq = (sequences.get(adapter.id) ?? 0) + 1;
      sequences.set(adapter.id,seq);
      uniformOptions.push(this.sealCandidate(adapter,candidate,seq,counts.get(adapter.id)!,streamBase));
    }

    if (droppedByRuntime.length) {
      console.warn(
        `[elfura-resolve] runtime guard dropped ${droppedByRuntime.length} stream(s) for ` +
          `${params.type}/${params.tmdbId} (expected ${Math.round((expectedRuntimeSec ?? 0) / 60)}min ±` +
          `${Math.round(runtimeToleranceSec / 60)}min) :: ` +
          droppedByRuntime.map((row) => `${row.id}@${Math.round(row.measuredSec / 60)}min`).join(' '),
      );
    }

    if (!uniformOptions.length) {
      // Operator-only diagnostics (server console; never sent to clients).
      const detail = activeAdapters
        .map((adapter) => {
          const hit = verifiedEntries.find((e) => e.adapter.id === adapter.id);
          const report = adapterReport.get(adapter.id);
          if (hit) {
            return `${adapter.id}: raw=${hit.result.candidates.length} verified=${hit.liveCandidates.length}`;
          }
          if (!report) return `${adapter.id}: no-result (still running at ${Date.now() - resolveStartedAt}ms)`;
          return `${adapter.id}: raw=${report.raw ?? '?'} ${report.error ? `error=${report.error}` : 'returned-empty'} ${report.ms}ms`;
        })
        .join(' | ');
      console.warn(
        `[elfura-resolve] NO STREAMS type=${params.type} tmdb=${params.tmdbId} s=${params.season ?? '-'} e=${params.episode ?? '-'} meta=${media.title ? 'ok' : 'missing'} ms=${Date.now() - resolveStartedAt} :: ${detail}`,
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
      // Sources that have not produced anything yet. The client uses this to
      // decide whether a late-join pass is worth making.
      pendingSources: activeAdapters
        .filter((_adapter, idx) => slots[idx] === null)
        .map((adapter) => adapter.id),
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
