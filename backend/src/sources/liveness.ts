/**
 * Elfura Backend — Parallel Deep Stream Liveness Verifier & Audio Harvester
 * =========================================================================
 * Eliminates dead streams ("master-alive / child-dead" HTML redirects like
 * `cdn.mhbdtv.top`, `403 Forbidden` direct links, expired tokens, 5xx mirrors)
 * BEFORE they ever cross into Part 1 (`UniformPlaybackResponse`), while:
 *   1. Pre-warming `relay.ts`'s bounded RAM manifest cache (`0ms` first load!).
 *   2. Harvesting ALL real `#EXT-X-MEDIA:TYPE=AUDIO` and DASH `<AdaptationSet>`
 *      audio tracks directly from live manifests (zero hardcoded tracks!).
 *   3. Deduplicating probes across shared CDN URLs with a bounded RAM cache
 *      (zero local disk writes, strictly adhering to `RULES.md`).
 */

import {
  extractManifestAudioLangs,
  resolveHlsChildUrl,
  seedManifestRamCache,
  verifyDirectSegmentOffload,
} from '../relay.js';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type { RawStreamCandidate } from './types.js';

const DEFAULT_PROBE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_LIVENESS_CACHE = 512;
const ALIVE_TTL_MS = 150_000;
const DEAD_TTL_MS = 45_000;
const MAX_PROBE_MANIFEST_BYTES = 512 * 1024;

export interface LivenessProbeOutcome {
  alive: boolean;
  confirmedDead: boolean;
  rttMs?: number;
  discoveredAudioLangs?: string[];
  manifestKind?: 'hls-master' | 'hls-media' | 'dash';
  manifestAudioRenditions?: number;
  manifestVideoVariants?: number;
  /** Distinct rendition heights (desc) for multi-quality ABR streams. */
  qualityLadder?: number[];
  /** Number of quality options when known (1 = single fixed quality). */
  qualityOptions?: number;
}

/** Extract the ABR ladder (distinct heights, desc) from an HLS master or DASH MPD. */
export function extractQualityLadder(text: string, isDash: boolean): { ladder: number[]; options: number } {
  const heights = new Set<number>();
  if (isDash) {
    for (const m of text.matchAll(/<Representation\b[^>]*\bheight="(\d+)"/gi)) {
      const h = Number(m[1]);
      if (h > 0) heights.add(h);
    }
    if (!heights.size) {
      // Representations without heights are not a usable quality ladder.
      return { ladder: [], options: 0 };
    }
  } else {
    let variants = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!/^#EXT-X-STREAM-INF\b/i.test(line.trim())) continue;
      variants++;
      const res = line.match(/\bRESOLUTION=\d+x(\d+)\b/i);
      if (res) heights.add(Number(res[1]));
    }
    if (!variants) return { ladder: [], options: 1 };
    // Variants without RESOLUTION are NOT a usable quality ladder (players
    // render them as "0k"): quality stays unknown, never multi-quality.
    if (heights.size < 2) return { ladder: [...heights], options: heights.size };
  }
  const ladder = [...heights].sort((a, b) => b - a);
  return { ladder, options: Math.max(1, ladder.length) };
}

interface CachedLivenessEntry extends LivenessProbeOutcome {
  observedAt: number;
  expiresAt: number;
}

const livenessRamCache = new Map<string, CachedLivenessEntry>();
const livenessInFlight = new Map<string, Promise<LivenessProbeOutcome>>();

function cacheKeyFor(url: string, headers?: Record<string, string>): string {
  return `${url}|${JSON.stringify(headers ?? {})}`;
}

function getCachedLiveness(key: string): CachedLivenessEntry | null {
  const hit = livenessRamCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    livenessRamCache.delete(key);
    return null;
  }
  livenessRamCache.delete(key);
  livenessRamCache.set(key, hit);
  return hit;
}

/** Age of the cached observation; this is not a fresh playback test. */
export function cachedCandidateEvidenceAgeMs(candidate: RawStreamCandidate): number | null {
  const hit = getCachedLiveness(cacheKeyFor(candidate.url, candidate.headers));
  return hit ? Math.max(0, Date.now() - hit.observedAt) : null;
}

/** Report only existing liveness evidence; does not initiate upstream requests. */
export function cachedCandidateEvidence(candidate: RawStreamCandidate): LivenessProbeOutcome | null {
  return getCachedLiveness(cacheKeyFor(candidate.url, candidate.headers));
}

function setCachedLiveness(key: string, outcome: LivenessProbeOutcome): void {
  if (!outcome.alive && !outcome.confirmedDead) return;
  if (livenessRamCache.has(key)) livenessRamCache.delete(key);
  while (livenessRamCache.size >= MAX_LIVENESS_CACHE) {
    const oldest = livenessRamCache.keys().next().value;
    if (oldest === undefined) break;
    livenessRamCache.delete(oldest);
  }
  livenessRamCache.set(key, {
    ...outcome,
    observedAt: Date.now(),
    expiresAt: Date.now() + (outcome.alive ? ALIVE_TTL_MS : DEAD_TTL_MS),
  });
}

