// @ts-nocheck
/**
 * Elfura Backend — Modular Source Registry & Uniform Response Builder
 * ===================================================================
 * Orchestrates registered `SourceAdapter` modules concurrently with TMDB
 * metadata resolution, caches raw results in bounded RAM (zero disk writes),
 * strips all internal provider strings, and shapes every URL into one
 * stateless raw-stream proxy URL (`/api/proxy?u=...`).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { PolicyCache } from '../memory-policy.js';
import { SourceHealthStore } from '../source-health.js';
import { sealStreamTicket } from '../security.js';
import { fetchOpenSubtitlesFallback } from '../subtitles.js';
import { fetchTmdbMetadata } from '../tmdb.js';
import { APPROVED_SOURCES } from './index.js';
import { normalizeLang } from './lang.js';
import { candidateEvidence, cachedCandidateEvidence, cachedCandidateEvidenceAgeMs, diagnoseCandidatePlayback, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { durationFits, durationToleranceSec } from './duration.js';
import { installNetTap, summarizeNet, tapRequests } from './net-tap.js';
import { selectPlaybackCandidates, MAX_LISTED_SOURCES, MAX_SEPARATE_DUBS } from './selection.js';
// Raised for a 4 GB container (was 256). One row is a resolved title's
// candidates; 1024 of those is the difference between every viewer in a
// spike re-resolving the same episode and the first one paying for it.
const MAX_ADAPTER_CACHE_ENTRIES = 1024;
const ADAPTER_CACHE_TTL_MS = 4 * 60_000;
/** Tiny collection grace; slow sources are returned by the existing late-wave path. */
const EARLY_GRACE_MS = 150;
/** First playable resolution never waits for a broad source board. */
const MIN_JOIN_MS = 350;
/** Floor for one probe window; an inconclusive lane stays available as fallback. */
const PROBE_MIN_WINDOW_MS = 1000;
/** Upper bound for the first answer when no adapter has produced candidates yet. */
const ADAPTER_RACE_MS = 1800;
/** Window for a single-adapter recovery call (`?source=source-N`). */
const SINGLE_SOURCE_BUDGET_MS = 6500;
/** End-to-end budget for one playback resolve (operator tunable, 3 s floor). */
/** Diagnostics only: the environment variable that can switch each source off. */
const resolveBudgetMs = () => {
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
const MAX_WAVE_TITLES = 256;
const MAX_WAVE_BYTES = 32 * 1024 * 1024;
function candidateSingleAudioLang(candidate) {
    const verified = candidate.audioLang;
    if (verified && normalizeLang(verified).code !== 'und')
        return verified;
    return candidate.claimedAudioLang || verified || 'und';
}
export class SourceRegistry {
    adapters;
    cfg;
    /**
     * Per-source health and operator switches. Health is recorded and displayed
     * only: failures never remove a source by themselves. The single thing that
     * takes a source out of rotation is an operator switching it off in the panel.
     */
    health;
    ramCache = new PolicyCache(MAX_ADAPTER_CACHE_ENTRIES);
    inFlight = new Map();
    segmentCache = new PolicyCache(MAX_ADAPTER_CACHE_ENTRIES);
    segmentInFlight = new Map();
    /** Short-lived discovery-wave state, independent of optional payload caches. */
    finishedLate = new Map();
    finishedLateBytes = 0;
    /**
     * Why the last resolve came back empty, when it was us and not the title.
     * The resolver reports this so "no streams" never silently means "every
     * source was switched off".
     */
    lastEmptyReason = null;
    constructor(cfg) {
        this.cfg = cfg;
        this.health = new SourceHealthStore(process.env.ROXY_DATA_DIR || path.join(process.cwd(), 'data'));
        // Record what each adapter actually talked to, so a resolve that yields
        // nothing can explain itself in the console.
        installNetTap();
        // The board is the manifest, and nothing else. An adapter that is not in
        // APPROVED_SOURCES cannot serve traffic, and one that is there has passed
        // backend/test/source-contract.mjs — real titles, a real manifest, real
        // segment bytes. Thirty adapters that answer nothing is worse than none,
        // because the console reports coverage instead of streams.
        this.adapters = APPROVED_SOURCES.map((source) => source.create());
    }
    /**
     * Which adapters are off, and which environment variable turned each one off.
     * A stale `.env` kept from an older install is the single most common reason a
     * source "disappears", so the answer belongs in the boot log.
     */
    describeSources() {
        const enabled = [];
        const disabled = [];
        for (const adapter of this.adapters) {
            if (adapter.enabled())
                enabled.push(adapter.id);
            else {
                const definition = APPROVED_SOURCES.find((source) => source.id === adapter.id);
                disabled.push({ id: adapter.id, flag: definition?.envFlag ?? '(configured off)' });
            }
        }
        return { enabled, disabled };
    }
    /**
     * Ask every enabled adapter for one title directly, with a fresh request log.
     * Used by the boot self-test and by operators diagnosing an empty list.
     */
    async selfTestAll(params) {
        // Share one lazy metadata lookup just as the playback resolver does. Anime
        // adapters cannot correctly resolve an episode without TMDB metadata.
        let metaPromise;
        const resolveMetaFallback = () => (metaPromise ??= fetchTmdbMetadata(this.cfg.tmdb, params));
        return Promise.all(this.adapters
            .filter((adapter) => adapter.enabled())
            .map(async (adapter) => {
            const started = Date.now();
            if (params.type === 'movie' && adapter.traits?.includes('animeEpisode')) {
                return { id: adapter.id, raw: 0, ms: 0, net: '0 req', skipped: 'TV anime only' };
            }
            const query = {
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
            }
            catch (err) {
                return {
                    id: adapter.id,
                    raw: 0,
                    ms: Date.now() - started,
                    net: `threw ${err instanceof Error ? err.name : 'Error'}`,
                };
            }
        }));
    }
    listPublicSources() {
        // Operator switches and cooldowns are reported separately by `health`, so this
        // keeps listing what is *configured*: the panel decides how to show it.
        return this.adapters.filter((a) => a.enabled()).map((a) => ({ id: a.id, label: a.label }));
    }
    /**
     * Operator diagnostics: resolve one title through every adapter WITHOUT the
     * response cache, reporting discovered candidates, manifest reachability,
     * and bounded media-segment probes. Contains no upstream URLs or headers.
     */
    async diagnosePlayback(params) {
        const diag = [];
        const query = {
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
        const diagnosticCandidates = new Map();
        /** Every lane this diagnostics run verified as working, listed or not. */
        const diagnosticProbedAlive = new Set();
        /** Every lane this diagnostics run confirmed dead, listed or not. */
        const diagnosticProbedDead = new Set();
        const diagnosticRaw = new Map();
        const adapters = await Promise.all(this.adapters
            .filter((a) => a.enabled())
            .map(async (adapter) => {
            const t0 = Date.now();
            try {
                const result = await adapter.resolve(query);
                const raw = result.candidates;
                diagnosticRaw.set(adapter.id, raw);
                const { candidates: verified, verifiedAliveCount, probedAlive: probeAlive, probedDead: probeDead } = await verifyAndFilterCandidatesDetailed(raw);
                diagnosticCandidates.set(adapter.id, verified);
                for (const url of probeAlive)
                    diagnosticProbedAlive.add(url);
                for (const url of probeDead)
                    diagnosticProbedDead.add(url);
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
                    types: verified.reduce((acc, c) => {
                        acc[c.type] = (acc[c.type] ?? 0) + 1;
                        return acc;
                    }, {}),
                    error: null,
                };
            }
            catch (err) {
                return {
                    id: adapter.id,
                    ms: Date.now() - t0,
                    raw: 0,
                    retained: 0,
                    manifestReachable: 0,
                    manifestMultiAudio: 0,
                    types: {},
                    error: err instanceof Error ? err.name : 'error',
                };
            }
        }));
        const entries = this.adapters.flatMap(adapter => (diagnosticCandidates.get(adapter.id) ?? []).map(candidate => ({ adapter, candidate })));
        const selectedEntries = selectPlaybackCandidates(entries, params.preferredLang);
        const selected = selectedEntries.map(({ adapter, candidate }) => ({
            sourceId: adapter.id,
            fingerprint: crypto.createHmac('sha256', this.cfg.secret).update(candidate.url).digest('hex').slice(0, 12),
            multiAudio: !!candidate.multiAudio,
            languages: candidate.availableAudioLangs ?? [],
            manifestReachable: !!cachedCandidateEvidence(candidate)?.alive,
        }));
        // Check the first stream the resolver would offer from each source, then
        // spend any remaining small budget on a Hindi-labeled alternate. This is
        // deliberately about real selected candidates, not arbitrary root domains.
        const samples = [];
        const seenUrls = new Set();
        const addSample = (adapter, candidate) => {
            if (!candidate || seenUrls.has(candidate.url) || samples.length >= 8)
                return;
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
        const playbackChecks = [];
        for (let offset = 0; offset < samples.length; offset += 4) {
            const batch = await Promise.all(samples.slice(offset, offset + 4).map(async ({ adapter, candidate }) => ({
                sourceId: adapter.id,
                fingerprint: crypto.createHmac('sha256', this.cfg.secret).update(candidate.url).digest('hex').slice(0, 12),
                type: candidate.type,
                claimedAudio: candidate.claimedAudioLang ?? candidate.audioLang ?? null,
                check: await diagnoseCandidatePlayback(candidate),
            })));
            playbackChecks.push(...batch);
        }
        // Per-lane health for the diagnostics view. Verification happens on copies
        // of the raw candidates, so match them back by URL: a lane's health has to
        // come from what this run probed, not only from a cache.
        const verifiedByUrl = new Map();
        for (const list of diagnosticCandidates.values())
            for (const v of list)
                verifiedByUrl.set(v.url, v);
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
        return { adapters, lanes, selected, playbackChecks, policy: { maxListedSources: MAX_LISTED_SOURCES, maxSeparateDubs: MAX_SEPARATE_DUBS, multiAudioRequiresManifestLanguages: 2, playbackChecksAreServerSide: true, browserPlaybackChecked: false, note: 'A range read confirms the backend can retrieve a small sample media segment. It does not prove browser playback; proxy delivery is reported as planned, not exercised.' } };
    }
    getCachedAdapterResult(key) {
        const entry = this.ramCache.get(key);
        if (!entry)
            return null;
        if (Date.now() > entry.expiresAt) {
            this.ramCache.delete(key);
            return null;
        }
        this.ramCache.delete(key);
        this.ramCache.set(key, entry);
        return entry.result;
    }
    setCachedAdapterResult(key, result) {
        if (!result.candidates.length)
            return;
        this.ramCache.set(key, {
            expiresAt: Date.now() + ADAPTER_CACHE_TTL_MS,
            result,
        });
    }
    resolveAdapterWithCache(adapter, baseKey, query, onLateResult, onOrigin) {
        const cached = this.getCachedAdapterResult(baseKey);
        if (cached) {
            onOrigin?.('cache');
            return Promise.resolve(cached);
        }
        const existing = this.inFlight.get(baseKey);
        if (existing) {
            onOrigin?.('shared');
            return existing;
        }
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
    resolveSegmentsWithCache(adapter, baseKey, query) {
        if (!adapter.resolveSegments)
            return Promise.resolve(undefined);
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
        if (existing)
            return existing;
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
    async resolvePlayback(params) {
        const resolveStartedAt = Date.now();
        // One end-to-end budget, not additive provider + liveness + metadata waits.
        const lateOnly = params.late === true;
        // A recovery call for one adapter is not first paint: nothing is waiting on
        // it, and its only job is completeness. Cutting it at the shared 3.6 s race
        // meant slow-but-working adapters (a 2.6 s catalogue fetch plus a lane fetch)
        // never appeared in the list at all.
        const singleSource = typeof params.sourceId === 'string' && params.sourceId.length > 0;
        const deadline = resolveStartedAt +
            (lateOnly ? 2_200 : params.anilistId ? 7_000 : singleSource ? SINGLE_SOURCE_BUDGET_MS : resolveBudgetMs());
        // Fairness window for the adapter race (see EARLY_GRACE_MS / MIN_JOIN_MS).
        const remaining = () => Math.max(0, deadline - Date.now());
        const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
        // Only an operator switch removes a source here. A source that has failed
        // every time for a week is still asked, because nothing here may decide on
        // its own that a provider is finished — that judgment belongs to the person
        // reading the panel.
        const activeAdapters = this.adapters.filter((a) => a.enabled() &&
            this.health.shouldAttempt(a.id) &&
            (!params.sourceId || a.id === params.sourceId));
        const switchedOff = this.adapters.filter((a) => a.enabled() && !this.health.shouldAttempt(a.id) && (!params.sourceId || a.id === params.sourceId));
        this.lastEmptyReason = null;
        if (!activeAdapters.length) {
            // Nothing to try. Reported up so the resolver can say *why* the answer is
            // empty, instead of letting it read like "this title has no sources".
            if (switchedOff.length) {
                this.lastEmptyReason = `${switchedOff.length} source(s) switched off by the operator`;
            }
            return null;
        }
        const streamBase = '/api/v1/stream';
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
        let readyMedia;
        void mediaPromise.then((m) => { readyMedia = m; }).catch(() => { });
        const subtitleState = { value: null };
        // Warm OpenSubtitles fallback concurrently as soon as TMDB resolves `imdbId`
        const earlyOpenSubsPromise = this.cfg.subtitles?.enabled
            ? mediaPromise
                .then((m) => m.imdbId
                ? fetchOpenSubtitlesFallback(this.cfg.subtitles, {
                    type: params.type,
                    imdbId: m.imdbId,
                    season: params.season,
                    episode: params.episode,
                })
                : null)
                .catch(() => null)
            : Promise.resolve(null);
        void earlyOpenSubsPromise.then((subs) => { subtitleState.value = subs; }).catch(() => { });
        const query = {
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
        // A lane that aggregates several upstreams before it can answer asks for a
        // longer, bounded discovery signal (see SourceAdapter.discoveryTimeoutMs).
        // This never extends the first-list or focused-request deadline and never
        // detaches a caller-supplied cancellation signal inside the adapter.
        const queryFor = (adapter) => {
            const budget = adapter.discoveryTimeoutMs;
            if (!budget || budget <= this.cfg.resolveTimeoutMs)
                return query;
            return { ...query, signal: AbortSignal.timeout(budget) };
        };
        // Launch all active adapters in parallel; if one adapter finishes quickly with candidates
        // while another is stuck in a multi-second upstream cold scan (>2.6s slower), proceed early
        // once fast candidates pass verification while letting the slower adapter warm `ramCache` in background!
        // Declared here so every later pass (late join, verification order, anime
        // priority) asks the adapter what it is instead of checking a list of ids.
        const isAnimeLane = (adapter) => adapter.traits?.includes('animeEpisode') === true;
        const priorityIds = new Set(activeAdapters.filter(isAnimeLane).map((adapter) => adapter.id));
        const slots = activeAdapters.map(() => null);
        let doneCount = 0;
        let firstWithCandidatesDone = false;
        let earlyRelease = null;
        let lagTimer = null;
        const cacheKeys = activeAdapters.map((adapter) => `${adapter.id}:${params.type}:${params.tmdbId}:${params.anilistId ?? ''}:${params.anilistEpisode ?? 0}:${params.season ?? 0}:${params.episode ?? 0}`);
        // Segment lookup is deliberately independent of the adapter race. A fast
        // Source 2 response must not discard Source 1's slower intro/outro metadata.
        const segmentResults = activeAdapters.map(() => undefined);
        const segmentTasks = activeAdapters.map((adapter, idx) => this.resolveSegmentsWithCache(adapter, cacheKeys[idx], query)
            .then((value) => { segmentResults[idx] = value; }).catch(() => { }));
        // Per-adapter outcome, kept for the "nothing resolved" report: with ten
        // sources, "which one failed and why" must be readable from the log.
        const adapterReport = new Map();
        const adapterNet = new Map();
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
                if (hit)
                    slots[idx] = { adapter, result: hit.result };
            });
        }
        // One shared retry for adapters that explicitly finished empty. This is
        // asynchronous and coalesced per title/source, not N rediscovery requests
        // per viewer. In-flight and nonempty providers are never restarted here.
        if (lateOnly && params.retryMissing && currentWave) {
            activeAdapters.forEach((adapter, idx) => {
                const existing = currentWave.entries.get(adapter.id);
                if (!existing || existing.result.candidates.length || currentWave.retried.has(adapter.id) || this.inFlight.has(cacheKeys[idx]))
                    return;
                currentWave.retried.add(adapter.id);
                void this.resolveAdapterWithCache(adapter, cacheKeys[idx], queryFor(adapter), result => {
                    this.recordWaveResult(lateKey, currentWave, adapter, result);
                }).then(result => {
                    this.recordWaveResult(lateKey, currentWave, adapter, result);
                    if (result.candidates.length)
                        this.health.recordSuccess(adapter.id);
                }).catch(() => { });
            });
        }
        const adapterTasks = lateOnly ? [] : activeAdapters.map(async (adapter, idx) => {
            const cacheKey = cacheKeys[idx];
            const startedAt = Date.now();
            let origin = 'fresh';
            try {
                const tapped = await tapRequests(() => this.resolveAdapterWithCache(adapter, cacheKey, queryFor(adapter), result => {
                    if (currentWave)
                        this.recordWaveResult(lateKey, currentWave, adapter, result);
                }, value => { origin = value; }));
                const result = tapped.value;
                adapterNet.set(adapter.id, tapped.net);
                slots[idx] = { adapter, result };
                if (currentWave)
                    this.recordWaveResult(lateKey, currentWave, adapter, result);
                adapterReport.set(adapter.id, { ms: Date.now() - startedAt, raw: result.candidates.length });
                // Learn from what actually happened. "No candidates" is not a failure —
                // that provider may simply not carry this title — so only a throw or an
                // explicit error marks a source unhealthy.
                if (result.candidates.length > 0)
                    this.health.recordSuccess(adapter.id);
                if (!result.candidates.length) {
                    console.warn(`[elfura-sources] ${adapter.id} ${params.type}/${params.tmdbId}: 0 candidates in ` +
                        `${Date.now() - startedAt}ms :: ${summarizeNet(tapped.net)} (observed global fetch; lookup=${origin})`);
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
            }
            catch (err) {
                const name = err instanceof Error ? err.name : 'Error';
                adapterReport.set(adapter.id, { ms: Date.now() - startedAt, error: name });
                this.health.recordFailure(adapter.id, name);
            }
            finally {
                doneCount++;
                if (doneCount >= activeAdapters.length) {
                    earlyRelease?.();
                }
            }
        });
        if (!lateOnly) {
            await Promise.race([
                Promise.allSettled(adapterTasks),
                new Promise((r) => {
                    earlyRelease = r;
                }),
                wait(singleSource ? remaining() : Math.min(ADAPTER_RACE_MS, remaining())),
            ]);
        }
        if (lagTimer)
            clearTimeout(lagTimer);
        // Confirmed Japanese animation prioritizes anime lanes during verification,
        // but it never extends the first-paint wait for unfinished providers.
        const isPriorityAnime = () => params.type === 'tv' && (params.season ?? 1) === 1 &&
            readyMedia?.originalLanguage === 'ja' &&
            !!readyMedia.genres?.some(g => g.toLowerCase() === 'animation');
        const verifyCurrentSlots = async (probeFloorMs = PROBE_MIN_WINDOW_MS) => {
            const ready = slots.filter((x) => x !== null);
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
            if (isPriorityAnime())
                ready.sort((a, b) => Number(priorityIds.has(b.adapter.id)) - Number(priorityIds.has(a.adapter.id)));
            const perAdapter = ready.map((entry) => {
                const byLanguage = new Map();
                for (const cand of entry.result.candidates) {
                    const lang = cand.claimedAudioLang ?? cand.audioLang ?? '';
                    const bucket = byLanguage.get(lang);
                    if (bucket)
                        bucket.push(cand);
                    else
                        byLanguage.set(lang, [cand]);
                }
                if (byLanguage.size < 2)
                    return entry.result.candidates;
                const ordered = [];
                const buckets = [...byLanguage.values()];
                const maxBucket = Math.max(...buckets.map((bucket) => bucket.length));
                for (let i = 0; i < maxBucket; i += 1) {
                    for (const bucket of buckets)
                        if (bucket[i])
                            ordered.push(bucket[i]);
                }
                return ordered;
            });
            const breadth = Math.max(2, Math.floor(VERIFY_BREADTH_TARGET / Math.max(1, perAdapter.length)));
            const tagged = [];
            for (let i = 0; i < breadth; i += 1) {
                for (let adapterIdx = 0; adapterIdx < perAdapter.length; adapterIdx += 1) {
                    const cand = perAdapter[adapterIdx][i];
                    if (cand)
                        tagged.push({ ...cand, key: `${adapterIdx}::${cand.key}` });
                }
            }
            const { candidates: vFlat, verifiedAliveCount, probedDead } = await verifyAndFilterCandidatesDetailed(tagged,
            // The probe decides whether a title is playable at all, so it gets a
            // real floor even when the response budget is nearly spent. Collapsing
            // this to a few milliseconds turned short budgets into empty lists.
            AbortSignal.timeout(Math.max(lateOnly ? 900 : probeFloorMs, Math.min(lateOnly ? 1_200 : 1_100, remaining()))), isPriorityAnime() ? new Set(tagged.filter(c => {
                const idx = Number(c.key.slice(0, c.key.indexOf('::')));
                return priorityIds.has(ready[idx].adapter.id);
            }).map(c => c.url)) : undefined);
            const byIdx = new Map();
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
        // Verify what has arrived; unfinished providers stay in the late wave.
        // Only when no candidate has verified may we spend one short extra window
        // on pending discovery, regardless of AniList or source-board size.
        let verifiedBatch = await verifyCurrentSlots();
        const hasUnverifiedCandidate = verifiedBatch.entries.some(({ result }) =>
            result.candidates.some(candidate => !verifiedBatch.probedDead.has(candidate.url)));
        if (!lateOnly && verifiedBatch.verifiedLive === 0 && !hasUnverifiedCandidate &&
            doneCount < activeAdapters.length && remaining() > 400) {
            // If every arrived lane is confirmed dead, allow a little longer for
            // one alternative. With no lane at all, use a shorter bound. Never
            // wait on the full board when an unknown playable fallback exists.
            const maxWait = verifiedBatch.probedDead.size ? 1800 : 1400;
            const waitBudget = Math.min(maxWait, Math.max(0, remaining() - 100));
            await Promise.race([Promise.allSettled(adapterTasks), wait(waitBudget)]);
            verifiedBatch = await verifyCurrentSlots();
        }
        // Metadata, skip markers and subtitles are enrichments; let only the
        // already-finished requests join the first response. Slow lookups keep
        // warming in the background and never add dead air, even if verification
        // could not confirm a source yet.
        if (!lateOnly && remaining() > 0) {
            await Promise.race([
                Promise.allSettled([mediaPromise, ...segmentTasks]),
                wait(Math.min(100, remaining())),
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
            console.warn(`[elfura-sources] ${Date.now() - resolveStartedAt}ms ${params.type}/${params.tmdbId} ${perSource.join(' ')}`);
        }
        const uniformOptions = [];
        let mergedSegments;
        for (const segments of segmentResults)
            if (!mergedSegments && segments)
                mergedSegments = segments;
        const candidateEntries = [];
        // A runtime mismatch may mean a trailer or wrong episode, but metadata and
        // playlist measurements are not conclusive. Treat it as a fallback.
        const expectedRuntimeSec = media.runtime && media.runtime > 0 ? media.runtime * 60 : null;
        const runtimeToleranceSec = durationToleranceSec(params.type, expectedRuntimeSec);
        const droppedByRuntime = [];
        // Lanes the runtime guard rejected stay rejected: the coverage pass below
        // must not smuggle a wrong-length clip back into the list.
        const blockedByRuntime = new Set();
        // Streams whose measured duration does not match, kept as a last-resort rail
        // rather than deleted (see the guard below).
        const wrongRuntime = [];
        /** Lanes this request probed and confirmed dead (see verifyAndFilterCandidatesDetailed). */
        const probedDeadHere = verifiedBatch.probedDead;
        const allLiveCandidates = [];
        // Escape hatch for an operator who would rather see a wrong-length stream
        // than no stream at all.
        const runtimeGuardEnabled = process.env.ELFURA_RUNTIME_GUARD !== '0';
        for (const { adapter, result, liveCandidates } of verifiedEntries) {
            if (!mergedSegments && result.segments)
                mergedSegments = result.segments;
            if (!media.title && result.metaHint?.title) {
                media.title = params.type === 'tv' && params.season && params.episode
                    ? `${result.metaHint.title} · S${params.season}E${params.episode}` : result.metaHint.title;
            }
            if (!media.year && result.metaHint?.year)
                media.year = result.metaHint.year;
            if (!media.imdbId && result.metaHint?.imdbId)
                media.imdbId = result.metaHint.imdbId;
            for (const cand of liveCandidates) {
                allLiveCandidates.push({ adapter, candidate: cand });
                // This request measured the runtime a moment ago; the cache may be off.
                const measuredSec = cand.measuredThisRequest?.durationSec ?? cachedCandidateEvidence(cand)?.durationSec ?? null;
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
                candidateEntries.push({ adapter, candidate: cand });
                if (cand.standbyUrl && cachedCandidateEvidence({ ...cand, url: cand.standbyUrl, headers: cand.standbyHeaders ?? cand.headers })?.alive) {
                    candidateEntries.push({ adapter, candidate: { ...cand, key: `${cand.key}#standby`, fingerprint: `${cand.fingerprint || cand.key}#standby`, url: cand.standbyUrl, headers: cand.standbyHeaders ?? cand.headers, standbyUrl: undefined, standbyHeaders: undefined } });
                }
            }
        }
        // A filter must never be able to empty the list. If the runtime guard would
        // remove every verified stream, the measurement or the expected runtime is
        // wrong — keep them all and say so, because "no sources" is never better.
        if (droppedByRuntime.length && !candidateEntries.length && allLiveCandidates.length) {
            console.warn(`[elfura-resolve] runtime guard DISABLED for ${params.type}/${params.tmdbId}: it would have ` +
                `removed every verified stream (expected ${Math.round((expectedRuntimeSec ?? 0) / 60)}min ` +
                `±${Math.round(runtimeToleranceSec / 60)}min; measured ` +
                `${droppedByRuntime.map((row) => `${Math.round(row.measuredSec / 60)}min`).join(',') || 'none'}). ` +
                `Keeping them all.`);
            for (const entry of allLiveCandidates)
                candidateEntries.push(entry);
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
                if (!slot)
                    continue;
                let added = 0;
                for (const cand of slot.result.candidates) {
                    if (added >= MAX_LANES_PER_SOURCE)
                        break;
                    if (seenUrls.has(cand.url) || blockedByRuntime.has(cand.url))
                        continue;
                    // A probe run during this request speaks with the same authority as a
                    // remembered one: a lane it confirmed dead must not come back just
                    // because the cache that would have remembered that is switched off.
                    if (probedDeadHere.has(cand.url))
                        continue;
                    const evidence = cachedCandidateEvidence(cand);
                    if (evidence && !evidence.alive)
                        continue;
                    const measured = cand.measuredThisRequest;
                    const durationHere = measured?.durationSec ?? evidence?.durationSec ?? null;
                    const aliveHere = measured?.alive || !!evidence?.alive;
                    if (runtimeGuardEnabled && aliveHere && !durationFits(durationHere, expectedRuntimeSec, runtimeToleranceSec))
                        continue;
                    seenUrls.add(cand.url);
                    candidateEntries.push({ adapter: slot.adapter, candidate: cand });
                    added += 1;
                    appended += 1;
                }
            }
            if (appended) {
                console.info(`[elfura-resolve] ${params.type}/${params.tmdbId}: listed ${appended} extra lane(s) ` +
                    `beyond the verified set (per-source cap ${MAX_LANES_PER_SOURCE}, verified first).`);
            }
        }
        // Close the list with wrong-length streams: they are real, they play, and
        // they are better than nothing when every correctly-timed lane is blocked.
        for (const entry of wrongRuntime) {
            if (!candidateEntries.some((existing) => existing.candidate.url === entry.candidate.url)) {
                candidateEntries.push(entry);
            }
        }
        const counts = new Map();
        const sequences = new Map();
        // A lane whose runtime this request measured and matched is tier 0; one that
        // could not be measured at all is tier 1. Without this the sort falls through
        // to latency, and a fast unmeasured clip outranks the verified episode.
        const verifiedRuntimeUrls = new Set(candidateEntries
            .filter((entry) => {
            const cand = entry.candidate;
            const measured = cand.measuredThisRequest?.durationSec ?? cachedCandidateEvidence(cand)?.durationSec ?? null;
            return measured !== null && durationFits(measured, expectedRuntimeSec, runtimeToleranceSec);
        })
            .map((entry) => entry.candidate.url));
        const rankHint = (url) => (verifiedRuntimeUrls.has(url) ? 0 : 1);
        for (const { adapter, candidate } of selectPlaybackCandidates(candidateEntries, params.preferredLang, rankHint)) {
            if (!counts.has(adapter.id))
                counts.set(adapter.id, new Map());
            const seq = (sequences.get(adapter.id) ?? 0) + 1;
            sequences.set(adapter.id, seq);
            const option = this.sealCandidate(adapter, candidate, seq, counts.get(adapter.id), streamBase);
            const evidence = candidateEvidence(candidate);
            const duration = evidence?.durationSec ?? null;
            if (isPriorityAnime() && !evidence?.alive)
                option.animeUnverified = true;
            if (isPriorityAnime() && priorityIds.has(adapter.id) && evidence?.alive &&
                durationFits(duration, expectedRuntimeSec, runtimeToleranceSec))
                option.animePriority = true;
            uniformOptions.push(option);
        }
        if (droppedByRuntime.length) {
            console.warn(`[elfura-resolve] runtime mismatch: ${droppedByRuntime.length} stream(s) considered as fallback before deduplication/selection for ` +
                `${params.type}/${params.tmdbId} (expected ${Math.round((expectedRuntimeSec ?? 0) / 60)}min ±` +
                `${Math.round(runtimeToleranceSec / 60)}min) :: ` +
                droppedByRuntime.map((row) => `${row.id}@${Math.round(row.measuredSec / 60)}min`).join(' '));
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
                if (!report)
                    return `${adapter.id}: no-result (still running at ${Date.now() - resolveStartedAt}ms)`;
                return `${adapter.id}: raw=${report.raw ?? '?'} ${report.error ? `error=${report.error}` : 'returned-empty'} ${report.ms}ms`;
            })
                .join(' | ');
            console.warn(`[elfura-resolve] NO STREAMS type=${params.type} tmdb=${params.tmdbId} s=${params.season ?? '-'} e=${params.episode ?? '-'} meta=${media.title ? 'ok' : 'missing'} ms=${Date.now() - resolveStartedAt} :: ${detail}`);
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
                    url: `${streamBase}?t=${encodeURIComponent(sealStreamTicket(this.cfg.secret, { u: s.url, h: s.headers }))}`,
                }));
                for (const opt of uniformOptions) {
                    const lane = this.adapters.find((adapter) => adapter.id === opt.sourceId);
                    if (lane?.traits?.includes('animeEpisode') && opt.subtitles.length) {
                        const existing = new Set(opt.subtitles.map(track => track.lang));
                        opt.subtitles = [...opt.subtitles, ...sealedFallbackSubs.filter(track => !existing.has(track.lang))];
                    }
                    else {
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
                format: 'vtt',
                url: `${streamBase}?t=${encodeURIComponent(sealStreamTicket(this.cfg.secret, { u: track.url, h: track.headers }))}`,
            }));
            for (const opt of uniformOptions) {
                const already = new Set((opt.subtitles ?? []).map((track) => track.lang));
                const added = sealedVidly.filter((track) => !already.has(track.lang));
                // Never overwrite a language we already have: OpenSubtitles wins.
                if (added.length)
                    opt.subtitles = [...(opt.subtitles ?? []), ...added];
            }
        }
        // Hierarchy: genuine multi-audio streams (several languages muxed in one
        // manifest) lead, then multi-quality ABR streams (a real rendition
        // ladder), then known single-quality streams, and only then streams
        // whose quality is unknown. Stable within each tier.
        const qualityTierOf = (o) => {
            const n = o.qualityLadder?.length ?? o.qualityOptions ?? 0;
            if (n > 1)
                return 0;
            if (n === 1 || (o.quality && o.quality !== 'auto'))
                return 1;
            return 2;
        };
        const animeVariantTier = (o, language) => {
            if (!o.audioVariant)
                return 2;
            const primary = language ? normalizeLang(language).code.split('-')[0] : '';
            const preferred = primary === 'en' ? 'dub' : 'sub';
            return o.audioVariant === preferred ? 0 : 1;
        };
        if (!params.preferredLang) {
            uniformOptions.sort((a, b) => Number(!!a.animeUnverified) - Number(!!b.animeUnverified) ||
                Number(!!b.animePriority) - Number(!!a.animePriority) ||
                Number(!!b.multiAudio) - Number(!!a.multiAudio) ||
                qualityTierOf(a) - qualityTierOf(b) ||
                animeVariantTier(a) - animeVariantTier(b));
        }
        // When a preferred audio language is requested, promote matching streams
        // across ALL active adapters ordered dynamically by real server speed —
        // explicitly treating Multi-Audio streams that carry `prefCode` as top-tier
        // citizens alongside direct dubs (with a -65ms ABR CDN bonus over slow single-dub re-encodes).
        if (params.preferredLang) {
            const prefCode = normalizeLang(params.preferredLang).code;
            if (prefCode && prefCode !== 'und') {
                const prefPrimary = prefCode.split('-')[0];
                // 0 = this stream carries the requested language, 1 = it does not say,
                // 2 = it carries something else.
                //
                // There used to be a rung between "carries it" and "does not say" that
                // held provider LABELS — a single-dub row claiming "Hindi" scored 1, a
                // manifest-verified multi-audio set containing "en" scored 0, and a row
                // that merely CLAIMED "en" also scored 1. The intent was to rank a
                // measurement above a claim, but the effect was worse than the problem:
                // a 5302MB stream whose language was a CLAIM lost the primary slot to a
                // 2023MB stream the size rule should have beaten purely on bytes.
                //
                // The owner's rule is explicit — "within the requested language, the
                // biggest stream should open" — and it cannot hold if a claim and a
                // measurement of the SAME language sit in different tiers, because the
                // tier is compared before the size. So the rung is gone.
                //
                // Nothing is weakened by removing it. A claim is compared against a
                // measurement only AFTER the response has established that both carry
                // the requested language, and the response already distinguishes them:
                // `audioLang` is verified, `claimedAudioLang` is labelled, and the player
                // is told which is which. Ordering by size inside one language is exactly
                // what the rule asks for.
                const scoreOpt = (opt) => {
                    const direct = opt.audioLang?.split('-')[0] === prefPrimary;
                    const multi = !!opt.availableAudioLangs?.some((l) => l.split('-')[0] === prefPrimary);
                    const claimed = opt.claimedAudioLang?.split('-')[0] === prefPrimary;
                    if (direct || multi || claimed)
                        return 0;
                    if (opt.multiAudio && !opt.availableAudioLangs?.length)
                        return 1;
                    return 2;
                };
                const effectiveSpeedMs = (opt) => {
                    const base = opt.latencyHintMs ?? 550;
                    return opt.multiAudio ? base - 65 : base;
                };
                // Size is part of this sort, not only of the earlier one. This pass used
                // to run purely on latency and silently overwrite the size order, which
                // is how a 400MB stream became primary over a 1376MB one in the same
                // language. A stream with no measurement sorts below a measured one.
                const sizeDesc = (opt) => typeof opt.measuredBytes === 'number' && opt.measuredBytes > 0 ? opt.measuredBytes : -1;
                uniformOptions.sort((a, b) => scoreOpt(a) - scoreOpt(b) ||
                    Number(!!a.animeUnverified) - Number(!!b.animeUnverified) ||
                    Number(!!b.animePriority) - Number(!!a.animePriority) ||
                    animeVariantTier(a, prefCode) - animeVariantTier(b, prefCode) ||
                    sizeDesc(b) - sizeDesc(a) ||
                    qualityTierOf(a) - qualityTierOf(b) ||
                    effectiveSpeedMs(a) - effectiveSpeedMs(b));
            }
        }
        const resolveMs = Date.now() - resolveStartedAt;
        if (resolveMs > 8000) {
            console.warn(`[elfura-resolve] SLOW ${resolveMs}ms type=${params.type} tmdb=${params.tmdbId} options=${uniformOptions.length}`);
        }
        // What the board is actually made of. Mean over the streams that produced a
        // measurement — an unmeasured lane is unknown, and counting it as zero would
        // report a library as tiny when the truth is "nobody measured it".
        const sized = uniformOptions.filter((option) => typeof option.measuredBytes === 'number' && option.measuredBytes > 0);
        const sizeBytes = sized.map((option) => option.measuredBytes);
        const size = sizeBytes.length
            ? {
                meanBytes: Math.round(sizeBytes.reduce((sum, value) => sum + value, 0) / sizeBytes.length),
                maxBytes: Math.max(...sizeBytes),
                measured: sizeBytes.length,
                total: uniformOptions.length,
                ...(params.preferredLang ? { lang: params.preferredLang } : {}),
            }
            : undefined;
        // Did the request for a language actually land? Only meaningful when the
        // caller asked for one and something is being offered.
        let languageFallback;
        if (params.preferredLang && uniformOptions.length > 0) {
            const requested = normalizeLang(params.preferredLang).code;
            const requestedPrimary = requested.split('-')[0];
            const carries = (option) => {
                const lang = candidateSingleAudioLang(option);
                if (!lang)
                    return false;
                if (lang.split('-')[0] === requestedPrimary)
                    return true;
                return !!option.availableAudioLangs?.some((l) => l.split('-')[0] === requestedPrimary);
            };
            const anyCarries = uniformOptions.some(carries);
            const primaryCarries = carries(uniformOptions[0]);
            if (!anyCarries) {
                languageFallback = { requested, reason: 'no-stream-in-language' };
            }
            else if (!primaryCarries) {
                languageFallback = { requested, reason: 'nothing-played' };
            }
        }
        return {
            ok: true as const,
            media,
            primary: uniformOptions[0],
            sources: uniformOptions,
            ...(size ? { size } : {}),
            ...(languageFallback ? { languageFallback } : {}),
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
    recordWaveResult(key, wave, adapter, result) {
        // Do not resurrect an evicted or expired wave from a stale async completion.
        if (this.finishedLate.get(key) !== wave || Date.now() >= wave.expiresAt)
            return;
        const previous = wave.entries.get(adapter.id);
        const old = previous?.result;
        const candidates = new Map((old?.candidates ?? []).map(c => [c.url, c]));
        for (const candidate of result.candidates)
            candidates.set(candidate.url, candidate);
        const merged = { ...old, ...result, candidates: [...candidates.values()].slice(0, MAX_LANES_PER_SOURCE) };
        // Account for retained payloads as well as title count; enormous provider
        // responses must not pin the heap during a burst of distinct titles.
        let bytes;
        try {
            bytes = Buffer.byteLength(JSON.stringify(merged));
        }
        catch {
            return;
        }
        const delta = bytes - (previous?.bytes ?? 0);
        wave.bytes += delta;
        this.finishedLateBytes += delta;
        wave.entries.set(adapter.id, { adapter, result: merged, bytes });
        this.pruneFinishedLate();
    }
    pruneFinishedLate() {
        const now = Date.now();
        const remove = (key, wave) => {
            this.finishedLate.delete(key);
            this.finishedLateBytes -= wave.bytes;
        };
        for (const [key, wave] of this.finishedLate)
            if (wave.expiresAt <= now)
                remove(key, wave);
        // Bounded by both count and payload bytes. An evicted wave falls back to
        // one fresh lookup rather than permanently losing the viewer's sources.
        while (this.finishedLate.size > MAX_WAVE_TITLES || this.finishedLateBytes > MAX_WAVE_BYTES) {
            const oldest = this.finishedLate.entries().next().value;
            if (!oldest)
                break;
            remove(oldest[0], oldest[1]);
        }
    }
    sealCandidate(adapter, cand, seq, labelCounts, streamBase) {
        // Build strictly anonymized display label using ONLY adapter.label + audio/quality traits
        let trait = '';
        if (adapter.traits?.includes('hardSubtitle') && cand.animeSubtitleMode === 'hard') {
            trait = 'Provider-labelled Hard Sub';
        }
        else if (cand.multiAudio) {
            trait = 'Multi-Audio';
        }
        else if (cand.audioLabel && cand.audioLabel !== 'Original') {
            trait = cand.audioLabel;
        }
        else if (cand.quality && cand.quality !== 'auto') {
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
        const candidateAudioHint = candidateSingleAudioLang(cand);
        const singleDubHint = !cand.multiAudio && candidateAudioHint && candidateAudioHint !== 'und'
            ? candidateAudioHint
            : undefined;
        const proxyOptions = {
            ...(cand.restrictedOrigin ? { restrictedOrigin: cand.restrictedOrigin } : {}),
            ...(singleDubHint ? { audioLang: singleDubHint } : {}),
        };
        const audioTracks = (cand.audioTracks ?? []).map((t) => ({
            lang: t.lang,
            label: t.label,
            url: `${streamBase}?t=${encodeURIComponent(sealStreamTicket(this.cfg.secret, { u: t.url, h: t.headers }))}`,
        }));
        // Only the new anime lane opts into source-specific, episode-aligned
        // subtitles. Keep the existing subtitle policy for every other adapter.
        const subtitles = adapter.traits?.includes('animeEpisode') ? (cand.subtitles ?? []).map((track) => ({
            lang: track.lang,
            label: track.label,
            ...(track.format ? { format: track.format } : {}),
            url: `${streamBase}?t=${encodeURIComponent(sealStreamTicket(this.cfg.secret, { u: track.url, h: track.headers, ...(proxyOptions.restrictedOrigin ? { ro: proxyOptions.restrictedOrigin } : {}), ...(proxyOptions.audioLang ? { l: proxyOptions.audioLang } : {}) }))}`,
        })) : [];
        const latencyHintMs = typeof cand.latencyMs === 'number' && Number.isFinite(cand.latencyMs) && cand.latencyMs > 0
            ? Math.round(cand.latencyMs)
            : undefined;
        return {
            id: `${adapter.id}:${seq}`,
            sourceId: adapter.id,
            label: displayLabel,
            type: cand.type,
            url: `${streamBase}?t=${encodeURIComponent(sealStreamTicket(this.cfg.secret, { u: cand.url, h: cand.headers, ...(proxyOptions.restrictedOrigin ? { ro: proxyOptions.restrictedOrigin } : {}), ...(proxyOptions.audioLang ? { l: proxyOptions.audioLang } : {}) }))}`,
            quality: cand.quality || 'auto',
            ...(cand.qualityLabelsUnreliable ? { qualityLabelsUnreliable: true } : {}),
            ...(cand.qualityLadder?.length ? { qualityLadder: cand.qualityLadder } : {}),
            ...((cand.qualityOptions ?? cand.qualityLadder?.length) !== undefined
                ? { qualityOptions: cand.qualityOptions ?? cand.qualityLadder?.length }
                : {}),
            fingerprint: opaqueFingerprint,
            ...(latencyHintMs !== undefined ? { latencyHintMs } : {}),
            // The measured whole-stream size. The player shows it, and the ranking
            // above already used it; sending it keeps the console honest about *why*
            // a lane came first.
            ...(typeof cand.measuredBytes === 'number' && cand.measuredBytes > 0
                ? { measuredBytes: cand.measuredBytes }
                : {}),
            ...(typeof cand.declaredBitrateBps === 'number' && cand.declaredBitrateBps > 0
                ? { declaredBitrateBps: cand.declaredBitrateBps }
                : {}),
            ...(cand.audioLang ? { audioLang: cand.audioLang } : {}),
            ...(cand.claimedAudioLang && (!cand.audioLang || normalizeLang(cand.audioLang).code === 'und') ? { claimedAudioLang: cand.claimedAudioLang } : {}),
            ...(adapter.traits?.length ? { traits: [...adapter.traits] } : {}),
            ...(cand.audioVariant ? { audioVariant: cand.audioVariant } : {}),
            ...(cand.availableAudioLangs?.length ? { availableAudioLangs: cand.availableAudioLangs } : {}),
            // Multi-audio with no named language is not a claim the player can act on:
            // it offers a language switch with nothing to switch between, which is the
            // unproven provider flag this file already refuses in selection.ts. The
            // board-live gate caught it reaching the player, so it is dropped here at
            // the boundary rather than trusted downstream.
            ...(cand.multiAudio && (cand.availableAudioLangs?.length ?? 0) > 1 ? { multiAudio: true } : {}),
            audioTracks,
            subtitles,
        };
    }
}
