/**
 * DesiDubAnime direct-site adapter (Source 16).
 *
 * Uses DesiDub's own WordPress catalog, episode pages, server selector and
 * supported public embed resolvers. Only a direct HLS URL extracted from a
 * supported player is emitted; embed-only servers are skipped. SUB/DUB is
 * retained as a provider server choice, never treated as an audio language.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://www.desidubanime.me';
const MAX_TEXT = 1_000_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', Referer: `${SITE}/` };
const MAX_SEARCH_ROWS = 12;
const MAX_SERVERS = 12;
const MAX_CANDIDATES = 6;
const SITE_GAP_MS = 1200;
let siteQueue: Promise<void> = Promise.resolve();
let siteNextAt = 0;
let siteCooldownUntil = 0;

async function waitForSiteSlot(signal: AbortSignal): Promise<void> {
  let release!: () => void;
  const previous = siteQueue;
  siteQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const waitMs = Math.max(siteNextAt, siteCooldownUntil) - Date.now();
    if (waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        const timer = setTimeout(done, waitMs);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        function done() { signal.removeEventListener('abort', abort); resolve(); }
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    siteNextAt = Date.now() + SITE_GAP_MS;
  } finally {
    release();
  }
}

async function fetchUpstream(url: string | URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  if (new URL(String(url)).hostname === new URL(SITE).hostname) await waitForSiteSlot(signal);
  const response = await fetch(url, init);
  if (new URL(String(url)).hostname === new URL(SITE).hostname && response.status === 429) {
    const retry = Number(response.headers.get('retry-after'));
    siteCooldownUntil = Math.max(siteCooldownUntil, Date.now() + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) * 1000 : 60_000));
  }
  return response;
}

async function boundedText(response: Response, maxBytes = MAX_TEXT): Promise<string | null> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function getText(url: string, referer: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetchUpstream(url, {
      headers: { ...HEADERS, Referer: referer }, redirect: 'error', signal,
    }, signal);
    return await boundedText(response);
  } catch {
    return null;
  }
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/gi, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/').trim();
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function titleScore(query: string, title: string): number {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 100;
  if (t.startsWith(`${q} `) || q.startsWith(`${t} `)) return Math.min(q.length, t.length) / Math.max(q.length, t.length) * 84;
  const qt = q.split(' ').filter(x => x.length > 1);
  const tt = new Set(t.split(' ').filter(x => x.length > 1));
  const common = qt.filter(x => tt.has(x)).length;
  return qt.length >= 2 ? common / qt.length * 72 : 0;
}

interface AnimeRow { id: number; slug: string; link: string; title: string; }
async function searchAnime(title: string, signal: AbortSignal): Promise<AnimeRow[]> {
  const url = new URL('/wp-json/wp/v2/anime', SITE);
  url.searchParams.set('search', title.slice(0, 120));
  url.searchParams.set('per_page', String(MAX_SEARCH_ROWS));
  try {
    const response = await fetchUpstream(url, { headers: { ...HEADERS, Accept: 'application/json' }, redirect: 'error', signal }, signal);
    const text = await boundedText(response, 384_000);
    if (!text) return [];
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data.slice(0, MAX_SEARCH_ROWS).flatMap((row: any) => {
      const slug = typeof row?.slug === 'string' ? row.slug : '';
      const link = typeof row?.link === 'string' ? row.link : '';
      const titleText = typeof row?.title?.rendered === 'string' ? row.title.rendered.replace(/<[^>]*>/g, '') : '';
      if (!slug || !titleText || !/^https:\/\/www\.desidubanime\.me\/anime\//i.test(link)) return [];
      return [{ id: Number(row.id) || 0, slug, link, title: titleText }];
    });
  } catch {
    return [];
  }
}

function findEpisodeLinks(html: string): { number: number; url: string }[] {
  const found = new Map<number, string>();
  for (const match of html.matchAll(/href=["'](https:\/\/www\.desidubanime\.me\/watch\/[^"'#?]+|\/watch\/[^"'#?]+)["'][^>]*>([\s\S]{0,500}?)<\/a>/gi)) {
    const url = new URL(decodeHtml(match[1]), SITE);
    const episode = `${url.pathname} ${match[2].replace(/<[^>]*>/g, ' ')}`.match(/episode[-\s]*(\d+(?:\.\d+)?)/i);
    if (episode) found.set(Number(episode[1]), url.href);
  }
  return [...found].map(([number, url]) => ({ number, url })).sort((a, b) => a.number - b.number);
}

function decodeBase64(value: string): string {
  try { return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
  catch { return ''; }
}

interface ServerLink { name: string; url: string; kind: 'sub' | 'dub' | 'raw'; }
function parseServerLinks(html: string): ServerLink[] {
  const out: ServerLink[] = [];
  for (const match of html.matchAll(/data-embed-id=["']([^"']{8,4096})["']/gi)) {
    const value = decodeHtml(match[1]);
    const [name64, url64] = value.split(':', 2);
    if (!name64 || !url64) continue;
    const name = decodeBase64(name64).trim().slice(0, 80);
    const decoded = decodeBase64(url64).trim();
    const iframeSrc = decoded.match(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
    const rawUrl = decodeHtml(iframeSrc || decoded);
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' || url.username || url.password || !isSafeUpstreamUrl(url.href)) continue;
      const lower = name.toLowerCase();
      const kind: ServerLink['kind'] = lower.includes('dub') ? 'dub' : lower.includes('sub') ? 'sub' : 'raw';
      out.push({ name, url: url.href, kind });
      if (out.length >= MAX_SERVERS) break;
    } catch { /* skip malformed/unsafe entry */ }
  }
  return out;
}