async function readBoundedManifest(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractDashAudioLangs(mpdText: string): string[] {
  const out: string[] = [];
  const re = /<AdaptationSet\b[^>]*?(?:contentType|mimeType)="[^"]*audio[^"]*"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mpdText)) !== null) {
    const tag = m[0];
    const langAttr = tag.match(/\blang="([^"]+)"/i)?.[1];
    const labelAttr = tag.match(/\blabel="([^"]+)"/i)?.[1];
    if (!langAttr && !labelAttr) continue;
    const norm = normalizeLang(langAttr || labelAttr, labelAttr);
    if (norm.code && norm.code !== 'und' && !out.includes(norm.code)) {
      out.push(norm.code);
    }
  }
  return out;
}

function pickHlsChildCheckTargets(masterText: string, baseUrl: string): string[] {
  const lines = masterText.split(/\r?\n/);
  let variantUri = '';
  let defaultAudioUri = '';
  let firstAudioUri = '';

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;

    if (/^#EXT-X-MEDIA:/i.test(t) && /TYPE=AUDIO\b/i.test(t)) {
      const uMatch = t.match(/\bURI="([^"]+)"/i)?.[1]?.trim();
      if (uMatch) {
        if (!firstAudioUri) firstAudioUri = uMatch;
        if (/DEFAULT=YES\b/i.test(t) && !defaultAudioUri) defaultAudioUri = uMatch;
      }
      continue;
    }

    if (!variantUri && /^#EXT-X-STREAM-INF\b/i.test(t)) {
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();
        if (!nextLine) continue;
        if (!nextLine.startsWith('#')) variantUri = nextLine;
        break;
      }
    }
  }

  const targets: string[] = [];
  for (const raw of [variantUri, defaultAudioUri || firstAudioUri]) {
    if (!raw) continue;
    try {
      const abs = resolveHlsChildUrl(raw, baseUrl);
      if (isSafeUpstreamUrl(abs) && !targets.includes(abs)) {
        targets.push(abs);
      }
    } catch {
      /* ignore malformed child ref */
    }
  }
  return targets;
}

async function verifyChildHlsPlaylist(
  childUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<'alive' | 'dead' | 'unknown'> {
  const res = await fetch(childUrl, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.any([signal, AbortSignal.timeout(2400)]),
  });
  const finalUrl = res.url || childUrl;
  if (!isSafeUpstreamUrl(finalUrl)) return 'dead';
  if (!res.ok) return res.status === 429 || res.status >= 500 ? 'unknown' : 'dead';

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return 'dead';
  }

  const text = await readBoundedManifest(res, MAX_PROBE_MANIFEST_BYTES);
  const lead = text.trimStart();
  if (!lead.startsWith('#EXTM3U')) return 'dead';
  if (!/#EXTINF\b|#EXT-X-STREAM-INF\b|#EXT-X-MAP\b/i.test(text)) return 'dead';

  if (/#EXT-X-ENDLIST\b/i.test(text)) {
    seedManifestRamCache(childUrl, headers, {
      finalUrl,
      kind: 'hls',
      bodyText: text,
    });
  }
  return 'alive';
}

// A caller with a shorter deadline must not wait for an existing shared
// in-flight probe whose own network timeout is longer.
function awaitProbe(task: Promise<LivenessProbeOutcome>, signal?: AbortSignal): Promise<LivenessProbeOutcome> {
  if (!signal) return task;
  if (signal.aborted) return Promise.resolve({ alive: false, confirmedDead: false });
  return new Promise((resolve) => {
    const aborted = () => finish({ alive: false, confirmedDead: false });
    const finish = (value: LivenessProbeOutcome) => {
      signal.removeEventListener('abort', aborted);
      resolve(value);
    };
    signal.addEventListener('abort', aborted, { once: true });
    void task.then(finish, () => finish({ alive: false, confirmedDead: false }));
  });
}

