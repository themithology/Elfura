/**
 * Direct multi-audio anime lane, tested through registry -> relay -> browser.
 * Catalogue requests stay server side; the player only receives Elfura's sealed
 * media tickets. Audio languages and quality are harvested from the manifest.
 *
 * The catalogue's season numbering can differ from TMDB. Restrict the lane to
 * season 1 and require its episode title to match TMDB's episode title exactly;
 * an absent/ambiguous title is not a reason to guess a match.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { readBoundedText } from './upstream-fetch.js';
import type { RawSourceResult, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://animesalt.cx';
const PLAYER = 'https://ravok.buzz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAX_PAGE = 1_500_000;
const empty = (): RawSourceResult => ({candidates: []});

function unescapeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = {'&amp;':'&', '&quot;':'"', '&apos;':"'", '&lt;':'<', '&gt;':'>'};
    const fixed = named[entity.toLowerCase()];
    if (fixed !== undefined) return fixed;
    const hex = /^&#x([\da-f]+);$/i.exec(entity);
    const dec = /^&#(\d+);$/.exec(entity);
    const code = hex ? parseInt(hex[1],16) : dec ? parseInt(dec[1],10) : 0;
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
function normalizeTitle(value: string): string {
  return unescapeHtml(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
export function titleSlug(title: string): string | null {
  const clean = normalizeTitle(title).replace(/ /g, '-');
  return clean.length >= 2 && clean.length <= 120 ? clean : null;
}
export function matchesEpisodeTitle(html: string, expected: string): boolean {
  const pageTitle = html.match(/<title\b[^>]*>([^<]+)<\/title\s*>/i)?.[1]?.replace(/\s*[-–|]\s*Anime\s*Salt\s*$/i, '') ?? '';
  const a = normalizeTitle(pageTitle);
  const b = normalizeTitle(expected);
  // A placeholder episode title is not a unique identity check.
  return b.length >= 5 && !/^(?:episode|ep)\s*\d+$/i.test(b) && a === b;
}
export function findPlayer(html: string): string | null {
  for (const match of html.matchAll(/<iframe\b[^>]*>/gi)) {
    const raw = match[0].match(/(?:^|\s)(?:data-src|src)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!raw) continue;
    try {
      const url = new URL(unescapeHtml(raw), SITE);
      if (url.origin === PLAYER && !url.username && !url.password && !url.search && !url.hash && /^\/video\/[a-f0-9]{16,64}\/?$/i.test(url.pathname)) return url.href;
    } catch { /* skip */ }
  }
  return null;
}

type PageFetch = (url: string, signal: AbortSignal) => Promise<string | null>;
const defaultPageFetch: PageFetch = async (url, signal) => {
  // Runtime ZIPs install this native client optionally. If unavailable, only
  // this lane is skipped; the backend and other providers must still start.
  const { fetch: browserFetch } = await import('wreq-js');
  const response = await browserFetch(url, {browser:'chrome_149',os:'windows',headers:{'User-Agent':UA,Referer:SITE+'/'},signal,timeout:6000,redirect:'error'});
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
  const len = Number(response.headers.get('content-length') || 0);
  if (len > MAX_PAGE) { await response.body?.cancel().catch(() => {}); return null; }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > MAX_PAGE) return null;
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
};

export function createSource28Adapter(enabled: () => boolean = () => true, options: {fetchPage?: PageFetch} = {}): SourceAdapter {
  return {
    id:'source-28', label:'Source 28', enabled,
    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      const started = Date.now();
      const diag = (ok: boolean, detail: string) => query.diag?.push({adapter:'source-28',lane:'anime-hls',ok,ms:Date.now()-started,detail});
      if (!enabled() || query.type !== 'tv' || !/^\d{1,12}$/.test(query.tmdbId) || (query.season ?? 1) !== 1 || !Number.isSafeInteger(query.episode ?? 1) || (query.episode ?? 1) < 1 || (query.episode ?? 1) > 5000) return empty();
      const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(8500)]) : AbortSignal.timeout(8500);
      try {
        const meta = await query.resolveMetaFallback?.();
        // Limit catalogue requests to positively identified Japanese animation.
        // Missing TMDB metadata is a miss, not permission to search by guess.
        if (meta?.originalLanguage !== 'ja' || !meta.genres?.some(g => g.toLowerCase() === 'animation')) { diag(false,'not-confirmed-anime'); return empty(); }
        const slug = titleSlug(meta.rawTitle ?? query.title ?? '');
        const epName = meta?.episodeName ?? '';
        if (!slug || !epName) { diag(false,'metadata-unavailable'); return empty(); }
        const page = await (options.fetchPage ?? defaultPageFetch)(`${SITE}/episode/${slug}-1x${query.episode ?? 1}/`, signal);
        if (!page || !matchesEpisodeTitle(page, epName)) { diag(false,'episode-unconfirmed'); return empty(); }
        const player = findPlayer(page);
        if (!player) { diag(false,'player-unavailable'); return empty(); }
        const id = new URL(player).pathname.split('/').filter(Boolean).at(-1)!;
        const api = new URL('/player/index.php', PLAYER);
        api.search = new URLSearchParams({data:id,do:'getVideo'}).toString();
        const response = await fetch(api, {method:'POST',redirect:'error',signal,headers:{'User-Agent':UA,'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest',Origin:PLAYER,Referer:player},body:new URLSearchParams({hash:id,r:SITE+'/'}).toString()});
        if (!response.ok) { await response.body?.cancel().catch(() => {}); diag(false,`player-http-${response.status}`); return empty(); }
        const text = await readBoundedText(response,128*1024);
        if (!text) { diag(false,'empty-response'); return empty(); }
        const payload = JSON.parse(text) as {videoSource?: unknown;securedLink?: unknown};
        const src = typeof payload.videoSource === 'string' ? payload.videoSource : payload.securedLink;
        if (typeof src !== 'string') {diag(false,'no-manifest');return empty();}
        const url = new URL(src, PLAYER);
        if (url.protocol !== 'https:' || url.username || url.password || !isSafeUpstreamUrl(url.href)) {diag(false,'unsafe-manifest');return empty();}
        diag(true,'hls-candidate');
        // Real languages and quality ladder are harvested from the manifest by
        // the registry's liveness verifier, never claimed from catalogue text.
        return {candidates:[{key:url.href,url:url.href,type:'hls',quality:'auto',rank:20,headers:{'User-Agent':UA,Referer:PLAYER+'/',Origin:PLAYER}}]};
      } catch { diag(false,signal.aborted?'timeout':'provider-unavailable'); return empty(); }
    },
  };
}
