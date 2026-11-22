/**
 * Elfura Backend — Modular Source Registry & Uniform Response Builder
 * ===================================================================
 * Orchestrates registered `SourceAdapter` modules concurrently with TMDB
 * metadata resolution, caches raw results in bounded RAM (zero disk writes),
 * strips all internal provider strings, and seals every URL into stateless
 * AES-256-GCM `/api/v1/stream?t=...` tickets.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import type { BackendConfig } from '../config.js';
import { PolicyCache } from '../memory-policy.js';
import { SourceHealthStore } from '../source-health.js';
import { sealStreamTicket } from '../security.js';
import { fetchOpenSubtitlesFallback } from '../subtitles.js';
import { fetchTmdbMetadata } from '../tmdb.js';
import { normalizeLang } from './lang.js';
import { candidateEvidence, cachedCandidateEvidence, cachedCandidateEvidenceAgeMs, diagnoseCandidatePlayback, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { createSource1Adapter } from './source1.js';
import { createSource3Adapter } from './source3.js';
import { createSource4Adapter } from './source4.js';
import { createSource5Adapter } from './source5.js';
import { createSource16Adapter } from './source16.js';
import { createSource17Adapter, TGVIDX_DISCOVERY_TIMEOUT_MS } from './source17.js';
import { createSource6Adapter } from './source6.js';
import { createSource8Adapter } from './source8.js';
import { createSource9Adapter } from './source9.js';
import { createSource10Adapter } from './source10.js';
import { createSource11Adapter } from './source11.js';
import { createSource12Adapter } from './source12.js';
import { createSource13Adapter } from './source13.js';
import { createSource14Adapter } from './source14.js';
import { createSource15Adapter } from './source15.js';
import { createSource18Adapter } from './source18.js';
import { createSource20Adapter } from './source20.js';
import { createSource21Adapter } from './source21.js';
import { createSource22Adapter } from './source22.js';
import { createSource24Adapter } from './source24.js';
import { createSource25Adapter } from './source25.js';
import { createSource28Adapter } from './source28.js';
import { createSource29Adapter } from './source29.js';
import { createSource30Adapter } from './source30.js';
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

// Raised for a 4 GB container (was 256). One row is a resolved title's
// candidates; 1024 of those is the difference between every viewer in a
// spike re-resolving the same episode and the first one paying for it.
const MAX_ADAPTER_CACHE_ENTRIES = 1024;
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
  'source-6': 'ELFURA_TELUGU_ENABLED',
  'source-7': 'ELFURA_SCREENSCAPE_ENABLED', // merged into source-5; kept so an old env var still maps
  'source-16': 'ELFURA_HINDI_DUB_ENABLED',
  'source-17': 'ELFURA_TGVIDX_ENABLED',
  'source-8': 'ELFURA_VIDZEE_ENABLED',
  'source-9': 'ELFURA_VIXSRC_ENABLED',
  'source-10': 'ELFURA_VIDNEST_ENABLED',
  'source-11': 'ELFURA_VAPLAYER_ENABLED',
  'source-12': 'ELFURA_VIDZEN_ENABLED',
  'source-13': 'ELFURA_XPASS_ENABLED',
  'source-14': 'ELFURA_RIVE_CITADEL_ENABLED',
  'source-15': 'ELFURA_MAPPLE_ENABLED',
  'source-18': 'ELFURA_SUBDUB_ENABLED',
  'source-20': 'ELFURA_VIDORA_ENABLED',
  'source-21': 'ELFURA_WATCHOUT_ENABLED',
  'source-24': 'ELFURA_VIDLINK_ENABLED',
  'source-25': 'ELFURA_GREYBOX_ENABLED',
  'source-28': 'ELFURA_ANIME_MULTI_ENABLED',
  'source-29': 'ELFURA_ANIME_29_ENABLED',
  'source-30': 'ELFURA_ANIME_30_ENABLED',
};

const resolveBudgetMs = (): number => {
  const raw = Number(process.env.ELFURA_RESOLVE_BUDGET_MS || 5000);
  return Number.isFinite(raw) ? Math.max(3000, Math.min(20_000, raw)) : 5000;
};
/**
 * Candidates probed in the shared verification batch, spread across sources.
 *
 * With 21 adapters this divided down to the floor of 2 lanes per source, so a
 * multi-language source had 2 of its 21 lanes verified and the rest reached the
 * player unprobed. 84 gives roughly four each at the current board size.
 *
 * 160 was tried first and was too greedy: the probe ran long enough to eat the
 * resolve budget, and slower adapters that had candidates never got sealed at
 * all - two whole sources were lost to gain thirteen slots. Four per source,
 * language-aware, is the balance.
 */
const VERIFY_BREADTH_TARGET = 84;
/**
 * How many extra lanes one adapter may add in the coverage pass, beyond the
 * verified set. Verified lanes are not counted, so this only limits how much a
 * single prolific source can pad the tail of the list.
 *
 * This was 12 and it was measurably losing streams. A multi-language source
 * returns one lane per language (Greybox: 21 for a film, 14 for an episode;
 * bingr: 10), and a cap of 12 cut that to five, so the language variety a
 * source was chosen for never reached the player. Set to 200: the intended
 * ceiling here is "all of them", and the real limits are the liveness probe and
 * the per-adapter candidate caps upstream of this point.
 */