async function runSingleProbe(
  cand: Pick<RawStreamCandidate, 'url' | 'type' | 'headers'>,
  outerSignal?: AbortSignal,
): Promise<LivenessProbeOutcome> {
  if (!isSafeUpstreamUrl(cand.url)) {
    return { alive: false, confirmedDead: true };
  }

  const key = cacheKeyFor(cand.url, cand.headers);
  const cached = getCachedLiveness(key);
  if (cached) return cached;

  const inflight = livenessInFlight.get(key);
  if (inflight) return awaitProbe(inflight, outerSignal);

  const task = (async (): Promise<LivenessProbeOutcome> => {
    const t0 = performance.now();
    const elapsed = () => Math.max(1, Math.round(performance.now() - t0));
    // A caller can stop waiting at its startup deadline without cancelling the
    // shared 3s network probe. Successful late results warm the liveness cache
    // for background recovery; no new request extends initial playback.
    const sig = AbortSignal.timeout(3000);

    try {
      if (cand.type === 'mp4') {
        const mp4Headers: Record<string, string> = {
          'User-Agent': DEFAULT_PROBE_UA,
          Accept: '*/*',
          Range: 'bytes=0-1023',
          ...(cand.headers ?? {}),
        };
        const res = await fetch(cand.url, {
          method: 'GET',
          headers: mp4Headers,
          redirect: 'follow',
          signal: sig,
        });
        const finalUrl = res.url || cand.url;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        if (!isSafeUpstreamUrl(finalUrl)) {
          const dead = { alive: false, confirmedDead: true };
          setCachedLiveness(key, dead);
          return dead;
        }
        if (
          (!res.ok && res.status !== 206) ||
          ct.includes('text/html') ||
          ct.includes('application/json')
        ) {
          const dead = { alive: false, confirmedDead: true };
          setCachedLiveness(key, dead);
          return dead;
        }
        const ok: LivenessProbeOutcome = {
          alive: true,
          confirmedDead: false,
          rttMs: elapsed(),
          qualityOptions: 1,
        };
        setCachedLiveness(key, ok);
        return ok;
      }

      const manifestHeaders: Record<string, string> = {
        'User-Agent': DEFAULT_PROBE_UA,
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, application/dash+xml, */*;q=0.8',
        ...(cand.headers ?? {}),
      };

      const res = await fetch(cand.url, {
        method: 'GET',
        headers: manifestHeaders,
        redirect: 'follow',
        signal: sig,
      });
      const finalUrl = res.url || cand.url;
      if (!isSafeUpstreamUrl(finalUrl) || !res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        if (isSafeUpstreamUrl(finalUrl) && (res.status === 429 || res.status >= 500)) {
          return { alive: false, confirmedDead: false };
        }
        const dead = { alive: false, confirmedDead: true };
        setCachedLiveness(key, dead);
        return dead;
      }

      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('text/html') || ct.includes('application/xhtml')) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        const dead = { alive: false, confirmedDead: true };
        setCachedLiveness(key, dead);
        return dead;
      }

      const bodyText = await readBoundedManifest(res, MAX_PROBE_MANIFEST_BYTES);
      const lead = bodyText.trimStart();

      if (cand.type === 'dash' || lead.includes('<MPD')) {
        if (!lead.includes('<MPD')) {
          const dead = { alive: false, confirmedDead: true };
          setCachedLiveness(key, dead);
          return dead;
        }
        if (!/\btype\s*=\s*["']dynamic["']/i.test(bodyText)) {
          seedManifestRamCache(cand.url, cand.headers, {
            finalUrl,
            kind: 'dash',
            bodyText,
          });
        }
        const dashLangs = extractDashAudioLangs(bodyText);
        const dashLadder = extractQualityLadder(bodyText, true);
        const ok: LivenessProbeOutcome = {
          alive: true,
          confirmedDead: false,
          rttMs: elapsed(),
          manifestKind: 'dash',
          qualityOptions: dashLadder.options,
          ...(dashLadder.ladder.length ? { qualityLadder: dashLadder.ladder } : {}),
          ...(dashLangs.length ? { discoveredAudioLangs: dashLangs } : {}),
        };
        setCachedLiveness(key, ok);
        return ok;
      }

      if (!lead.startsWith('#EXTM3U')) {
        const dead = { alive: false, confirmedDead: true };
        setCachedLiveness(key, dead);
        return dead;
      }

      // If this is a media playlist directly (not a master playlist), ensure it actually lists segments
      const isMaster = /#EXT-X-STREAM-INF\b/i.test(bodyText);
      if (!isMaster && !/#EXTINF\b|#EXT-X-MAP\b/i.test(bodyText)) {
        const dead = { alive: false, confirmedDead: true };
        setCachedLiveness(key, dead);
        return dead;
      }

      // Verify child variant & default audio playlists so master-alive / child-dead streams
      // (e.g. `cdn.mhbdtv.top` redirecting `audio0.m3u8` to an HTML page) are caught immediately.
      if (isMaster) {
        const childTargets = pickHlsChildCheckTargets(bodyText, finalUrl);
        if (childTargets.length > 0) {
          const childChecks = await Promise.all(
            childTargets.map((cu) =>
              verifyChildHlsPlaylist(cu, manifestHeaders, sig).catch(() => 'unknown' as const),
            ),
          );
          if (childChecks.includes('dead')) {
            const dead = { alive: false, confirmedDead: true };
            setCachedLiveness(key, dead);
            return dead;
          }
          if (childChecks.includes('unknown')) {
            // A slow child is not a dead child; do not poison the cache.
            return { alive: false, confirmedDead: false };
          }
        }
      }

      if (isMaster || /#EXT-X-ENDLIST\b/i.test(bodyText)) {
        seedManifestRamCache(cand.url, cand.headers, {
          finalUrl,
          kind: 'hls',
          bodyText,
        });
      }

      const hlsLangs = extractManifestAudioLangs(bodyText);
      const hlsLadder = isMaster
        ? extractQualityLadder(bodyText, false)
        : { ladder: [] as number[], options: 1 };
      const ok: LivenessProbeOutcome = {
        alive: true,
        confirmedDead: false,
        rttMs: elapsed(),
        manifestKind: isMaster ? 'hls-master' : 'hls-media',
        manifestAudioRenditions: (bodyText.match(/^#EXT-X-MEDIA:.*\bTYPE=AUDIO\b/gim) ?? []).length,
        manifestVideoVariants: (bodyText.match(/^#EXT-X-STREAM-INF\b/gim) ?? []).length,
        qualityOptions: hlsLadder.options,
        ...(hlsLadder.ladder.length ? { qualityLadder: hlsLadder.ladder } : {}),
        ...(hlsLangs.length ? { discoveredAudioLangs: hlsLangs } : {}),
      };
      setCachedLiveness(key, ok);
      return ok;
    } catch {
      // Timeout or transient abort is not proof of death. The filter below retains
      // it only when no other candidate verifies healthy.
      return { alive: false, confirmedDead: false };
    }
  })();

  livenessInFlight.set(key, task);
  void task.finally(() => {
    if (livenessInFlight.get(key) === task) livenessInFlight.delete(key);
  });
  return awaitProbe(task, outerSignal);
}

/**
 * Concurrently verifies liveness across unique upstream URLs in `candidates`,
 * promotes healthy `standbyUrl` backups when primaries are dead, enriches
 * `availableAudioLangs` / `multiAudio` with tracks discovered directly from
 * live HLS/DASH manifests, and strips confirmed-dead streams.
 */
export async function verifyAndFilterCandidates(
  candidates: RawStreamCandidate[],
  signal?: AbortSignal,
): Promise<RawStreamCandidate[]> {
  const detailed = await verifyAndFilterCandidatesDetailed(candidates, signal);
  return detailed.candidates;
}

export async function verifyAndFilterCandidatesDetailed(
  candidates: RawStreamCandidate[],
  signal?: AbortSignal,
): Promise<{ candidates: RawStreamCandidate[]; verifiedAliveCount: number }> {
  if (!candidates.length) return { candidates: [], verifiedAliveCount: 0 };

  // Expand standby backups into explicit probe targets so we can promote them cleanly if primary is dead.
  // Track priority so Multi-Audio streams and lowest-latency primaries ALWAYS probe in Wave 0!
  const uniqueTargets = new Map<
    string,
    { url: string; type: 'hls' | 'dash' | 'mp4'; headers?: Record<string, string>; priority: number }
  >();
  for (const c of candidates) {
    const pKey = cacheKeyFor(c.url, c.headers);
    const candPrio = (c.multiAudio ? 0 : 1000) + Math.min(c.latencyMs ?? 500, 900);
    const prev = uniqueTargets.get(pKey);
    if (!prev || candPrio < prev.priority) {
      uniqueTargets.set(pKey, { url: c.url, type: c.type, headers: c.headers, priority: candPrio });
    }
    if (c.standbyUrl && c.standbyUrl !== c.url) {
      const sHeaders = c.standbyHeaders ?? c.headers;
      const sKey = cacheKeyFor(c.standbyUrl, sHeaders);
      const standbyPrio = candPrio + 1500;
      const prevS = uniqueTargets.get(sKey);
      if (!prevS || standbyPrio < prevS.priority) {
        uniqueTargets.set(sKey, { url: c.standbyUrl, type: c.type, headers: sHeaders, priority: standbyPrio });
      }
    }
  }

  const budgetSig = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(3500)])
    : AbortSignal.timeout(3500);

  const outcomes = new Map<string, LivenessProbeOutcome>();
  const entries = [...uniqueTargets.entries()].sort((a, b) => a[1].priority - b[1].priority);
  const concurrency = Math.min(20, entries.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < entries.length && !budgetSig.aborted) {
        const idx = cursor++;
        const [k, target] = entries[idx];
        const res = await runSingleProbe(target, budgetSig);
        outcomes.set(k, res);
      }
    }),
  );

  const applyOutcomeToCandidate = (
    base: RawStreamCandidate,
    outcome: LivenessProbeOutcome | undefined,
  ): RawStreamCandidate => {
    if (!outcome || !outcome.alive) return base;
    let updated: RawStreamCandidate = { ...base };

    if (outcome.discoveredAudioLangs && outcome.discoveredAudioLangs.length > 0) {
      if (outcome.discoveredAudioLangs.length === 1) {
        // Manifest truth overrides provider metadata: a manifest exposing
        // exactly one audio rendition is a single-language stream, even if
        // the provider claimed several dubs. Advertising it as multi-audio
        // makes language switches appear to succeed while audio never changes.
        const only = normalizeLang(outcome.discoveredAudioLangs[0]);
        if (only.code !== 'und') {
          updated = {
            ...updated,
            multiAudio: false,
            availableAudioLangs: [only.code],
            audioLang: only.code,
            audioLabel: only.label,
          };
        }
      } else if (outcome.discoveredAudioLangs.length > 1 || updated.multiAudio) {
        const merged = [...(updated.availableAudioLangs ?? [])];
        for (const code of outcome.discoveredAudioLangs) {
          if (!merged.includes(code)) merged.push(code);
        }
        updated = {
          ...updated,
          multiAudio: merged.length > 1 || !!updated.multiAudio,
          availableAudioLangs: merged,
        };
      } else if (!updated.audioLang || updated.audioLang === 'und') {
        const onlyCode = outcome.discoveredAudioLangs[0];
        const norm = normalizeLang(onlyCode);
        if (norm.code !== 'und') {
          updated = {
            ...updated,
            audioLang: norm.code,
            audioLabel: norm.label,
          };
        }
      }
    }

    if (outcome.rttMs !== undefined && updated.latencyMs === undefined) {
      updated = {
        ...updated,
        latencyMs: outcome.rttMs,
      };
    }

    if (outcome.qualityOptions !== undefined) {
      // The measured manifest is the ONLY ladder authority. Provider/API
      // metadata (e.g. an `availableQualities` family list) must never
      // promote a single-rendition leaf playlist into a fake multi-quality
      // stream — that is how "4 QUALITIES" badges ended up on streams whose
      // player quality menu contains a single 0-height level.
      updated = {
        ...updated,
        qualityOptions: updated.qualityLabelsUnreliable ? 0 : outcome.qualityOptions,
        qualityLadder: !updated.qualityLabelsUnreliable && outcome.qualityLadder?.length ? outcome.qualityLadder : undefined,
        // A leaf playlist or height-less master cannot substantiate a
        // catalogue's fixed-resolution label.
        ...((outcome.manifestKind === 'hls-media' || outcome.manifestKind === 'hls-master') && !outcome.qualityLadder?.length ? { quality: 'auto' } : {}),
      };
    }

    return updated;
  };

  const outcomeFor = (cand: RawStreamCandidate) => ({
    primary: outcomes.get(cacheKeyFor(cand.url, cand.headers)),
    standby: cand.standbyUrl && cand.standbyUrl !== cand.url
      ? outcomes.get(cacheKeyFor(cand.standbyUrl, cand.standbyHeaders ?? cand.headers))
      : undefined,
  });
  const hasVerifiedAlive = candidates.some((cand) => {
    const outcome = outcomeFor(cand);
    return !!outcome.primary?.alive || !!outcome.standby?.alive;
  });

  const kept: RawStreamCandidate[] = [];
  let verifiedAliveCount = 0;

  for (const cand of candidates) {
    const { primary: primaryOutcome, standby: standbyOutcome } = outcomeFor(cand);
    const standbyHeaders = cand.standbyHeaders ?? cand.headers;
    const hasStandby = !!(cand.standbyUrl && cand.standbyUrl !== cand.url);
    const promoteStandby = (): RawStreamCandidate => ({
      ...cand,
      url: cand.standbyUrl!,
      headers: standbyHeaders,
      standbyUrl: undefined,
      standbyHeaders: undefined,
    });

    // Always prefer a verified healthy lane, including a standby whose primary
    // timed out. Once any healthy option exists, never advertise unprobed lanes.
    if (standbyOutcome?.alive && !primaryOutcome?.alive && hasStandby) {
      verifiedAliveCount++;
      kept.push(applyOutcomeToCandidate(promoteStandby(), standbyOutcome));
      continue;
    }
    if (primaryOutcome?.alive) {
      verifiedAliveCount++;
      const cleanedStandby = standbyOutcome?.confirmedDead
        ? { ...cand, standbyUrl: undefined, standbyHeaders: undefined }
        : cand;
      kept.push(applyOutcomeToCandidate(cleanedStandby, primaryOutcome));
      continue;
    }
    if (hasVerifiedAlive) continue;

    // Last-resort mode only: no candidate verified healthy, so an unconfirmed
    // slow origin is preferable to returning no playback option at all.
    if (primaryOutcome?.confirmedDead) {
      if (hasStandby && !standbyOutcome?.confirmedDead) {
        kept.push(applyOutcomeToCandidate(promoteStandby(), standbyOutcome));
      }
      continue;
    }
    const cleanedStandby = standbyOutcome?.confirmedDead
      ? { ...cand, standbyUrl: undefined, standbyHeaders: undefined }
      : cand;
    kept.push(applyOutcomeToCandidate(cleanedStandby, primaryOutcome));
  }

  return { candidates: kept, verifiedAliveCount };
}

