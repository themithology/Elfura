// @ts-nocheck
import { sourceEnv } from './index.js';
const DEFAULT_ORIGIN = 'https://vidly.pro';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
/**
 * The only two media hosts observed serving bytes. Measured, not guessed: a page
 * fetch on the runner returned exactly these, and the third host seen next to
 * them (`dash-hls-bridge.john1mc.workers.dev`) is a refused third-party bridge.
 */
const OWN_MEDIA_HOST = /^(?:img|gzip)\.rousav\.tech$/i;
/**
 * A watch page is ~50 KB of HTML. Anything vastly larger is not the page we
 * measured, and reading all of it would be unbounded work per resolve.
 */
const MAX_PAGE_BYTES = 2_000_000;
/**
 * MEASURED on runners 2026-11-25: page fetch for movie/550 answered in roughly
 * 1–2s including TLS. This is one HTML request per resolve, not an aggregation,
 * so the lane does not need an extended discovery budget and does not declare one.
 */
const PAGE_TIMEOUT_MS = 9000;
/** Manifest URLs already in the page markup. No decryption is involved. */
export function embeddedManifests(html) {
    const found = new Set();
    const patterns = [
        /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi,
        /https?:\/\/[^\s"'<>\\]+?\.mpd[^\s"'<>\\]*/gi,
    ];
    for (const pattern of patterns) {
        for (const match of html.matchAll(pattern)) {
            // The page embeds JSON-escaped URLs often enough that the literal text can
            // contain a trailing escape; strip it before validation.
            found.add(match[0].replace(/\\+$/, ''));
        }
    }
    return [...found];
}
/** Quality from the path, when the provider has already encoded it. */
export function qualityOf(url) {
    const height = url.match(/\b(2160|1440|1080|720|480|360)p\b/i)?.[1];
    return height ? `${height}p` : 'auto';
}
/**
 * Embedded URLs → candidates, applying every refusal above.
 *
 * Exported because the refusals are the interesting part and deserve a test that
 * needs no network.
 */
export function vidlyCandidates(html, pageUrl) {
    const out = [];
    const seen = new Set();
    for (const raw of embeddedManifests(html)) {
        if (out.length >= 8)
            break;
        let url;
        try {
            url = new URL(raw);
        }
        catch {
            continue;
        }
        if (url.protocol !== 'https:' || url.username || url.password)
            continue;
        // The allowlist IS the refusal rule. Everything else in this page belongs to
        // somebody else, including the bridge that 502s.
        if (!OWN_MEDIA_HOST.test(url.hostname))
            continue;
        if (seen.has(url.href))
            continue;
        seen.add(url.href);
        const type = /\.mpd(?:[?#]|$)/i.test(url.href) ? 'dash' : 'hls';
        out.push({
            key: url.href,
            url: url.href,
            type,
            quality: qualityOf(url.href),
            // The page carries media for this title and nothing else; a single row is
            // the normal case. Rank by discovery order, and let measured bytes decide.
            rank: out.length,
            headers: { 'User-Agent': UA, Referer: pageUrl, Origin: DEFAULT_ORIGIN },
            // Scoping the whole relay to the measured media host means an HLS child
            // pointing anywhere else is refused by the proxy itself, not just here.
            restrictedOrigin: `https://${url.hostname}`,
        });
    }
    return out;
}
export function createVidlyAdapter(options = {}) {
    const env = sourceEnv();
    const origin = (options.origin ?? env.ELFURA_VIDLY_ORIGIN?.trim() ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? fetch;
    return {
        id: 'source-4',
        label: 'Source 4',
        enabled: () => (env.ELFURA_VIDLY_ENABLED ?? '1') !== '0',
        async resolve(query) {
            if (!/^\d{1,12}$/.test(query.tmdbId))
                return { candidates: [] };
            const isTv = query.type === 'tv';
            const season = isTv ? query.season ?? 1 : 0;
            const episode = isTv ? query.episode ?? 1 : 0;
            if (isTv && (!Number.isSafeInteger(episode) || episode < 1))
                return { candidates: [] };
            // The site routes movies and episodes by different paths and both were
            // measured; building the wrong one is a 404, not an empty title.
            const path = isTv
                ? `/watch/tv/${query.tmdbId}/${season}/${episode}`
                : `/watch/movie/${query.tmdbId}`;
            const pageUrl = `${origin}${path}`;
            const local = new AbortController();
            const timer = setTimeout(() => local.abort(), PAGE_TIMEOUT_MS);
            let html;
            try {
                const response = await fetchImpl(pageUrl, {
                    headers: { 'User-Agent': UA, Accept: 'text/html', Referer: `${origin}/` },
                    redirect: 'follow',
                    signal: query.signal ?? local.signal,
                });
                if (!response.ok) {
                    await response.body?.cancel().catch(() => { });
                    return { candidates: [] };
                }
                const declared = Number(response.headers.get('content-length') || 0);
                if (declared > MAX_PAGE_BYTES) {
                    await response.body?.cancel().catch(() => { });
                    return { candidates: [] };
                }
                html = await response.text();
                if (html.length > MAX_PAGE_BYTES)
                    return { candidates: [] };
            }
            catch {
                return { candidates: [] };
            }
            finally {
                clearTimeout(timer);
            }
            return { candidates: vidlyCandidates(html, pageUrl) };
        },
    };
}