const MAX_LANES_PER_SOURCE = 200;

type WaveEntry = { adapter: SourceAdapter; result: RawSourceResult; bytes: number };
type DiscoveryWave = { expiresAt: number; entries: Map<string, WaveEntry>; retried: Set<string>; bytes: number };
const MAX_WAVE_TITLES = 256;
const MAX_WAVE_BYTES = 32 * 1024 * 1024;

export class SourceRegistry {
  private readonly adapters: SourceAdapter[];
  private readonly cfg: BackendConfig;
  /**
   * Per-source health and operator switches. Health is recorded and displayed
   * only: failures never remove a source by themselves. The single thing that
   * takes a source out of rotation is an operator switching it off in the panel.
   */
  readonly health: SourceHealthStore;
  private readonly ramCache = new PolicyCache<{ expiresAt: number; result: RawSourceResult }>(
    MAX_ADAPTER_CACHE_ENTRIES,
  );
  private readonly inFlight = new Map<string, Promise<RawSourceResult>>();
  private readonly segmentCache = new PolicyCache<{ expiresAt: number; result: SkipSegments | undefined }>(
    MAX_ADAPTER_CACHE_ENTRIES,
  );
  private readonly segmentInFlight = new Map<string, Promise<SkipSegments | undefined>>();
  /** Short-lived discovery-wave state, independent of optional payload caches. */
  private readonly finishedLate = new Map<string, DiscoveryWave>();
  private finishedLateBytes = 0;

  /**
   * Why the last resolve came back empty, when it was us and not the title.
   * The resolver reports this so "no streams" never silently means "every
   * source was switched off".
   */
  lastEmptyReason: string | null = null;