/**
 * On-demand, server-side playback-path check. It probes the actual stream
 * manifest, its selected media playlists, and a tiny byte-range from one video
 * plus up to two audio segments. URLs and response bodies never leave the
 * server. This still cannot prove that a viewer's browser can play the stream.
 */
export async function diagnoseCandidatePlayback(candidate: RawStreamCandidate, relayMode: 'hybrid' | 'full' = 'hybrid') {
  type Check = { stage: string; status: string; ms: number; httpStatus?: number; contentType?: string; bytes?: number; error?: string };
  const started = Date.now();
  const checks: Check[] = [];
  const languages = new Set<string>();
  const headers = { 'User-Agent': DEFAULT_PROBE_UA, Accept: '*/*', ...(candidate.headers ?? {}) };
  // Treat every source-supplied header as potentially credential-bearing; do
  // not forward it across an origin-changing redirect.
  const hasSensitiveHeader = Object.keys(candidate.headers ?? {}).length > 0;
  const wholeRequest = AbortSignal.timeout(9000);

  const readText = async (stage: string, startUrl: string): Promise<{ text: string; url: string } | null> => {
    const t0 = Date.now();
    try {
      let url = startUrl;
      for (let redirect = 0; redirect <= 3; redirect++) {
        if (!isSafeUpstreamUrl(url)) {
          checks.push({ stage, status: 'blocked-unsafe-url', ms: Date.now() - t0 });
          return null;
        }
        const res = await fetch(url, { headers, redirect: 'manual', signal: wholeRequest });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          await res.body?.cancel().catch(() => {});
          if (!location || redirect === 3) {
            checks.push({ stage, status: 'redirect-error', httpStatus: res.status, ms: Date.now() - t0 });
            return null;
          }
          const nextUrl = new URL(location, url).href;
          if (hasSensitiveHeader && new URL(nextUrl).origin !== new URL(url).origin) {
            checks.push({ stage, status: 'blocked-auth-redirect', httpStatus: res.status, ms: Date.now() - t0 });
            return null;
          }
          url = nextUrl;
          continue;
        }
        const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!res.ok || contentType.includes('text/html') || contentType.includes('application/json')) {
          await res.body?.cancel().catch(() => {});
          checks.push({ stage, status: 'http-error', httpStatus: res.status, ms: Date.now() - t0,
            ...(contentType ? { contentType: contentType.slice(0, 80) } : {}) });
          return null;
        }
        const text = await readBoundedManifest(res, MAX_PROBE_MANIFEST_BYTES);
        const lead = text.trimStart();
        const isDashManifest = stage === 'manifest' && /<MPD\b/i.test(lead);
        const isManifest = isDashManifest || (lead.startsWith('#EXTM3U') &&
          (stage === 'manifest' || /#EXTINF\b|#EXT-X-STREAM-INF\b|#EXT-X-MAP\b/i.test(text)));
        if (!isManifest) {
          checks.push({ stage, status: 'invalid-manifest', httpStatus: res.status, ms: Date.now() - t0 });
          return null;
        }
        checks.push({ stage, status: 'ok', httpStatus: res.status, ms: Date.now() - t0 });
        const finalUrl = res.url || url;
        if (!isSafeUpstreamUrl(finalUrl)) return null;
        return { text, url: finalUrl };
      }
    } catch (err) {
      const error = err instanceof Error ? err.name : 'Error';
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      checks.push({ stage, status: error === 'TimeoutError' || error === 'AbortError' ? 'timeout' : 'network-error',
        ms: Date.now() - t0, error: cause && /^[A-Z0-9_]{1,40}$/.test(cause) ? cause : error.replace(/[^a-zA-Z]/g, '').slice(0, 40) });
    }
    return null;
  };

  const rangeProbe = async (stage: string, url: string, redirectDepth = 0): Promise<{ url: string; ok: boolean } | null> => {
    const t0 = Date.now();
    try {
      if (!isSafeUpstreamUrl(url)) {
        checks.push({ stage, status: 'blocked-unsafe-url', ms: Date.now() - t0 });
        return null;
      }
      const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-1023' }, redirect: 'manual',
        signal: AbortSignal.any([wholeRequest, AbortSignal.timeout(3000)]) });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) {
          checks.push({ stage, status: 'redirect-error', httpStatus: res.status, ms: Date.now() - t0 });
          return null;
        }
        if (redirectDepth >= 3) {
          checks.push({ stage, status: 'redirect-limit', httpStatus: res.status, ms: Date.now() - t0 });
          return null;
        }
        const target = new URL(location, url).href;
        if (hasSensitiveHeader && new URL(target).origin !== new URL(url).origin) {
          checks.push({ stage, status: 'blocked-auth-redirect', httpStatus: res.status, ms: Date.now() - t0 });
          return null;
        }
        if (!isSafeUpstreamUrl(target)) {
          checks.push({ stage, status: 'blocked-unsafe-redirect', httpStatus: res.status, ms: Date.now() - t0 });
          return null;
        }
        return rangeProbe(stage, target, redirectDepth + 1);
      }
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!(res.status === 200 || res.status === 206) || contentType.includes('text/html') || contentType.includes('application/json')) {
        await res.body?.cancel().catch(() => {});
        checks.push({ stage, status: 'media-http-error', httpStatus: res.status, ms: Date.now() - t0,
          ...(contentType ? { contentType: contentType.slice(0, 80) } : {}) });
        return null;
      }
      let bytes = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          const { value } = await reader.read();
          bytes = Math.min(value?.byteLength ?? 0, 1024);
        } finally { await reader.cancel().catch(() => {}); }
      }
      const ok = bytes > 0;
      checks.push({ stage, status: ok ? 'ok' : 'empty-media-response', httpStatus: res.status,
        ms: Date.now() - t0, bytes, ...(contentType ? { contentType: contentType.slice(0, 80) } : {}) });
      return { url, ok };
    } catch (err) {
      const error = err instanceof Error ? err.name : 'Error';
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      checks.push({ stage, status: error === 'TimeoutError' || error === 'AbortError' ? 'timeout' : 'network-error',
        ms: Date.now() - t0, error: cause && /^[A-Z0-9_]{1,40}$/.test(cause) ? cause : error.replace(/[^a-zA-Z]/g, '').slice(0, 40) });
      return null;
    }
  };

  const firstNonComment = (text: string, base: string): string | undefined => {
    const raw = text.split(/\r?\n/).map(x => x.trim()).find(x => x && !x.startsWith('#'));
    if (!raw) return;
    try { const resolved = resolveHlsChildUrl(raw, base); return isSafeUpstreamUrl(resolved) ? resolved : undefined; }
    catch { return; }
  };

  let result: { format: string; manifestStatus: string; manifestKind?: string; segmentStatus: string; mediaSegmentChecks: number };
  const mediaSegments: { stage: string; url: string }[] = [];
  if (candidate.type === 'mp4') {
    mediaSegments.push({ stage: 'media-segment', url: candidate.url });
    const sample = await rangeProbe('media-segment', candidate.url);
    result = { format: 'mp4', manifestStatus: 'not-applicable', segmentStatus: sample?.ok ? 'ok' : (checks.at(-1)?.status ?? 'unknown'), mediaSegmentChecks: sample ? 1 : 0 };
  } else if (candidate.type === 'hls') {
    const manifest = await readText('manifest', candidate.url);
    if (!manifest) {
      result = { format: 'hls', manifestStatus: checks.at(-1)?.status ?? 'unknown', segmentStatus: 'not-reached', mediaSegmentChecks: 0 };
    } else {
      const isMaster = /#EXT-X-STREAM-INF\b/i.test(manifest.text);
      const kind = isMaster ? 'hls-master' : 'hls-media';
      for (const lang of extractManifestAudioLangs(manifest.text)) languages.add(lang);
      const childTargets: { stage: string; url: string }[] = [];
      if (isMaster) {
        const lines = manifest.text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (/^#EXT-X-STREAM-INF\b/i.test(lines[i].trim())) {
            const uri = lines.slice(i + 1).map(x => x.trim()).find(x => x && !x.startsWith('#'));
            if (uri) {
              try { childTargets.push({ stage: 'video-playlist', url: resolveHlsChildUrl(uri, manifest.url) }); } catch { /* report below */ }
              break;
            }
          }
        }
        const audioRows = lines.filter(x => /^#EXT-X-MEDIA:/i.test(x.trim()) && /TYPE=AUDIO\b/i.test(x));
        const defaultAudio = audioRows.find(x => /DEFAULT=YES\b/i.test(x));
        const audioToCheck = [...new Set([defaultAudio, ...audioRows].filter((x): x is string => !!x))].slice(0, 2);
        for (let index = 0; index < audioToCheck.length; index++) {
          const uri = audioToCheck[index].match(/\bURI="([^"]+)"/i)?.[1];
          if (uri) { try { childTargets.push({ stage: 'audio-playlist', url: resolveHlsChildUrl(uri, manifest.url) }); } catch { /* report below */ } }
        }
      } else {
        const seg = firstNonComment(manifest.text, manifest.url);
        if (seg) mediaSegments.push({ stage: 'media-segment', url: seg });
      }
      const playlistResults = await Promise.all(childTargets.slice(0, 3).map(async child => {
        const fetched = await readText(child.stage, child.url);
        if (!fetched) return;
        const nested = /#EXT-X-STREAM-INF\b/i.test(fetched.text);
        const segment = firstNonComment(fetched.text, fetched.url);
        if (segment && !nested) mediaSegments.push({ stage: child.stage.startsWith('audio-playlist') ? 'audio-segment' : 'video-segment', url: segment });
      }));
      void playlistResults;
      const uniqueSegments = mediaSegments.filter((x, i, a) => a.findIndex(y => y.url === x.url) === i).slice(0, 3);
      const probes = await Promise.all(uniqueSegments.map(async item => {
        const probed = await rangeProbe(item.stage, item.url);
        return { item, probed };
      }));
      const segmentResults = probes.map(x => x.probed?.ok ?? false);
      const segStatus = uniqueSegments.length === 0 ? (isMaster && childTargets.length === 0 ? 'muxed-no-segment-url' : 'segment-not-found')
        : segmentResults.every(Boolean) ? 'ok' : 'failed';
      result = { format: 'hls', manifestStatus: 'ok', manifestKind: kind, segmentStatus: segStatus, mediaSegmentChecks: uniqueSegments.length };
    }
  } else {
    // Probe explicit DASH SegmentURL/Initialization entries. Dynamic
    // SegmentTemplate expressions need player state/representation selection,
    // so report those as unprobed rather than claiming success.
    const manifest = await readText('manifest', candidate.url);
    let segmentStatus = 'not-probed-dash-template';
    let mediaSegmentChecks = 0;
    if (manifest) {
      const baseRef = manifest.text.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i)?.[1]?.trim();
      const segmentRef = manifest.text.match(/<SegmentURL[^>]*\bmedia=["']([^"']+)["']/i)?.[1]
        ?? manifest.text.match(/<Initialization[^>]*\bsourceURL=["']([^"']+)["']/i)?.[1]
        ?? manifest.text.match(/<Initialization[^>]*\bsource=["']([^"']+)["']/i)?.[1];
      if (segmentRef) {
        try {
          const base = baseRef ? new URL(baseRef, manifest.url).href : manifest.url;
          const segmentUrl = new URL(segmentRef, base).href;
          if (isSafeUpstreamUrl(segmentUrl)) {
            mediaSegments.push({ stage: 'media-segment', url: segmentUrl });
            const sample = await rangeProbe('media-segment', segmentUrl);
            mediaSegmentChecks = sample ? 1 : 0;
            segmentStatus = sample?.ok ? 'ok' : (checks.at(-1)?.status ?? 'failed');
          } else segmentStatus = 'blocked-unsafe-url';
        } catch { segmentStatus = 'invalid-segment-url'; }
      } else if (!/SegmentTemplate/i.test(manifest.text)) segmentStatus = 'segment-not-listed';
    }
    result = { format: 'dash', manifestStatus: manifest ? 'ok' : (checks.at(-1)?.status ?? 'unknown'),
      manifestKind: manifest ? 'dash' : undefined, segmentStatus, mediaSegmentChecks };
  }

  const firstSegmentUrl = mediaSegments[0]?.url;
  let delivery: Record<string, unknown> = { mode: 'unknown', segmentRelayChecked: false };
  if (firstSegmentUrl) {
    if (relayMode === 'full') {
      delivery = { mode: 'full', route: 'backend-relay', segmentRelayChecked: false };
    } else {
      const canDirect = await verifyDirectSegmentOffload(firstSegmentUrl);
      delivery = { mode: 'hybrid', route: canDirect ? 'browser-cdn-offload' : 'backend-relay',
        corsOffloadPreflight: canDirect ? 'passed' : 'not-passed-or-policy-blocked', segmentRelayChecked: false };
    }
  }
  const manifestLanguages = [...languages];
  const failureStage = checks.find(x => !['ok'].includes(x.status))?.stage ??
    (result.segmentStatus !== 'ok' ? 'media-segment' : null);
  return {
    format: result.format,
    manifest: { status: result.manifestStatus, ...(result.manifestKind ? { kind: result.manifestKind } : {}) },
    media: { status: result.segmentStatus, checks: result.mediaSegmentChecks },
    checks,
    manifestLanguages,
    delivery,
    failureStage,
    elapsedMs: Date.now() - started,
    // Always explicit: this is a server-side origin probe, not playback in a browser.
    browserPlaybackChecked: false,
  };
}

