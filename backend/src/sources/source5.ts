/** Vidara direct HLS. The public API resolves file codes, not TMDB IDs.
 * This deliberately tiny verified mapping is not a general catalogue: never
 * guess a file code or use a third-party catalogue's unverified TMDB mapping.
 */
import { isSafeUpstreamUrl } from '../security.js';
import type { SourceAdapter, SourceQuery } from './types.js';

const ORIGIN = 'https://vidara.to';
// The upstream reports "Nilakanta (2026)" for this file. Check again on
// every resolution so a recycled code cannot silently play a different title.
const MOVIES: Readonly<Record<string, { code: string; title: RegExp }>> = {
  '1107009': { code: 'fea967f75055', title: /^nilakanta\s*\(2026\)$/i },
};

export function createVidaraAdapter(enabled = true): SourceAdapter {
  return {
    id: 'source-5', label: 'Source 5', enabled: () => enabled,
    async resolve(query: SourceQuery) {
      const entry = query.type === 'movie' ? MOVIES[query.tmdbId] : undefined;
      if (!entry) return { candidates: [] };
      const start = Date.now();
      try {
        const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
        const res = await fetch(`${ORIGIN}/api/stream`, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', Referer: `${ORIGIN}/`, Origin: ORIGIN },
          body: JSON.stringify({ filecode: entry.code, device: 'web' }),
        });
        if (!res.ok) return { candidates: [] };
        const data = await res.json() as { title?: unknown; streaming_url?: unknown };
        if (typeof data.title !== 'string' || !entry.title.test(data.title.trim()) || typeof data.streaming_url !== 'string') return { candidates: [] };
        const url = new URL(data.streaming_url);
        if (url.protocol !== 'https:' || url.username || url.password || !isSafeUpstreamUrl(url.href) ||
            !/(?:^|\.)(?:s1q2105\.com|97bf1\.com)$/i.test(url.hostname) || !/\.m3u8$/i.test(url.pathname)) return { candidates: [] };
        query.diag?.push({ adapter: 'source-5', lane: 'vidara', ok: true, ms: Date.now() - start, detail: 'candidate=1 (curated title)' });
        return { candidates: [{ key: 'vidara-curated-1107009', diagnosticLane: 'vidara', type: 'hls' as const,
          url: url.href, headers: { Referer: `${ORIGIN}/`, Origin: ORIGIN }, quality: 'auto', rank: 0,
          multiAudio: true, requireVerifiedMultiAudio: true }] };
      } catch {
        query.diag?.push({ adapter: 'source-5', lane: 'vidara', ok: false, ms: Date.now() - start, detail: 'upstream failed' });
        return { candidates: [] };
      }
    },
  };
}
