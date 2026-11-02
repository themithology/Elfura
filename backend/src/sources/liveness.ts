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

import { extractManifestAudioLangs, seedManifestRamCache } from '../relay.js';
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
}

interface CachedLivenessEntry extends LivenessProbeOutcome {
  expiresAt: number;
}

const livenessRamCache = new Map<string, CachedLivenessEntry>();
const livenessInFlight = new Map<string, Promise<LivenessProbeOutcome>>();

function cacheKeyFor(url: string, headers?: Record<string, string>): string {
  return `${url}|${JSON.stringify(headers ?? {})}`;
}

function getCachedLiveness(key: string): LivenessProbeOutcome | null {
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
      const abs = new URL(raw, baseUrl).toString();
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
): Promise<boolean> {
  const res = await fetch(childUrl, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
  });
  const finalUrl = res.url || childUrl;
  if (!isSafeUpstreamUrl(finalUrl)) return false;
  if (!res.ok) return false;

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return false;
  }

  const text = await readBoundedManifest(res, MAX_PROBE_MANIFEST_BYTES);
  const lead = text.trimStart();
  if (!lead.startsWith('#EXTM3U')) return false;
  if (!/#EXTINF\b|#EXT-X-STREAM-INF\b|#EXT-X-MAP\b/i.test(text)) return false;

  if (/#EXT-X-ENDLIST\b/i.test(text)) {
    seedManifestRamCache(childUrl, headers, {
      finalUrl,
      kind: 'hls',
      bodyText: text,
    });
  }
  return true;
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
  if (inflight) return inflight;

  const task = (async (): Promise<LivenessProbeOutcome> => {
    const t0 = performance.now();
    const elapsed = () => Math.max(1, Math.round(performance.now() - t0));
    const sig = outerSignal
      ? AbortSignal.any([outerSignal, AbortSignal.timeout(1900)])
      : AbortSignal.timeout(1900);

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
        const ok: LivenessProbeOutcome = { alive: true, confirmedDead: false, rttMs: elapsed() };
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
        const ok: LivenessProbeOutcome = {
          alive: true,
          confirmedDead: false,
          rttMs: elapsed(),
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
              verifyChildHlsPlaylist(cu, manifestHeaders, sig).catch(() => false),
            ),
          );
          if (childChecks.some((okChild) => !okChild)) {
            const dead = { alive: false, confirmedDead: true };
            setCachedLiveness(key, dead);
            return dead;
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
      const ok: LivenessProbeOutcome = {
        alive: true,
        confirmedDead: false,
        rttMs: elapsed(),
        ...(hlsLangs.length ? { discoveredAudioLangs: hlsLangs } : {}),
      };
      setCachedLiveness(key, ok);
      return ok;
    } catch {
      // Timeout or transient abort: do not mark confirmedDead so slow origins remain last-resort fallbacks
      return { alive: false, confirmedDead: false };
    }
  })();

  livenessInFlight.set(key, task);
  try {
    return await task;
  } finally {
    livenessInFlight.delete(key);
  }
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
  if (!candidates.length) return [];

  // Expand standby backups into explicit probe targets so we can promote them cleanly if primary is dead
  const uniqueTargets = new Map<string, { url: string; type: 'hls' | 'dash' | 'mp4'; headers?: Record<string, string> }>();
  for (const c of candidates) {
    const pKey = cacheKeyFor(c.url, c.headers);
    if (!uniqueTargets.has(pKey)) {
      uniqueTargets.set(pKey, { url: c.url, type: c.type, headers: c.headers });
    }
    if (c.standbyUrl && c.standbyUrl !== c.url) {
      const sHeaders = c.standbyHeaders ?? c.headers;
      const sKey = cacheKeyFor(c.standbyUrl, sHeaders);
      if (!uniqueTargets.has(sKey)) {
        uniqueTargets.set(sKey, { url: c.standbyUrl, type: c.type, headers: sHeaders });
      }
    }
  }

  const budgetSig = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(2400)])
    : AbortSignal.timeout(2400);

  const outcomes = new Map<string, LivenessProbeOutcome>();
  const entries = [...uniqueTargets.entries()];
  const concurrency = Math.min(12, entries.length);
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
      if (outcome.discoveredAudioLangs.length > 1 || updated.multiAudio) {
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

    return updated;
  };

  const kept: RawStreamCandidate[] = [];

  for (const cand of candidates) {
    const primaryOutcome = outcomes.get(cacheKeyFor(cand.url, cand.headers));
    const standbyHeaders = cand.standbyHeaders ?? cand.headers;
    const standbyOutcome =
      cand.standbyUrl && cand.standbyUrl !== cand.url
        ? outcomes.get(cacheKeyFor(cand.standbyUrl, standbyHeaders))
        : undefined;

    if (primaryOutcome?.confirmedDead) {
      // Primary is confirmed dead — promote healthy/unconfirmed standby if available, else drop completely!
      if (cand.standbyUrl && cand.standbyUrl !== cand.url && !standbyOutcome?.confirmedDead) {
        const promoted: RawStreamCandidate = {
          ...cand,
          url: cand.standbyUrl,
          headers: standbyHeaders,
          standbyUrl: undefined,
          standbyHeaders: undefined,
        };
        kept.push(applyOutcomeToCandidate(promoted, standbyOutcome));
      }
      continue;
    }

    let cleanedStandby = cand;
    if (standbyOutcome?.confirmedDead) {
      cleanedStandby = { ...cand, standbyUrl: undefined, standbyHeaders: undefined };
    }
    kept.push(applyOutcomeToCandidate(cleanedStandby, primaryOutcome));
  }

  return kept;
}