/** Slow, on-demand diagnostic only. No URLs, headers or upstream body are returned.
 * This does not alter playback selection or the liveness cache. */
export async function diagnoseMultiAudioCandidate(candidate: RawStreamCandidate) {
  type Step = { stage: string; status: string; ms: number; httpStatus?: number; error?: string };
  const steps: Step[] = [];
  const headers = { 'User-Agent': DEFAULT_PROBE_UA, Accept: '*/*', ...(candidate.headers ?? {}) };
  const read = async (stage: string, startUrl: string): Promise<{ text: string; url: string } | null> => {
    const start = Date.now();
    const signal = AbortSignal.timeout(8000);
    try {
      let url = startUrl;
      for (let i = 0; i <= 3; i++) {
        if (!isSafeUpstreamUrl(url)) { steps.push({stage,status:'unsafe-url',ms:Date.now()-start}); return null; }
        const res = await fetch(url, {headers, signal, redirect:'manual'});
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          await res.body?.cancel();
          if (!location || i === 3) { steps.push({stage,status:'redirect-error',httpStatus:res.status,ms:Date.now()-start});return null; }
          url = new URL(location,url).href;
          continue;
        }
        if (!res.ok) { await res.body?.cancel(); steps.push({stage,status:'http-error',httpStatus:res.status,ms:Date.now()-start});return null; }
        const text = await readBoundedManifest(res, MAX_PROBE_MANIFEST_BYTES);
        const valid = text.trimStart().startsWith('#EXTM3U') && (stage === 'master' || /#EXTINF\b|#EXT-X-STREAM-INF\b|#EXT-X-MAP\b/i.test(text));
        steps.push({stage,status:valid?'ok':'invalid-manifest',httpStatus:res.status,ms:Date.now()-start});
        return valid ? {text,url} : null;
      }
    } catch (err) {
      const error = err instanceof Error ? err.name : 'Error';
      const cause = (err as {cause?:{code?:string}})?.cause?.code;
      steps.push({stage,status:error === 'TimeoutError' || error === 'AbortError' ? 'timeout':'network-error',ms:Date.now()-start,
        error:cause && /^[A-Z0-9_]{1,40}$/.test(cause) ? cause : error.replace(/[^a-zA-Z]/g,'').slice(0,40)});
    }
    return null;
  };
  if (candidate.type !== 'hls') return {status:'unsupported',manifestLanguages:[],steps};
  const master = await read('master', candidate.url);
  if (!master) return {status:'master-unavailable',manifestLanguages:[],steps};
  const languages = extractManifestAudioLangs(master.text);
  const lines = master.text.split(/\r?\n/);
  let video = '', audio = '';
  for (let i=0;i<lines.length;i++) {
    const line=lines[i].trim();
    if (!video && /^#EXT-X-STREAM-INF\b/i.test(line)) video=lines.slice(i+1).map(x=>x.trim()).find(x=>x && !x.startsWith('#')) || '';
    if (/^#EXT-X-MEDIA:/i.test(line) && /TYPE=AUDIO\b/i.test(line)) {
      const uri=line.match(/\bURI="([^"]+)"/i)?.[1] || '';
      if (uri && (!audio || /DEFAULT=YES\b/i.test(line))) audio=uri;
    }
  }
  const checks: Promise<unknown>[] = [];
  for (const [stage, uri] of [['video-playlist',video],['audio-playlist',audio]]) {
    if (!uri) { steps.push({stage,status:'not-listed',ms:0}); continue; }
    try { checks.push(read(stage,resolveHlsChildUrl(uri,master.url))); }
    catch { steps.push({stage,status:'invalid-url',ms:0}); }
  }
  await Promise.all(checks);
  const childrenOk = steps.filter(x=>x.stage !== 'master').every(x=>x.status==='ok');
  return {status:languages.length>1 && childrenOk?'manifest-and-playlists-reachable':'incomplete',manifestLanguages:languages,steps};
}