function unpackPacked(html: string): string {
  const match = html.match(/eval\(function\(p,a,c,k,e,[rd]\)\{[\s\S]*?return\s+p;?\}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split\(['"]\|['"]\)/);
  if (!match) return html;
  const payload = match[2];
  const radix = Number(match[3]);
  const count = Math.min(Number(match[4]), 12_000);
  const words = match[6].split('|');
  const base = (num: number) => {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let out = '';
    do { out = chars[num % radix] + out; num = Math.floor(num / radix); } while (num > 0);
    return out;
  };
  let result = payload;
  for (let i = count - 1; i >= 0; i--) {
    if (!words[i]) continue;
    result = result.replace(new RegExp(`\\b${base(i)}\\b`, 'g'), words[i]);
  }
  return result;
}

function directM3u8(text: string, baseUrl: string): string | null {
  const match = unpackPacked(text).match(/(?:file|source|src)?\s*[:=]?\s*["']?(https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?)/i)
    || text.match(/(https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?)/i);
  if (!match) return null;
  try {
    const url = new URL(decodeHtml(match[1]), baseUrl);
    return url.protocol === 'https:' && isSafeUpstreamUrl(url.href) ? url.href : null;
  } catch { return null; }
}

async function resolveDesiDubEmbed(server: ServerLink, episodeUrl: string, signal: AbortSignal): Promise<{ url: string; referer: string } | null> {
  const host = new URL(server.url).hostname.toLowerCase();
  const directHosts = ['vidmoly.net', 'vidmoly.to', 'rubyvidhub.com', 'streamruby.com', 'smoothpre.com', 'earnvids.com', 'cloud.desidubanime.me'];
  if (!directHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) return null;
  const html = await getText(server.url, episodeUrl, signal);
  if (!html) return null;
  let pageUrl = server.url;
  let playerHtml = html;
  if (host === 'cloud.desidubanime.me' && /\/external\//i.test(pageUrl)) {
    const path = html.match(/(?:src|href)=["']([^"']*\/play\/[^"']+)["']/i)?.[1];
    if (path) {
      const next = new URL(path, pageUrl);
      if (next.hostname === 'cloud.desidubanime.me' && next.protocol === 'https:') {
        pageUrl = next.href;
        playerHtml = await getText(pageUrl, server.url, signal) || '';
      }
    }
  }
  const url = directM3u8(playerHtml, pageUrl);
  return url ? { url, referer: pageUrl } : null;
}

function subtitleTracks(text: string): RawStreamCandidate['subtitles'] {
  const tracks: NonNullable<RawStreamCandidate['subtitles']> = [];
  for (const match of text.matchAll(/["'](https?:\/\/[^"']+\.(?:vtt|srt)(?:\?[^"']*)?)["']/gi)) {
    const url = decodeHtml(match[1]);
    try {
      if (!isSafeUpstreamUrl(url) || tracks.some(t => t.url === url)) continue;
      tracks.push({ lang: /hin|hindi/i.test(url) ? 'hi' : /tam|tamil/i.test(url) ? 'ta' : /tel|telugu/i.test(url) ? 'te' : 'en', label: /hin|hindi/i.test(url) ? 'Hindi subtitle' : 'Subtitle', url, format: url.toLowerCase().includes('.srt') ? 'srt' : 'vtt' });
      if (tracks.length >= 8) break;
    } catch { /* skip */ }
  }
  return tracks;
}

export async function fetchDesiDub(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (query.type !== 'tv' || !Number.isSafeInteger(query.episode) || (query.episode ?? 0) < 1) return [];
  const meta: { title?: string; rawTitle?: string } = await query.resolveMetaFallback?.().catch(() => ({})) ?? {};
  const titles = [...new Set([query.title, meta.title, meta.rawTitle].map(value => String(value || '').trim()).filter(value => value.length >= 3))];
  const title = titles[0] || '';
  if (!title) return [];
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(6500)]) : AbortSignal.timeout(6500);
  const rows = await searchAnime(title, signal);
  const ranked = rows.map(row => ({ row, score: Math.max(...titles.flatMap(value => [titleScore(value, row.title), titleScore(value, row.slug.replace(/-/g, ' '))])) }))
    .filter(x => x.score >= 65).sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked.length > 1 && ranked[0].score === ranked[1].score && ranked[0].row.slug !== ranked[1].row.slug)) return [];
  const show = ranked[0].row;
  const showHtml = await getText(show.link, `${SITE}/`, signal);
  if (!showHtml) return [];
  const episodes = findEpisodeLinks(showHtml);
  const episodeUrl = episodes.find(e => e.number === query.episode)?.url;
  if (!episodeUrl) return [];
  const episodeHtml = await getText(episodeUrl, show.link, signal);
  if (!episodeHtml) return [];
  const servers = parseServerLinks(episodeHtml);
  const candidates: RawStreamCandidate[] = [];
  for (const server of servers) {
    if (server.kind === 'raw') continue;
    const resolved = await resolveDesiDubEmbed(server, episodeUrl, signal);
    if (!resolved) continue;
    const page = await getText(resolved.url, resolved.referer, signal);
    // A URL is emitted only if the endpoint actually returned an HLS manifest.
    if (!page?.trimStart().startsWith('#EXTM3U')) continue;
    candidates.push({
      key: `${resolved.url}:${server.kind}:${server.name}`,
      url: resolved.url,
      type: 'hls',
      quality: 'auto',
      audioLabel: `${server.kind.toUpperCase()} server · ${server.name} (provider label)`,
      headers: { 'User-Agent': UA, Referer: resolved.referer, Origin: new URL(resolved.referer).origin },
      subtitles: subtitleTracks(page),
      rank: server.kind === 'dub' ? 18 + candidates.length : 24 + candidates.length,
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

export function createSource16Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-16', label: 'Source 16', enabled,
    async resolve(query) {
      const start = Date.now();
      const raw = await fetchDesiDub(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter(candidate => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({ adapter: 'source-16', lane: 'DD', ok: candidates.length > 0, ms: Date.now() - start,
        detail: `directHls=${raw.length},manifestReachable=${candidates.length}` });
      return { candidates: candidates.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'DD' } : candidate) };
    },
  };
}