  constructor(cfg: BackendConfig) {
    this.cfg = cfg;
    this.health = new SourceHealthStore(process.env.ROXY_DATA_DIR || path.join(process.cwd(), 'data'));
    // Record what each adapter actually talked to, so a resolve that yields
    // nothing can explain itself in the console.
    installNetTap();

    // Plug-and-play SourceAdapter registry (Part 1 requires zero changes when adding sources).
    this.adapters = [
      // Source 1 is one adapter owning all four direct upstreams it was built
      // for: vidrift (rift), vidsync (sync), vidrock (rock) and vidbolt.
      //
      // It used to be split across two registry entries, and the split was
      // silently destructive: `createSource1Adapter(cfg, 2, ...)` derives its id
      // as `source-${group}`, so the entry carrying vidrift and vidrock was
      // registered as **source-2**. The real source-2 adapter
      // (createSource2Adapter) is imported nowhere, so nothing collided and
      // nothing errored — the vidrift/vidrock results simply appeared in the
      // panel under a source that had nothing to do with them, while the
      // `source-1` row was the vidbolt-only stub with vidbolt explicitly
      // disabled below. Four upstreams, and the panel could not attribute one
      // of them correctly.
      createSource1Adapter(cfg.source1, 2, { includeVidBolt: true, id: 'source-1' }),
      // source-2 is deliberately NOT registered. Its adapter exists in
      // ./source2.ts and is exercised directly by the e2e suite, but
      // `cfg.source2` is pinned to `{enabled:false, embedOrigin:'', nxshaOrigin:'',
      // vidstuckOrigin:''}` and legacy SOURCE2_* env vars are stripped (see
      // config.ts), because its upstreams — nxsha `/api/extract`, `/api/scan`,
      // `/api/sources` and the vidstuck/vidbolt resolver — are gone. Mounting it
      // on the default config made it run anyway and re-introduce those dead
      // endpoints into live traffic; e2e asserts `removedSourceCalls === 0`
      // ('legacy SOURCE2 settings must not activate removed providers').
      // Before mounting it, establish which of its upstreams still answers.
      createSource3Adapter(cfg.source3),
      createSource4Adapter(() => cfg.source4?.enabled ?? process.env.ELFURA_BINGR_ENABLED !== '0'),
      // source-7 was never independent: it reused source-5's fetcher against the
      // same host with a different lane list. It is now source-5's second lane
      // set, with its original default-off gate preserved.
      createSource5Adapter(
        () => cfg.source5?.enabled ?? process.env.ELFURA_NXSHA_ENABLED !== '0',
        () => cfg.source7?.enabled ?? process.env.ELFURA_SCREENSCAPE_ENABLED === '1',
      ),
      // Telugu-only lane, derived from source-5's scraper list but kept as its
      // own id so its yield is attributable in the panel. Default off.
      createSource6Adapter(() => cfg.source6?.enabled ?? false),
      // Hindi-dub anime lane. AniList-keyed, but the TMDB id is converted on the
      // server (./anime-db.ts) so the embed URL stays `/embed/tv/<tmdbId>`. On by
      // default: it needs no credentials and answered 5/5 titles in testing.
      createSource16Adapter(() => cfg.source16?.enabled ?? process.env.ELFURA_HINDI_DUB_ENABLED !== '0'),
      // Dynamic TGVIDX inventory; own-player rows are excluded to avoid recursion.
      createSource17Adapter(() => cfg.source17?.enabled ?? process.env.ELFURA_TGVIDX_ENABLED !== '0'),
      createSource8Adapter(() => cfg.source8?.enabled ?? false),
      createSource9Adapter(() => cfg.source9?.enabled ?? false),
      createSource10Adapter(() => cfg.source10?.enabled ?? false),
      createSource11Adapter(() => cfg.source11?.enabled ?? false),
      createSource12Adapter(() => cfg.source12?.enabled ?? false),
      createSource13Adapter(() => cfg.source13?.enabled ?? false),
      createSource14Adapter(() => cfg.source14?.enabled ?? false),
      createSource15Adapter(() => cfg.source15?.enabled ?? false),
      createSource18Adapter(() => cfg.source18?.enabled ?? process.env.ELFURA_SUBDUB_ENABLED !== '0'),
      createSource20Adapter(() => cfg.source20?.enabled ?? process.env.ELFURA_VIDORA_ENABLED !== '0'),
      createSource21Adapter(() => cfg.source21?.enabled ?? process.env.ELFURA_WATCHOUT_ENABLED !== '0'),
      createSource22Adapter(() => cfg.source22?.enabled ?? process.env.ELFURA_VIDLY_SUBS_ENABLED !== '0'),
      // VidLink: a measured JSON API, not a scrape.
      createSource24Adapter(cfg.source24),
      // Greybox: plain JSON with per-stream language labels and no token.
      createSource25Adapter(cfg.source25),
      // Source 26 is intentionally not registered: tested streams can play
      // audio without video on browsers that lack HEVC decoding.
      // Direct multi-audio anime. Only mapped season-one episodes with matching
      // TMDB episode titles are accepted; no title or language is guessed.
      createSource28Adapter(() => cfg.source28?.enabled ?? process.env.ELFURA_ANIME_MULTI_ENABLED !== '0'),
      createSource29Adapter(() => cfg.source29?.enabled ?? process.env.ELFURA_ANIME_29_ENABLED !== '0'),
      createSource30Adapter(() => cfg.source30?.enabled ?? process.env.ELFURA_ANIME_30_ENABLED !== '0'),
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
  ): Promise<{ id: string; raw: number; ms: number; net: string; skipped?: string }[]> {
    // Share one lazy metadata lookup just as the playback resolver does. Anime
    // adapters cannot correctly resolve an episode without TMDB metadata.
    let metaPromise: ReturnType<typeof fetchTmdbMetadata> | undefined;
    const resolveMetaFallback = () => (metaPromise ??= fetchTmdbMetadata(this.cfg.tmdb, params));
    return Promise.all(
      this.adapters
        .filter((adapter) => adapter.enabled())
        .map(async (adapter) => {
          const started = Date.now();
          if (params.type === 'movie' && ['source-28', 'source-29', 'source-30'].includes(adapter.id)) {
            return { id: adapter.id, raw: 0, ms: 0, net: '0 req', skipped: 'TV anime only' };
          }
          const query: SourceQuery = {
            type: params.type,
            tmdbId: params.tmdbId,
            season: params.season,
            episode: params.episode,
            resolveMetaFallback,
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
    // Operator switches and cooldowns are reported separately by `health`, so this
    // keeps listing what is *configured*: the panel decides how to show it.
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
    /** Every lane this diagnostics run verified as working, listed or not. */
    const diagnosticProbedAlive = new Set<string>();
    /** Every lane this diagnostics run confirmed dead, listed or not. */
    const diagnosticProbedDead = new Set<string>();
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
            const { candidates: verified, verifiedAliveCount, probedAlive: probeAlive, probedDead: probeDead } =
              await verifyAndFilterCandidatesDetailed(raw);
            diagnosticCandidates.set(adapter.id, verified);
            for (const url of probeAlive) diagnosticProbedAlive.add(url);
            for (const url of probeDead) diagnosticProbedDead.add(url);
            return {
              id: adapter.id,
              ms: Date.now() - t0,
              raw: raw.length,
              retained: verified.length,
              manifestReachable: verifiedAliveCount,
              manifestMultiAudio: verified.filter((c) => {
                const langs = c.measuredThisRequest?.alive
                  ? c.measuredThisRequest.discoveredAudioLangs
                  : cachedCandidateEvidence(c)?.discoveredAudioLangs;
                return new Set(langs ?? []).size > 1;
              }).length,
              // Raw claims and independently measured manifest evidence are
              // intentionally separate. Never return URLs, headers or tokens.
              options: raw.slice(0, 20).map((candidate) => {
                const measured = verified.find((v) => v.url === candidate.url)?.measuredThisRequest;
                const remembered = cachedCandidateEvidence(candidate);
                const evidence = measured
                  ? {
                      alive: measured.alive,
                      confirmedDead: !measured.alive,
                      rttMs: measured.rttMs,
                      discoveredAudioLangs: measured.discoveredAudioLangs ?? remembered?.discoveredAudioLangs,
                      durationSec: measured.durationSec ?? remembered?.durationSec,
                      manifestKind: remembered?.manifestKind,
                      manifestAudioRenditions: remembered?.manifestAudioRenditions,
                      manifestVideoVariants: remembered?.manifestVideoVariants,
                      qualityLadder: remembered?.qualityLadder,
                    }
                  : remembered;
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
    // Per-lane health for the diagnostics view. Verification happens on copies
    // of the raw candidates, so match them back by URL: a lane's health has to
    // come from what this run probed, not only from a cache.
    const verifiedByUrl = new Map<string, RawStreamCandidate>();
    for (const list of diagnosticCandidates.values()) for (const v of list) verifiedByUrl.set(v.url, v);
    const lanes = diag.map(entry => {
      const candidates = (diagnosticRaw.get(entry.adapter) ?? []).filter(c => c.diagnosticLane === entry.lane);
      const evidence = candidates.map(c => {
        const measured = verifiedByUrl.get(c.url)?.measuredThisRequest;
        if (measured) {
          return {
            alive: measured.alive,
            confirmedDead: !measured.alive,
            discoveredAudioLangs: measured.discoveredAudioLangs,
          };
        }
        // Verified working but filtered out of the retained list (e.g. a
        // runtime mismatch): still evidence the lane answered.
        if (diagnosticProbedAlive.has(c.url)) {
          return { alive: true, confirmedDead: false, discoveredAudioLangs: cachedCandidateEvidence(c)?.discoveredAudioLangs };
        }
        if (diagnosticProbedDead.has(c.url)) {
          return { alive: false, confirmedDead: true };
        }
        return cachedCandidateEvidence(c);
      });
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
    this.ramCache.set(key, {
      expiresAt: Date.now() + ADAPTER_CACHE_TTL_MS,
      result,
    });
  }

  private resolveAdapterWithCache(
    adapter: SourceAdapter,
    baseKey: string,
    query: SourceQuery,
    onLateResult?: (result: RawSourceResult) => void,
    onOrigin?: (origin: 'cache' | 'shared' | 'fresh') => void,
  ): Promise<RawSourceResult> {
    const cached = this.getCachedAdapterResult(baseKey);
    if (cached) { onOrigin?.('cache'); return Promise.resolve(cached); }

    const existing = this.inFlight.get(baseKey);
    if (existing) { onOrigin?.('shared'); return existing; }

    onOrigin?.('fresh');
    const p = adapter
      .resolve({ ...query, preferredLang: undefined, onLateResult: (result) => {
        this.setCachedAdapterResult(baseKey, result);
        onLateResult?.(result);
      } })
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
    retryMissing?: boolean;
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
    // Only an operator switch removes a source here. A source that has failed
    // every time for a week is still asked, because nothing here may decide on
    // its own that a provider is finished — that judgment belongs to the person
    // reading the panel.
    const activeAdapters = this.adapters.filter(
      (a) =>
        a.enabled() &&
        this.health.shouldAttempt(a.id) &&
        (!params.sourceId || a.id === params.sourceId),
    );
    const switchedOff = this.adapters.filter(
      (a) => a.enabled() && !this.health.shouldAttempt(a.id) && (!params.sourceId || a.id === params.sourceId),
    );
    this.lastEmptyReason = null;
    if (!activeAdapters.length) {
      // Nothing to try. Reported up so the resolver can say *why* the answer is
      // empty, instead of letting it read like "this title has no sources".
      if (switchedOff.length) {
        this.lastEmptyReason = `${switchedOff.length} source(s) switched off by the operator`;
      }
      return null;
    }

    const streamBase = params.streamPathPrefix || '/api/v1/stream';

    // Identity of this title for the late-join stash. Deliberately excludes
    // headers/tokens: it is only a bucket name.
    const lateKey = `${params.type}|${params.tmdbId}|${params.season ?? ''}|${params.episode ?? ''}|${params.anilistId ?? ''}|${params.anilistEpisode ?? ''}`;
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

    // TGVIDX aggregates upstreams before replying; its normal response now
    // takes roughly eight seconds and can exceed the shared discovery signal.
    // Give only its background wave a longer, bounded signal. This does not
    // extend the first-list deadline, change resolver routing, or detach a
    // caller-supplied cancellation signal in the adapter itself.
    const queryFor = (adapter: SourceAdapter): SourceQuery =>
      adapter.id === 'source-17' && !singleSource
        ? { ...query, signal: AbortSignal.timeout(Math.max(this.cfg.resolveTimeoutMs, TGVIDX_DISCOVERY_TIMEOUT_MS)) }
        : query;

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
    // Concurrent viewers of the same title share the same active wave. A new
    // request must not erase a previous viewer's in-flight discoveries. State
    // expires independently of the optional payload cache and is size-bounded.
    this.pruneFinishedLate();
    let wave = this.finishedLate.get(lateKey);
    if (!lateOnly && !wave) {
      wave = { expiresAt: Date.now() + 60_000, entries: new Map(), retried: new Set(), bytes: 0 };
      this.finishedLate.set(lateKey, wave);
      this.pruneFinishedLate();
    }
    const currentWave = wave;
    if (lateOnly && currentWave) {
      activeAdapters.forEach((adapter, idx) => {
        const hit = currentWave.entries.get(adapter.id);
        if (hit) slots[idx] = { adapter, result: hit.result };
      });
    }
    // One shared retry for adapters that explicitly finished empty. This is
    // asynchronous and coalesced per title/source, not N rediscovery requests
    // per viewer. In-flight and nonempty providers are never restarted here.
    if (lateOnly && params.retryMissing && currentWave) {
      activeAdapters.forEach((adapter, idx) => {
        const existing = currentWave.entries.get(adapter.id);
        if (!existing || existing.result.candidates.length || currentWave.retried.has(adapter.id) || this.inFlight.has(cacheKeys[idx])) return;
        currentWave.retried.add(adapter.id);
        void this.resolveAdapterWithCache(adapter, cacheKeys[idx], queryFor(adapter), result => {
          this.recordWaveResult(lateKey, currentWave, adapter, result);
        }).then(result => {
          this.recordWaveResult(lateKey, currentWave, adapter, result);
          if (result.candidates.length) this.health.recordSuccess(adapter.id);
        }).catch(() => { /* optional recovery, never an unhandled rejection */ });
      });
    }
    const adapterTasks = lateOnly ? [] : activeAdapters.map(async (adapter, idx) => {
      const cacheKey = cacheKeys[idx];
      const startedAt = Date.now();
      let origin: 'cache' | 'shared' | 'fresh' = 'fresh';
      try {
        const tapped = await tapRequests(() => this.resolveAdapterWithCache(adapter, cacheKey, queryFor(adapter), result => {
          if (currentWave) this.recordWaveResult(lateKey, currentWave, adapter, result);
        }, value => { origin = value; }));
        const result = tapped.value;
        adapterNet.set(adapter.id, tapped.net);
        slots[idx] = { adapter, result };
        if (currentWave) this.recordWaveResult(lateKey, currentWave, adapter, result);
        adapterReport.set(adapter.id, { ms: Date.now() - startedAt, raw: result.candidates.length });
        // Learn from what actually happened. "No candidates" is not a failure —
        // that provider may simply not carry this title — so only a throw or an
        // explicit error marks a source unhealthy.
        if (result.candidates.length > 0) this.health.recordSuccess(adapter.id);
        if (!result.candidates.length) {
          console.warn(
            `[elfura-sources] ${adapter.id} ${params.type}/${params.tmdbId}: 0 candidates in ` +
              `${Date.now() - startedAt}ms :: ${summarizeNet(tapped.net)} (observed global fetch; lookup=${origin})`,
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
        const name = err instanceof Error ? err.name : 'Error';
        adapterReport.set(adapter.id, { ms: Date.now() - startedAt, error: name });
        this.health.recordFailure(adapter.id, name);
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

    // Only confirmed Japanese animation gets the short additional join window.
    // All adapters were already launched; never block the late-join mechanism or
    // use this window for a source-specific recovery request.
    const isPriorityAnime = () => params.type === 'tv' && (params.season ?? 1) === 1 &&
      readyMedia?.originalLanguage === 'ja' &&
      !!readyMedia.genres?.some(g => g.toLowerCase() === 'animation');
    const priorityIds = new Set(['source-28', 'source-29', 'source-30']);
    if (!lateOnly && !singleSource && isPriorityAnime() && remaining() > 1400) {
      const priorityTasks = adapterTasks.filter((_, idx) => priorityIds.has(activeAdapters[idx].id));
      if (priorityTasks.length) await Promise.race([
        Promise.allSettled(priorityTasks), wait(Math.min(2300, Math.max(0, remaining() - 1400))),
      ]);
    }

    const verifyCurrentSlots = async (probeFloorMs = PROBE_MIN_WINDOW_MS) => {
      const ready = slots.filter(
        (x): x is { adapter: SourceAdapter; result: RawSourceResult } => x !== null,
      );
      // Breadth first: probe each adapter's best lanes before any adapter's
      // leftovers. A single source with 20 candidates must not starve every
      // other source out of the shared verification budget.
      //
      // Ordering within an adapter is language-aware. A multi-language source
      // emits one lane per language in provider order, so plain index order
      // probes its first N languages and skips the rest - the exact variety the
      // source was added for. Taking one lane per distinct language first means
      // a 21-lane source spends its probe budget across 8 languages instead of
      // 21 rows of the same one.
      if (isPriorityAnime()) ready.sort((a, b) =>
        Number(priorityIds.has(b.adapter.id)) - Number(priorityIds.has(a.adapter.id)));
      const perAdapter = ready.map((entry) => {
        const byLanguage = new Map<string, RawStreamCandidate[]>();
        for (const cand of entry.result.candidates) {
          const lang = cand.claimedAudioLang ?? cand.audioLang ?? '';
          const bucket = byLanguage.get(lang);
          if (bucket) bucket.push(cand);
          else byLanguage.set(lang, [cand]);
        }
        if (byLanguage.size < 2) return entry.result.candidates;
        const ordered: RawStreamCandidate[] = [];
        const buckets = [...byLanguage.values()];
        const maxBucket = Math.max(...buckets.map((bucket) => bucket.length));
        for (let i = 0; i < maxBucket; i += 1) {
          for (const bucket of buckets) if (bucket[i]) ordered.push(bucket[i]);
        }
        return ordered;
      });
      const breadth = Math.max(2, Math.floor(VERIFY_BREADTH_TARGET / Math.max(1, perAdapter.length)));
      const tagged: RawStreamCandidate[] = [];
      for (let i = 0; i < breadth; i += 1) {
        for (let adapterIdx = 0; adapterIdx < perAdapter.length; adapterIdx += 1) {
          const cand = perAdapter[adapterIdx][i];
          if (cand) tagged.push({ ...cand, key: `${adapterIdx}::${cand.key}` });
        }
      }
      const { candidates: vFlat, verifiedAliveCount, probedDead } =
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
          isPriorityAnime() ? new Set(tagged.filter(c => {
            const idx = Number(c.key.slice(0, c.key.indexOf('::')));
            return priorityIds.has(ready[idx].adapter.id);
          }).map(c => c.url)) : undefined,
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
        probedDead,
      };
    };

    // A short source list is worse than a slightly slower start: when fewer than
    // three sources have produced candidates, keep listening for the adapters
    // that are still working instead of shipping what happened to arrive first.
    const readySources = () =>
      slots.filter((slot) => slot !== null && slot.result.candidates.length > 0).length;
    // A late pass snapshots the completed wave entries; empty results are
    // recorded too, while adapters not yet settled remain pending.
    const lateStash = lateOnly ? [...(currentWave?.entries.values() ?? [])] : [];
    const stillPending = lateOnly
      ? activeAdapters.filter((adapter) => !lateStash.some((entry) => entry.adapter.id === adapter.id)).length
      : activeAdapters.length - doneCount;
    if (stillPending >= 2 && readySources() < 3 && remaining() > 1500) {
      await Promise.race([
        Promise.allSettled(adapterTasks),
        wait(Math.min(1300, Math.max(0, remaining() - 1400))),
      ]);
    }

    // With a large provider board, three fast answers are not a full first
    // wave. Give the other already-running adapters a small bounded chance to
    // join, while retaining time for verification and fast two-source starts.
    if (!lateOnly && !singleSource && activeAdapters.length >= 5 &&
        readySources() >= 3 && readySources() < Math.min(8, Math.ceil(activeAdapters.length / 2)) && remaining() > 1500) {
      await Promise.race([Promise.allSettled(adapterTasks), wait(Math.min(700, remaining() - 1400))]);
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
    // A runtime mismatch may mean a trailer or wrong episode, but metadata and
    // playlist measurements are not conclusive. Treat it as a fallback.
    const expectedRuntimeSec = media.runtime && media.runtime > 0 ? media.runtime * 60 : null;
    const runtimeToleranceSec = durationToleranceSec(params.type, expectedRuntimeSec);
    const droppedByRuntime: { id: string; measuredSec: number }[] = [];
    // Lanes the runtime guard rejected stay rejected: the coverage pass below
    // must not smuggle a wrong-length clip back into the list.
    const blockedByRuntime = new Set<string>();
    // Streams whose measured duration does not match, kept as a last-resort rail
    // rather than deleted (see the guard below).
    const wrongRuntime: { adapter: SourceAdapter; candidate: RawStreamCandidate }[] = [];
    /** Lanes this request probed and confirmed dead (see verifyAndFilterCandidatesDetailed). */
    const probedDeadHere = verifiedBatch.probedDead;
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
        // This request measured the runtime a moment ago; the cache may be off.
        const measuredSec =
          cand.measuredThisRequest?.durationSec ?? cachedCandidateEvidence(cand)?.durationSec ?? null;
        if (runtimeGuardEnabled && !durationFits(measuredSec, expectedRuntimeSec, runtimeToleranceSec)) {
          // Wrong length is a reason to rank a stream last, not to hide it.
          // A trailer that plays is more useful to a viewer than an empty list,
          // and the measurement itself is a guess: live-edge VOD windows, a
          // playlist that mentions a duration for only one variant, and provider
          // metadata being wrong all produce a mismatch on a perfectly good
          // stream. Recorded here, sorted behind the correct-length lanes below.
          droppedByRuntime.push({ id: adapter.id, measuredSec: measuredSec ?? 0 });
          wrongRuntime.push({ adapter, candidate: cand });
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

    // Wait for subtitles before taking the coverage snapshot, not after sealing
    // sources. This is the same existing 100ms window, but adapters finishing
    // during it can now join the first list rather than being needlessly late.
    const shouldResolveOpenSubtitles = Boolean(media.imdbId) && Boolean(this.cfg.subtitles?.enabled);
    if (shouldResolveOpenSubtitles && !subtitleState.value && remaining() > 0 &&
        slots.some(slot => Boolean(slot?.result.candidates.length))) {
      await Promise.race([earlyOpenSubsPromise, wait(Math.min(100, remaining()))]);
    }
    // Freeze the slots used for this response. A source completing after this
    // point must remain pending even if the live slots or stash change before
    // the reply is sent. The same applies to late-only responses.
    const coverageSlots = lateOnly ? slots.slice() : slots.map((slot, idx) => {
      const latest = currentWave?.entries.get(activeAdapters[idx].id);
      return latest ?? slot;
    });
    // Coverage pass: every adapter that answered contributes its usable lanes,
    // not only the ones whose probe finished inside the budget. Verified lanes
    // are already in `candidateEntries` and sort first downstream; these fill in
    // behind them so a title never shows two streams when nineteen sources
    // actually replied. Candidates probed and found dead are never added, and
    // the last rail keeps a total verification blackout from emptying the list.
    {
      const seenUrls = new Set(candidateEntries.map((entry) => entry.candidate.url));
      let appended = 0;
      for (const slot of coverageSlots) {
        if (!slot) continue;
        let added = 0;
        for (const cand of slot.result.candidates) {
          if (added >= MAX_LANES_PER_SOURCE) break;
          if (seenUrls.has(cand.url) || blockedByRuntime.has(cand.url)) continue;
          // A probe run during this request speaks with the same authority as a
          // remembered one: a lane it confirmed dead must not come back just
          // because the cache that would have remembered that is switched off.
          if (probedDeadHere.has(cand.url)) continue;
          const evidence = cachedCandidateEvidence(cand);
          if (evidence && !evidence.alive) continue;
          const measured = cand.measuredThisRequest;
          const durationHere = measured?.durationSec ?? evidence?.durationSec ?? null;
          const aliveHere = measured?.alive || !!evidence?.alive;
          if (runtimeGuardEnabled && aliveHere && !durationFits(durationHere, expectedRuntimeSec, runtimeToleranceSec)) continue;
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

    // Close the list with wrong-length streams: they are real, they play, and
    // they are better than nothing when every correctly-timed lane is blocked.
    for (const entry of wrongRuntime) {
      if (!candidateEntries.some((existing) => existing.candidate.url === entry.candidate.url)) {
        candidateEntries.push(entry);
      }
    }

    const counts = new Map<string, Map<string, number>>();
    const sequences = new Map<string, number>();
    // A lane whose runtime this request measured and matched is tier 0; one that
    // could not be measured at all is tier 1. Without this the sort falls through
    // to latency, and a fast unmeasured clip outranks the verified episode.
    const verifiedRuntimeUrls = new Set(
      candidateEntries
        .filter((entry) => {
          const cand = entry.candidate;
          const measured = cand.measuredThisRequest?.durationSec ?? cachedCandidateEvidence(cand)?.durationSec ?? null;
          return measured !== null && durationFits(measured, expectedRuntimeSec, runtimeToleranceSec);
        })
        .map((entry) => entry.candidate.url),
    );
    const rankHint = (url: string) => (verifiedRuntimeUrls.has(url) ? 0 : 1);
    for (const {adapter,candidate} of selectPlaybackCandidates(candidateEntries, params.preferredLang, rankHint)) {
      if (!counts.has(adapter.id)) counts.set(adapter.id, new Map());
      const seq = (sequences.get(adapter.id) ?? 0) + 1;
      sequences.set(adapter.id,seq);
      const option = this.sealCandidate(adapter,candidate,seq,counts.get(adapter.id)!,streamBase);
      const evidence = candidateEvidence(candidate);
      const duration = evidence?.durationSec ?? null;
      if (isPriorityAnime() && !evidence?.alive) option.animeUnverified = true;
      if (isPriorityAnime() && priorityIds.has(adapter.id) && evidence?.alive &&
          durationFits(duration, expectedRuntimeSec, runtimeToleranceSec)) option.animePriority = true;
      uniformOptions.push(option);
    }

    if (droppedByRuntime.length) {
      console.warn(
        `[elfura-resolve] runtime mismatch: ${droppedByRuntime.length} stream(s) considered as fallback before deduplication/selection for ` +
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

    // Only OpenSubtitles tracks are exposed by default. No provider subtitle
    // fallback — with one exception: the Vidly index (source-22), which is a
    // separate, unauthenticated subtitle catalogue. It is used only when
    // OpenSubtitles produced nothing, so it can add languages but can never
    // displace a working OpenSubtitles track.
    if (shouldResolveOpenSubtitles && media.imdbId) {
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
          if (['source-29', 'source-30'].includes(opt.sourceId) && opt.subtitles.length) {
            const existing = new Set(opt.subtitles.map(track => track.lang));
            opt.subtitles = [...opt.subtitles, ...sealedFallbackSubs.filter(track => !existing.has(track.lang))];
          } else {
            opt.subtitles = [...sealedFallbackSubs];
          }
        }
      }
    }

    // Vidly subtitle index: a language fallback, never a replacement.
    // `query.extraSubtitles` was filled in by the source-22 lane during the same
    // resolve, so this costs no extra request and no extra wait.
    const vidlyTracks = query.extraSubtitles ?? [];
    if (vidlyTracks.length && uniformOptions.length) {
      const sealedVidly = vidlyTracks.map((track) => ({
        lang: track.lang,
        label: track.label,
        format: 'vtt' as const,
        url: `${streamBase}?t=${encodeURIComponent(
          sealStreamTicket(this.cfg.secret, {
            u: track.url,
            ...(track.headers && Object.keys(track.headers).length ? { h: track.headers } : {}),
            k: 's',
          }),
        )}`,
      }));
      for (const opt of uniformOptions) {
        const already = new Set((opt.subtitles ?? []).map((track) => track.lang));
        const added = sealedVidly.filter((track) => !already.has(track.lang));
        // Never overwrite a language we already have: OpenSubtitles wins.
        if (added.length) opt.subtitles = [...(opt.subtitles ?? []), ...added];
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
          Number(!!a.animeUnverified) - Number(!!b.animeUnverified) ||
          Number(!!b.animePriority) - Number(!!a.animePriority) ||
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
            scoreOpt(a) - scoreOpt(b) ||
            Number(!!a.animeUnverified) - Number(!!b.animeUnverified) ||
            Number(!!b.animePriority) - Number(!!a.animePriority) ||
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
      waveUpdates: true,
      // Sources that have not produced anything yet. The client uses this to
      // decide whether a late-join pass is worth making.
      pendingSources: activeAdapters
        .filter((_, idx) => coverageSlots[idx] === null)
        .map((adapter) => adapter.id),
      ...(mergedSegments ? { segments: mergedSegments } : {}),
    };
  }

  /** Merge partial provider callbacks without losing already returned lanes. */
  private recordWaveResult(
    key: string,
    wave: DiscoveryWave,
    adapter: SourceAdapter,
    result: RawSourceResult,
  ): void {
    // Do not resurrect an evicted or expired wave from a stale async completion.
    if (this.finishedLate.get(key) !== wave || Date.now() >= wave.expiresAt) return;
    const previous = wave.entries.get(adapter.id);
    const old = previous?.result;
    const candidates = new Map((old?.candidates ?? []).map(c => [c.url, c]));
    for (const candidate of result.candidates) candidates.set(candidate.url, candidate);
    const merged = { ...old, ...result, candidates: [...candidates.values()].slice(0, MAX_LANES_PER_SOURCE) };
    // Account for retained payloads as well as title count; enormous provider
    // responses must not pin the heap during a burst of distinct titles.
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(merged)); } catch { return; }
    const delta = bytes - (previous?.bytes ?? 0);
    wave.bytes += delta;
    this.finishedLateBytes += delta;
    wave.entries.set(adapter.id, { adapter, result: merged, bytes });
    this.pruneFinishedLate();
  }

  private pruneFinishedLate(): void {
    const now = Date.now();
    const remove = (key: string, wave: DiscoveryWave) => {
      this.finishedLate.delete(key);
      this.finishedLateBytes -= wave.bytes;
    };
    for (const [key, wave] of this.finishedLate) if (wave.expiresAt <= now) remove(key, wave);
    // Bounded by both count and payload bytes. An evicted wave falls back to
    // one fresh lookup rather than permanently losing the viewer's sources.
    while (this.finishedLate.size > MAX_WAVE_TITLES || this.finishedLateBytes > MAX_WAVE_BYTES) {
      const oldest = this.finishedLate.entries().next().value;
      if (!oldest) break;
      remove(oldest[0], oldest[1]);
    }
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
    if (adapter.id === 'source-29' && cand.animeSubtitleMode === 'hard') {
      trait = 'Provider-labelled Hard Sub';
    } else if (cand.multiAudio) {
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
      ...(cand.restrictedOrigin ? { ro: cand.restrictedOrigin, fp: 1 as const } : {}),
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

    // Only the new anime lane opts into source-specific, episode-aligned
    // subtitles. Keep the existing subtitle policy for every other adapter.
    const subtitles = ['source-29', 'source-30'].includes(adapter.id) ? (cand.subtitles ?? []).map((track) => ({
      lang: track.lang,
      label: track.label,
      ...(track.format ? { format: track.format } : {}),
      url: `${streamBase}?t=${encodeURIComponent(sealStreamTicket(this.cfg.secret, {
        u: track.url,
        ...(track.headers && Object.keys(track.headers).length ? { h: track.headers } : {}),
        ...(cand.restrictedOrigin ? { ro: cand.restrictedOrigin } : {}),
        k: 's',
      }))}`,
    })) : [];

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
      subtitles,
    };
  }
}
