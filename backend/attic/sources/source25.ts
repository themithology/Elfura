/**
 * Elfura Backend — Source 25 Adapter (Greybox)
 * ============================================
 * The simplest lane in the fleet: one GET, plain JSON, no token, no
 * encryption, no browser. Measured on a GitHub runner before this was written:
 *
 *   GET /api/player/sources?media=movie&id=<tmdb>
 *   GET /api/player/sources?media=tv&id=<tmdb>&season=<s>&episode=<e>
 *   -> 200 application/json, 12-21 sources per title, ~32-58 KB
 *
 * Payload:
 *   { sources: [ { id, provider, label, url, type, quality, height,
 *                  language?, audio: [], subtitles: [],
 *                  intro?, credits?, priority? } ], resolvedAt, failures: [] }
 *
 * TWO URL SHAPES, BOTH PLAYABLE (this is the part that is easy to get wrong):
 *
 *   - absolute  https://dash-hls-bridge...     CDN manifest
 *   - relative  /api/media?u=m1.xxxx           the provider's OWN proxy
 *
 * The relative ones look like an indirection to be avoided and they are the
 * majority of the payload. They were measured rather than assumed: 8/8 returned
 * `#EXTM3U` with `content-type: application/vnd.apple.mpegurl` and proper
 * EXT-X-MEDIA audio/subtitle groups. Publishing only the absolute entries would
 * have thrown away most of this source, so relative URLs are resolved against
 * the origin and kept.
 *
 * Why this one ranks high: it carries `language` per stream, so a title exposes
 * the genuine multi-language set (Hindi, Tamil, Telugu, Arabic, French, Bengali,
 * Urdu, Malayalam, Portuguese, ...) instead of one unlabelled stream. Declared
 * languages are recorded as `claimedAudioLang`, never as verified audio — the
 * registry still has to prove audio from a manifest.
 */
import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import type {
  RawSourceResult,
  RawStreamCandidate,
  RawTrackRef,
  SkipSegments,
  SourceAdapter,
  SourceQuery,
} from './types.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** Only advertised heights we trust; anything odd falls back to 'auto'. */
function qualityLabel(raw: unknown, height: unknown): string {
  const h = Number(height);
  if (Number.isFinite(h) && h >= 200 && h <= 4320) {
    if (h >= 2160) return '2160p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';
    if (h >= 360) return '360p';
  }
  const m = String(raw ?? '').match(/(\d{3,4})/);
  if (!m) return 'auto';
  const value = Number(m[1]);
  if (value >= 2160) return '2160p';
  if (value >= 1080) return '1080p';
  if (value >= 720) return '720p';
  if (value >= 480) return '480p';
  if (value >= 360) return '360p';
  return 'auto';
}

