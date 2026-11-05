/**
 * Elfura Backend — Source 3 Adapter (VidSync Pro unified stream API)
 * ==================================================================
 * Researched live (Nov 2026): `GET {origin}/api/stream?type=movie|tv&id=
 * {tmdbId}&season={s}&episode={e}&stage=primary` returns a JSON source list
 * whose entries carry direct HLS URLs, per-source audio track metadata,
 * quality ladders, subtitles, required headers, and standby mirrors.
 * Verified from hosted runners with real manifest + segment bytes before
 * integration (Dune: Part Two — 19 HLS sources, English/Hindi/Tamil/
 * Telugu/Kannada). No auth or session token is required for the read API;
 * the optional session endpoint is not used.
 *
 * Only native HLS/DASH/MP4 streams are mapped into the uniform pipeline —
 * embed/player URLs are rejected. Language truth stays conservative:
 * `multiAudio` is set only when the response itself carries multiple
 * playable audio track URLs; otherwise the manifest-level verification in
 * liveness.ts and the player decide what a stream really carries.
 */

import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type {
  RawSourceResult,
  RawStreamCandidate,
  RawTrackRef,
  SourceAdapter,
  SourceQuery,
} from './types.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_CANDIDATES = 14;

interface VsStreamSource {
  url?: string;
  directUrl?: string;
  permanent_m3u8_url?: string;
  rawUrl?: string;
  type?: string;
  quality?: string | number;
  availableQualities?: unknown[];
  audioLanguage?: string;
  language?: string;
  audioLabel?: string;
  audioTracks?: unknown[];
  subtitles?: unknown[];
  headers?: Record<string, string>;
  standbyUrl?: string;
  standbyHeaders?: Record<string, string>;
  server?: unknown;
  provider?: unknown;
}

function pickStreamUrl(s: VsStreamSource): string {
  for (const raw of [s.url, s.directUrl, s.permanent_m3u8_url, s.rawUrl]) {
    const u = String(raw ?? '').trim();
    if (u && isSafeUpstreamUrl(u)) return u;
  }
  return '';
}

