/**
 * Elfura Backend — Zero-Disk Automatic OpenSubtitles Fallback (Part 2)
 * ====================================================================
 * Queries the Stremio v3 OpenSubtitles JSON index by IMDb ID (`tt...`) when
 * upstream video sources return missing or sparse subtitle tracks:
 *   - Movie:  {openSubtitlesBase}/subtitles/movie/{imdbId}.json
 *   - Series: {openSubtitlesBase}/subtitles/series/{imdbId}:{season}:{episode}.json
 *
 * Strictly zero disk writes:
 *   - Bounded 256-entry in-memory LRU cache (30-minute TTL)
 *   - Every returned subtitle URL is validated with `isSafeUpstreamUrl` and
 *     subsequently sealed into `/api/v1/stream?t=<ticket>` (`k: 's'`) so no
 *     external subtitle domain is ever exposed to the client.
 */

import type { BackendConfig } from './config.js';
import { isSafeUpstreamUrl } from './security.js';
import { normalizeLang } from './sources/lang.js';
import type { RawTrackRef } from './sources/types.js';

interface OpenSubEntry {
  id?: string;
  url?: string;
  SubEncoding?: string;
  lang?: string;
  subtitleFileName?: string;
  movieReleaseName?: string;
  m?: string;
  g?: string;
}

interface CacheEntry {
  expiresAt: number;
  tracks: RawTrackRef[];
}

const SUB_CACHE_MAX = 256;
const SUB_CACHE_TTL_MS = 30 * 60_000;
const subRamCache = new Map<string, CacheEntry>();

const OPENSUB_LEGACY_TAG_MAP: Record<string, string> = {
  pob: 'pt-BR',
  pb: 'pt-BR',
  spl: 'es-419',
  spn: 'es-419',
  ea: 'es-419',
  zht: 'zh-Hant',
  zt: 'zh-Hant',
  zhs: 'zh-Hans',
  zs: 'zh-Hans',
  chi: 'zh',
  fre: 'fr',
  ger: 'de',
  dut: 'nl',
  cze: 'cs',
  gre: 'el',
  per: 'fa',
  rum: 'ro',
  scc: 'sr',
  slo: 'sk',
  alb: 'sq',
  arm: 'hy',
  baq: 'eu',
  bur: 'my',
  geo: 'ka',
  ice: 'is',
  mac: 'mk',
  may: 'ms',
  tib: 'bo',
  wel: 'cy',
};

