/**
 * Source 27: TMDB lookup -> direct HLS master with real audio renditions.
 * The intermediate pages are used only by the resolver; the browser receives
 * only a proxied stream URL. No page URLs or invented audio labels escape.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { readBoundedText } from './upstream-fetch.js';
import type { RawSourceResult, SourceAdapter, SourceQuery } from '../../src/sources/types.js';

const ORIGIN = 'https://rozgarlelo.modiplay.xyz';
const REFERER = 'https://m1.multimovies.courses/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const empty = (): RawSourceResult => ({ candidates: [] });

/** Only same-origin provider paths are accepted, never arbitrary HTML URLs. */
function providerUrl(value: string, base: string, expectedPath: string): string | null {
  try {
    const url = new URL(value.replace(/\\\//g, '/').replace(/&amp;/gi, '&'), base);
    if (url.origin !== ORIGIN || url.pathname !== expectedPath || url.username || url.password || !isSafeUpstreamUrl(url.toString())) return null;
    return url.toString();
  } catch { return null; }
}

export function createSource27Adapter(enabled: () => boolean = () => process.env.ELFURA_CINEVERSE_ENABLED !== '0'): SourceAdapter {
  return {
    id: 'source-27', label: 'Source 27', enabled,
    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      // This endpoint currently ignores the requested TV episode and can
      // return the wrong video. Do not offer it for TV until episode mapping is
      // independently confirmed.
      if (!enabled() || query.type !== 'movie' || !/^\d{1,12}$/.test(query.tmdbId)) return empty();
      const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(9000)]) : AbortSignal.timeout(9000);
      const started = Date.now();
      const diag = (ok: boolean, detail: string) => query.diag?.push({ adapter:'source-27', lane:'direct-hls', ok, ms:Date.now()-started, detail });
      try {
        const api = new URL(`/embed/tmdb/${query.type}`, ORIGIN);
        api.searchParams.set('id', query.tmdbId);
        const first = await fetch(api, { headers:{'User-Agent':UA, Referer:REFERER}, signal, redirect:'error' });
        if (!first.ok) { diag(false, `lookup-http-${first.status}`); return empty(); }
        const html = await readBoundedText(first, 512 * 1024);
        const ref = html?.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
        const player = ref ? providerUrl(ref, api.toString(), '/proxy.php') : null;
        if (!player) { diag(false, 'player-reference-unavailable'); return empty(); }
        const second = await fetch(player, { headers:{'User-Agent':UA, Referer:api.toString()}, signal, redirect:'error' });
        if (!second.ok) { diag(false, `player-http-${second.status}`); return empty(); }
        const script = await readBoundedText(second, 512 * 1024);
        const raw = script?.match(/\b(?:var|let|const)\s+src\s*=\s*["']([^"']*stream_proxy\.php[^"']*)["']/i)?.[1];
        const master = raw ? providerUrl(raw, player, '/stream_proxy.php') : null;
        if (!master) { diag(false, 'manifest-reference-unavailable'); return empty(); }
        diag(true, 'hls-candidate');
        return { candidates:[{ key:master, url:master, type:'hls', quality:'auto', rank:10, headers:{'User-Agent':UA, Referer:player} }] };
      } catch { diag(false, 'lookup-unavailable'); return empty(); }
    },
  };
}