function inferType(s: VsStreamSource, url: string): 'hls' | 'dash' | 'mp4' | null {
  const t = String(s.type ?? '').toLowerCase();
  if (/embed|iframe|player/.test(t) || /\/embed\//i.test(url)) return null;
  if (t.includes('dash') || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (t.includes('mp4') || /\.mp4(?:[?#]|$)/i.test(url)) return 'mp4';
  if (t.includes('hls') || /\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  return /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : null;
}

function qualityHeights(available: unknown[] | undefined): number[] {
  const heights = new Set<number>();
  for (const q of available ?? []) {
    const raw =
      typeof q === 'object' && q !== null
        ? String((q as { quality?: unknown; label?: unknown; height?: unknown }).quality ??
            (q as { label?: unknown }).label ??
            (q as { height?: unknown }).height ??
            '')
        : String(q ?? '');
    const n = Number(raw.replace(/\D+/g, ''));
    if (n >= 144 && n <= 4320) heights.add(n);
  }
  return [...heights].sort((a, b) => b - a);
}

function pickHeaders(raw: Record<string, string> | undefined, origin: string): Record<string, string> {
  const out: Record<string, string> = { 'User-Agent': BROWSER_UA };
  for (const [k, v] of Object.entries(raw ?? {})) {
    const key = k.toLowerCase();
    if (key === 'referer') out.Referer = String(v);
    else if (key === 'origin') out.Origin = String(v);
    else if (key === 'user-agent') out['User-Agent'] = String(v);
  }
  if (!out.Referer) out.Referer = `${origin}/`;
  return out;
}

function mapTracks(raw: unknown[] | undefined, kind: 'audio' | 'subtitle', origin: string): RawTrackRef[] {
  const out: RawTrackRef[] = [];
  const seen = new Set<string>();
  for (const item of raw ?? []) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const url = String(t.url ?? t.link ?? t.file ?? '').trim();
    const langRaw = String(t.lang ?? t.language ?? t.code ?? t.name ?? t.label ?? '').trim();
    if (!langRaw) continue;
    const norm = normalizeLang(langRaw, langRaw);
    if (!norm.code || norm.code === 'und') continue;
    if (kind === 'audio' && !url) continue;
    if (kind === 'subtitle' && (!url || !isSafeUpstreamUrl(url))) continue;
    if (kind === 'audio' && !isSafeUpstreamUrl(url)) continue;
    const key = `${norm.code}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      lang: norm.code,
      label: String(t.label ?? t.name ?? norm.label),
      url: url || `${origin}/`,
      ...(kind === 'subtitle' && /srt/i.test(String(t.format ?? '')) ? { format: 'srt' as const } : {}),
    });
  }
  return out;
}

export function createSource3Adapter(cfg: BackendConfig['source3']): SourceAdapter {
  const origin = (cfg?.origin || 'https://vidsync.pro').replace(/\/+$/, '');

  return {
    id: 'source-3',
    label: 'Source 3',

    enabled() {
      return !!cfg?.enabled && !!origin;
    },

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      const startedAt = Date.now();
      const params = new URLSearchParams({
        type: query.type,
        id: String(query.tmdbId),
        season: String(query.season ?? 1),
        episode: String(query.episode ?? 1),
        stage: 'primary',
      });
      if (query.preferredLang) {
        const pref = normalizeLang(query.preferredLang);
        if (pref.code && pref.code !== 'und') params.set('audio', pref.label.toLowerCase());
      }

      let payload: { sources?: VsStreamSource[] } | null = null;
      try {
        const sig = query.signal
          ? AbortSignal.any([query.signal, AbortSignal.timeout(6500)])
          : AbortSignal.timeout(6500);
        const res = await fetch(`${origin}/api/stream?${params.toString()}`, {
          headers: {
            Accept: 'application/json',
            Origin: origin,
            Referer: `${origin}/`,
            'User-Agent': BROWSER_UA,
          },
          signal: sig,
        });
        if (res.ok) payload = (await res.json()) as { sources?: VsStreamSource[] };
        else {
          console.warn(`[elfura-source3] stream API HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn(
          `[elfura-source3] stream API failed: ${err instanceof Error ? err.name : 'error'}`,
        );
      }

      const sources = Array.isArray(payload?.sources) ? payload.sources : [];
      const candidates: RawStreamCandidate[] = [];
      const seen = new Set<string>();

      for (let i = 0; i < sources.length && candidates.length < MAX_CANDIDATES; i++) {
        const s = sources[i];
        if (!s || typeof s !== 'object') continue;
        const url = pickStreamUrl(s);
        if (!url || seen.has(url)) continue;
        const type = inferType(s, url);
        if (!type) continue;
        seen.add(url);

        const headers = pickHeaders(s.headers, origin);
        const audioTracks = mapTracks(s.audioTracks, 'audio', origin);
        const subtitles = mapTracks(s.subtitles, 'subtitle', origin);
        const ladder = qualityHeights(s.availableQualities);

        const singleRaw = String(s.audioLanguage ?? s.language ?? '').trim();
        const single = singleRaw ? normalizeLang(singleRaw, singleRaw) : null;
        const trackLangs = [...new Set(audioTracks.map((t) => t.lang))];
        const availableAudioLangs = [
          ...new Set([
            ...(single && single.code !== 'und' ? [single.code] : []),
            ...trackLangs,
          ]),
        ];
        // True multi-audio only when separate playable audio track URLs are
        // actually provided; otherwise the manifest itself is the truth.
        const multiAudio = trackLangs.length > 1;

        const qualityRaw = String(s.quality ?? '').trim();
        const quality =
          qualityRaw && qualityRaw !== '0'
            ? /p$/i.test(qualityRaw) || /k$/i.test(qualityRaw) || /auto/i.test(qualityRaw)
              ? qualityRaw
              : `${qualityRaw}p`
            : ladder.length
              ? `${ladder[0]}p`
              : 'auto';

        const standbyUrl = String(s.standbyUrl ?? '').trim();
        candidates.push({
          key: `vsync:${i}:${url}`,
          fingerprint: `vsync:${url}`,
          type,
          url,
          headers,
          quality,
          ...(ladder.length ? { qualityLadder: ladder, qualityOptions: ladder.length } : {}),
          ...(single && single.code !== 'und'
            ? { audioLang: single.code, audioLabel: String(s.audioLabel ?? single.label) }
            : {}),
          ...(availableAudioLangs.length ? { availableAudioLangs } : {}),
          ...(multiAudio ? { multiAudio: true } : {}),
          ...(audioTracks.length ? { audioTracks } : {}),
          ...(subtitles.length ? { subtitles } : {}),
          ...(standbyUrl && standbyUrl !== url && isSafeUpstreamUrl(standbyUrl)
            ? {
                standbyUrl,
                standbyHeaders: pickHeaders(s.standbyHeaders, origin),
              }
            : {}),
          // Multi-track and ladder-rich sources lead; response order is the
          // provider's own failover order otherwise.
          rank: (multiAudio ? 0 : 6) + (ladder.length > 1 ? 0 : 2) + i * 0.25,
          latencyMs: Date.now() - startedAt,
        });
      }

      candidates.sort((a, b) => a.rank - b.rank);
      query.diag?.push({
        adapter: 'source-3',
        lane: 'stream',
        ok: candidates.length > 0,
        ms: Date.now() - startedAt,
        detail: `stage=primary listed=${sources.length} candidates=${candidates.length}`,
      });

      return { candidates };
    },
  };
}
