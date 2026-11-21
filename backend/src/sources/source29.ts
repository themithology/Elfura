import { isSafeUpstreamUrl } from '../security.js';
import { restrictedFetch } from '../restricted-fetch.js';
import { resolveDirectAnimeEpisode } from './anime-direct-mapping.js';
import { normalizeLang } from './lang.js';
import { readBoundedText } from './upstream-fetch.js';
import type { RawSourceResult, RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const ORIGIN = 'https://novuscloud.buzz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const empty = (): RawSourceResult => ({ candidates: [] });
type Lane = 'sub' | 'dub' | 'hsub';
type Fetch = typeof fetch;

/** Parse the specific same-origin source API reference without running page JS. */
export function novusSourceReference(html: string): string | null {
  const ref = html.match(/\b(?:var|let|const)\s+sourcesUrl\s*=\s*(["'])([^"'\r\n]{1,4096})\1/)?.[2];
  if (!ref) return null;
  try {
    const u = new URL(ref.replace(/\\\//g, '/').replace(/\\u0026/gi, '&'), ORIGIN);
    if (u.origin !== ORIGIN || u.pathname !== '/stream/getSources' || u.username || u.password || u.hash ||
        !u.searchParams.get('t') || [...u.searchParams.keys()].some(k => k !== 't') || u.searchParams.getAll('t').length !== 1) return null;
    return u.href;
  } catch { return null; }
}

function trackReferences(value: unknown, referer: string): RawTrackRef[] {
  if (!Array.isArray(value)) return [];
  const tracks: RawTrackRef[] = [];
  for (const item of value.slice(0, 24)) {
    if (!item || typeof item !== 'object' || item.kind !== 'captions' || typeof item.file !== 'string') continue;
    const label = typeof item.label === 'string' ? item.label.slice(0, 80) : '';
    const lang = normalizeLang(null, label).code;
    if (lang === 'und') continue;
    try {
      const u = new URL(item.file, ORIGIN);
      if (u.origin !== ORIGIN || u.username || u.password || !isSafeUpstreamUrl(u.href)) continue;
      const ext = u.pathname.match(/\.(vtt|srt|ass|ssa)$/i)?.[1]?.toLowerCase();
      if (!ext) continue;
      tracks.push({ url: u.href, lang, label: label || lang, format: ext === 'ssa' ? 'ass' : ext as 'vtt' | 'srt' | 'ass', headers: { 'User-Agent': UA, Referer: referer } });
    } catch { /* skip malformed track */ }
  }
  return tracks;
}

export function createSource29Adapter(enabled: () => boolean = () => true, options: {
  fetchImpl?: Fetch;
  mapEpisode?: typeof resolveDirectAnimeEpisode;
} = {}): SourceAdapter {
  const f = options.fetchImpl ?? fetch;
  const mapEpisode = options.mapEpisode ?? resolveDirectAnimeEpisode;
  return {
    id: 'source-29', label: 'Source 29', enabled,
    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      if (!enabled()) return empty();
      const mapping = await mapEpisode(query, f);
      if (!mapping) return empty();
      const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(8500)]) : AbortSignal.timeout(8500);
      const resolveLane = async (lane: Lane): Promise<RawStreamCandidate | null> => {
        try {
          const page = new URL(`/embed/ani/${mapping.anilistId}/${mapping.episode}/${lane}`, ORIGIN);
          page.searchParams.set('k', '1');
          const headers = { 'User-Agent': UA, Referer: ORIGIN + '/' };
          // Manual, not error: the optional Worker egress propagates manual
          // without following upstream redirects. Reject every 3xx below.
          const response = await restrictedFetch(page, { signal, headers }, f);
          if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
          const html = await readBoundedText(response, 1_500_000); if (!html) return null;
          const api = novusSourceReference(html); if (!api) return null;
          const resolved = await restrictedFetch(api, { signal, headers: { ...headers, Referer: page.href, Accept: 'application/json' } }, f);
          if (!resolved.ok) { await resolved.body?.cancel().catch(() => {}); return null; }
          const json = await readBoundedText(resolved, 256_000); if (!json) return null;
          const payload = JSON.parse(json) as { sources?: unknown; tracks?: unknown };
          if (!Array.isArray(payload.sources)) return null;
          for (const source of payload.sources.slice(0, 6)) {
            if (!source || typeof source !== 'object' || typeof source.file !== 'string') continue;
            const url = new URL(source.file, ORIGIN);
            // This host advertises its own proxied HLS; do not follow arbitrary
            // URLs supplied by its page or accept embeds masquerading as media.
            if (url.origin !== ORIGIN || url.username || url.password || !isSafeUpstreamUrl(url.href)) continue;
            return {
              key: url.href, url: url.href, restrictedOrigin: ORIGIN, type: 'hls', quality: 'auto', rank: lane === 'hsub' ? 19 : 20,
              audioVariant: lane === 'dub' ? 'dub' : 'sub',
              ...(lane !== 'dub' ? { animeSubtitleMode: lane === 'hsub' ? 'hard' : 'soft' } : {}),
              claimedAudioLang: lane === 'dub' ? 'en' : 'ja',
              audioLabel: lane === 'hsub' ? 'Hard Sub' : lane === 'dub' ? 'Dub' : 'Sub',
              headers: { 'User-Agent': UA, Referer: page.href },
              subtitles: trackReferences(payload.tracks, page.href),
            };
          }
        } catch { /* fail closed */ }
        return null;
      };
      const [hard, sub, dub] = await Promise.all([resolveLane('hsub'), resolveLane('sub'), resolveLane('dub')]);
      // Hardsub is a provider declaration, not a guarantee. Keep the soft-sub
      // fallback too: a hard-sub playlist can fail even when its page exists.
      return { candidates: [hard, sub, dub].filter((c): c is RawStreamCandidate => c !== null) };
    },
  };
}