function inferType(url: string, declared: unknown): 'hls' | 'dash' | 'mp4' {
  const t = String(declared ?? '').toLowerCase();
  if (t === 'dash' || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (t === 'hls' || /hls|m3u8/i.test(t)) return 'hls';
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  if (/\.mp4(?:[?#]|$)/i.test(url)) return 'mp4';
  // The /api/media proxy URLs carry no extension at all, and every row in this
  // payload is HLS (0 .mpd across six measured titles).
  return 'hls';
}

/**
 * Normalise a provider language code.
 *
 * Real payloads contain qualifiers like 'en-2' and 'ar-3' meaning "the second
 * English track", plus plain junk such as 'und' or 'x7'. Returning the bare
 * subtag keeps the useful part and drops the junk, because a bogus language
 * code becomes a bogus language filter in the player.
 */
function normalizeLanguage(raw: unknown): string | null {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'und' || value === 'x' || /^x\d+$/.test(value)) return null;
  const base = value.split('-')[0];
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  if (base === 'und') return null;
  return base;
}

/** Number of distinct audio languages declared anywhere in the payload. */
function collectLanguages(sources: { language?: unknown; audio?: unknown }[]): string[] {
  const out = new Set<string>();
  for (const s of sources) {
    const direct = normalizeLanguage(s.language);
    if (direct) out.add(direct);
    if (Array.isArray(s.audio)) {
      for (const a of s.audio) {
        const code = normalizeLanguage(typeof a === 'string' ? a : (a as { language?: unknown })?.language);
        if (code) out.add(code);
      }
    }
  }
  return [...out];
}

interface GreyboxStream {
  id?: unknown;
  provider?: unknown;
  label?: unknown;
  url?: unknown;
  type?: unknown;
  quality?: unknown;
  height?: unknown;
  language?: unknown;
  audio?: unknown;
  subtitles?: unknown;
  intro?: { start?: unknown; end?: unknown };
  credits?: { start?: unknown; end?: unknown };
}

export function createSource25Adapter(cfg: BackendConfig['source25']): SourceAdapter {
  const origin = cfg.origin.replace(/\/+$/, '');
  const mediaHeaders = { 'User-Agent': BROWSER_UA, Referer: `${origin}/`, Origin: origin };

  return {
    id: 'source-25',
    label: 'Source 25',

    enabled: () => cfg.enabled,

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      if (!cfg.enabled) return { candidates: [] };
      if (!/^\d{1,12}$/.test(query.tmdbId)) return { candidates: [] };

      const startedAt = Date.now();
      const diag = (ok: boolean, detail: string) =>
        query.diag?.push({ adapter: 'source-25', lane: 'G', ok, ms: Date.now() - startedAt, detail });

      const signal = query.signal
        ? AbortSignal.any([query.signal, AbortSignal.timeout(cfg.timeoutMs)])
        : AbortSignal.timeout(cfg.timeoutMs);

      try {
        const params = new URLSearchParams({ media: query.type, id: query.tmdbId });
        if (query.type === 'tv') {
          params.set('season', String(query.season ?? 1));
          params.set('episode', String(query.episode ?? 1));
        }

        const apiUrl = `${origin}/api/player/sources?${params.toString()}`;
        // Greybox occasionally resets an API request or its response body even
        // though another request succeeds. Retry one network/body TypeError,
        // sequentially and within the original shared deadline. Never retry a
        // cancelled request, an HTTP response, or malformed JSON.
        let payload: { sources?: GreyboxStream[] } | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await fetch(apiUrl, {
              headers: { Accept: 'application/json, text/plain, */*', ...mediaHeaders },
              signal,
            });
            if (!res.ok) {
              await res.body?.cancel().catch(() => {});
              diag(false, `greybox http=${res.status}`);
              return { candidates: [] };
            }
            payload = (await res.json()) as { sources?: GreyboxStream[] };
            break;
          } catch (error) {
            if (attempt !== 0 || signal.aborted || !(error instanceof TypeError)) throw error;
          }
        }
        if (!payload) return { candidates: [] };
        const rows = Array.isArray(payload?.sources) ? payload.sources : [];
        if (rows.length === 0) {
          diag(false, 'greybox empty');
          return { candidates: [] };
        }

        const langs = collectLanguages(rows);
        const out: RawStreamCandidate[] = [];
        const seen = new Set<string>();
        const segments: SkipSegments = {};
        let haveSegments = false;

        for (const row of rows) {
          const rawUrl = typeof row?.url === 'string' ? row.url.trim() : '';
          if (!rawUrl) continue;

          // Relative /api/media URLs are the provider's own proxy and were
          // measured to serve real manifests. Resolve, do not discard.
          const absolute = /^https?:\/\//i.test(rawUrl)
            ? rawUrl
            : rawUrl.startsWith('/')
              ? `${origin}${rawUrl}`
              : `${origin}/${rawUrl}`;

          if (!isSafeUpstreamUrl(absolute)) continue;
          if (seen.has(absolute)) continue;
          seen.add(absolute);

          const quality = qualityLabel(row.quality, row.height);
          const height = Number(row.height);
          const lang = normalizeLanguage(row.language);

          // Subtitles belong to the row that declared them, not to whichever
          // candidate happens to land first: two providers on the same title
          // routinely carry different subtitle sets, and merging them onto one
          // stream invents tracks that stream does not have.
          const tracks: RawTrackRef[] = [];
          if (Array.isArray(row.subtitles)) {
            const subSeen = new Set<string>();
            for (const s of row.subtitles as { url?: unknown; language?: unknown; label?: unknown; format?: unknown }[]) {
              const su = typeof s?.url === 'string' ? s.url.trim() : '';
              if (!su) continue;
              const sAbs = /^https?:\/\//i.test(su) ? su : su.startsWith('/') ? `${origin}${su}` : `${origin}/${su}`;
              if (!isSafeUpstreamUrl(sAbs) || subSeen.has(sAbs)) continue;
              subSeen.add(sAbs);
              const code = normalizeLanguage(s?.language) ?? 'und';
              const fmt = String(s?.format ?? '').toLowerCase();
              tracks.push({
                lang: code,
                label: typeof s?.label === 'string' && s.label.trim() ? s.label.trim().slice(0, 60) : code.toUpperCase(),
                url: sAbs,
                ...(fmt === 'vtt' || fmt === 'srt' || fmt === 'ass' ? { format: fmt } : {}),
                headers: mediaHeaders,
              });
            }
          }

          out.push({
            key: absolute,
            url: absolute,
            type: inferType(absolute, row.type),
            quality,
            ...(Number.isFinite(height) && height >= 200 ? { qualityLadder: [height] } : {}),
            // Declared, not verified. The registry proves audio from the manifest.
            ...(lang ? { claimedAudioLang: lang } : {}),
            ...(langs.length ? { availableAudioLangs: langs } : {}),
            ...(tracks.length ? { subtitles: tracks } : {}),
            headers: mediaHeaders,
            // Provider order encodes its own priority; keep it but stay behind
            // the origin CDNs we resolve directly.
            rank: cfg.rank + Math.min(out.length, 30),
          });


          // Intro / credits markers, when the provider supplies them.
          const intro = row.intro;
          if (!haveSegments && intro && Number.isFinite(Number(intro.start)) && Number.isFinite(Number(intro.end))) {
            segments.intro = [Number(intro.start), Number(intro.end)];
            haveSegments = true;
          }
          if (!segments.outro && row.credits && Number.isFinite(Number(row.credits.start)) && Number.isFinite(Number(row.credits.end))) {
            segments.outro = [Number(row.credits.start), Number(row.credits.end)];
            haveSegments = true;
          }

          if (out.length >= 40) break;
        }

        if (out.length === 0) {
          diag(false, `greybox rows=${rows.length} no-playable-url`);
          return { candidates: [] };
        }

        diag(true, `greybox candidates=${out.length} langs=${langs.length}`);
        return { candidates: out, ...(haveSegments ? { segments } : {}) };
      } catch (error) {
        diag(false, `greybox ${(error as Error).name}`);
        return { candidates: [] };
      }
    },
  };
}