const BLOCKED_SUB_EXT_RE = /\.(?:sub|idx|sup|mks|zip|rar|7z|txt|smi|sami|mpl)(?:[?#]|$)/i;
const VALID_SUB_EXT_RE = /\.(?:srt|vtt|ass|ssa)(?:[?#]|$)/i;
const SDH_HINT_RE = /\b(?:sdh|hi|hearing[\s._-]*impaired|cc)\b/i;

function getCachedSubs(key: string): RawTrackRef[] | null {
  const hit = subRamCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    subRamCache.delete(key);
    return null;
  }
  subRamCache.delete(key);
  subRamCache.set(key, hit);
  return hit.tracks;
}

function setCachedSubs(key: string, tracks: RawTrackRef[]): void {
  if (subRamCache.size >= SUB_CACHE_MAX) {
    const oldest = subRamCache.keys().next().value;
    if (oldest) subRamCache.delete(oldest);
  }
  subRamCache.set(key, { expiresAt: Date.now() + SUB_CACHE_TTL_MS, tracks });
}

function canonicalizeOpenSubLang(raw?: string): { code: string; label: string } | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const mapped = OPENSUB_LEGACY_TAG_MAP[trimmed] || raw.trim();
  const norm = normalizeLang(mapped);
  if (!norm.code || norm.code === 'und') return null;
  return norm;
}

function isUsableSubtitleEntry(entry: OpenSubEntry): boolean {
  const url = typeof entry.url === 'string' ? entry.url.trim() : '';
  if (!url || !isSafeUpstreamUrl(url)) return false;
  if (BLOCKED_SUB_EXT_RE.test(url)) return false;

  const fileName = typeof entry.subtitleFileName === 'string' ? entry.subtitleFileName.trim() : '';
  if (fileName && BLOCKED_SUB_EXT_RE.test(fileName)) return false;
  if (fileName && !VALID_SUB_EXT_RE.test(fileName) && /\.[a-z0-9]{2,5}$/i.test(fileName)) {
    return false;
  }
  return true;
}

function scoreSubtitleEntry(entry: OpenSubEntry): number {
  let score = 0;
  const enc = (entry.SubEncoding || '').toUpperCase();
  const url = entry.url || '';
  const fn = entry.subtitleFileName || '';

  if (enc === 'UTF-8' || enc === 'UTF8' || enc === 'ASCII') score += 40;
  if (/subencoding-stremio-utf8/i.test(url) && !/[?&]senc=/i.test(url)) score += 25;
  if (/\.vtt(?:[?#]|$)/i.test(fn) || /\.vtt(?:[?#]|$)/i.test(url)) score += 15;
  else if (/\.srt(?:[?#]|$)/i.test(fn) || /\.srt(?:[?#]|$)/i.test(url)) score += 12;

  // Prefer clean dialogue subtitles as the primary language track over SDH/HI
  if (!SDH_HINT_RE.test(fn) && !SDH_HINT_RE.test(entry.movieReleaseName || '')) {
    score += 10;
  }
  return score;
}

export async function fetchOpenSubtitlesFallback(
  cfg: BackendConfig['subtitles'],
  params: {
    type: 'movie' | 'tv';
    imdbId?: string | null;
    season?: number;
    episode?: number;
  },
): Promise<RawTrackRef[]> {
  if (!cfg.enabled || !cfg.openSubtitlesBase) return [];
  const imdb = (params.imdbId || '').trim();
  if (!/^tt\d{5,12}$/i.test(imdb)) return [];

  const normImdb = imdb.toLowerCase();
  const routeKey =
    params.type === 'tv'
      ? `series/${normImdb}:${Math.max(1, params.season ?? 1)}:${Math.max(1, params.episode ?? 1)}`
      : `movie/${normImdb}`;

  const cached = getCachedSubs(routeKey);
  if (cached) return cached;

  const endpoint = `${cfg.openSubtitlesBase}/subtitles/${routeKey}.json`;
  if (!isSafeUpstreamUrl(endpoint)) return [];

  try {
    const res = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { subtitles?: OpenSubEntry[] };
    const rawList = Array.isArray(data?.subtitles) ? data.subtitles : [];
    if (!rawList.length) {
      setCachedSubs(routeKey, []);
      return [];
    }

    const bestByLang = new Map<string, { score: number; ref: RawTrackRef }>();

    for (const entry of rawList) {
      if (!isUsableSubtitleEntry(entry)) continue;
      const langNorm = canonicalizeOpenSubLang(entry.lang);
      if (!langNorm) continue;

      const score = scoreSubtitleEntry(entry);
      const url = entry.url!.trim();
      const fn = (entry.subtitleFileName || '').toLowerCase();
      const format: RawTrackRef['format'] =
        fn.endsWith('.vtt') || /\.vtt(?:[?#]|$)/i.test(url)
          ? 'vtt'
          : fn.endsWith('.ass') || fn.endsWith('.ssa')
            ? 'ass'
            : 'srt';

      const prev = bestByLang.get(langNorm.code);
      if (!prev || score > prev.score) {
        bestByLang.set(langNorm.code, {
          score,
          ref: {
            lang: langNorm.code,
            label: langNorm.label,
            url,
            format,
            default: langNorm.code === 'en',
          },
        });
      }
    }

    const PRIORITY_LANGS = ['en', 'hi', 'es', 'es-419', 'pt-br', 'pt', 'ar', 'fr', 'de', 'ja', 'ko'];
    const tracks = Array.from(bestByLang.values())
      .map((v) => v.ref)
      .sort((a, b) => {
        const ai = PRIORITY_LANGS.indexOf(a.lang);
        const bi = PRIORITY_LANGS.indexOf(b.lang);
        if (ai !== -1 || bi !== -1) {
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        }
        return a.label.localeCompare(b.label);
      })
      .slice(0, 24);

    setCachedSubs(routeKey, tracks);
    return tracks;
  } catch {
    return [];
  }
}
