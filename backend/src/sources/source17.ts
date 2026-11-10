/**
 * Anikoto direct-site adapter (Source 17).
 * Uses the site's search/watch/AJAX endpoints, then tries the Vidstream
 * save_data.php resolver or a literal HLS URL on a public embed page. Iframe
 * URLs and player-only results are never returned as native streams.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://anikototv.to';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: `${SITE}/`,
};
const MAX_BYTES = 850_000;
const MAX_SERVERS = 12;
const MAX_CANDIDATES = 6;

async function text(response: Response): Promise<string | null> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') || 0) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch { return null; }
  finally { await reader.cancel().catch(() => {}); }
}

async function request(url: string, referer: string, signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { ...HEADERS, Referer: referer }, redirect: 'error', signal });
    return await text(response);
  } catch { return null; }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function score(query: string, candidate: string): number {
  const q = normalize(query); const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.startsWith(`${q} `) || c.startsWith(`${q}:`)) return 88;
  const tokens = q.split(' ').filter(x => x.length > 1);
  const candidateTokens = new Set(c.split(' ').filter(x => x.length > 1));
  const matched = tokens.filter(x => candidateTokens.has(x)).length;
  return tokens.length >= 2 ? matched / tokens.length * 70 : 0;
}
function stripTags(value: string): string { return value.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(); }
function ajaxHtml(value: string): string {
  try {
    const json = JSON.parse(value) as { result?: unknown; data?: { result?: unknown } };
    const fragment = json.result ?? json.data?.result;
    return typeof fragment === 'string' ? fragment : value;
  } catch { return value; }
}
function attr(tag: string, name: string): string {
  const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${safeName}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match?.[2] || '';
}

interface Series { slug: string; title: string; }
async function findSeries(queryTitle: string, signal: AbortSignal): Promise<Series | null> {
  const search = new URL('/filter', SITE);
  search.searchParams.set('keyword', queryTitle.slice(0, 120));
  const html = await request(search.href, `${SITE}/`, signal);
  if (!html) return null;
  const rows: Series[] = [];
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b[^>]*>([\s\S]{0,1500}?)<\/\1>/gi)) {
    const block = match[0];
    const href = block.match(/href=["'](?:https?:\/\/[^/"']+)?\/watch\/([^/?#"']+)/i)?.[1];
    if (!href || /episode|\/ep-/i.test(href)) continue;
    const title = stripTags(block.match(/class=["'][^"']*(?:name|d-title)[^"']*["'][^>]*>([\s\S]{1,300}?)<\//i)?.[1] || attr(block, 'title') || '');
    if (title && !rows.some(row => row.slug === href)) rows.push({ slug: href, title });
    if (rows.length >= 30) break;
  }
  const ranked = rows.map(row => ({ row, score: score(queryTitle, row.title) })).filter(x => x.score >= 65).sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score && ranked[1].row.slug !== ranked[0].row.slug)) return null;
  return ranked[0].row;
}

interface Episode { number: number; ids: string; slug: string; }
function parseEpisodes(html: string, fallbackSlug: string): Episode[] {
  const out = new Map<number, Episode>();
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    const href = attr(tag, 'href');
    const dataNum = attr(tag, 'data-num');
    const context = html.slice(Math.max(0, match.index! - 180), Math.min(html.length, match.index! + tag.length + 260));
    if (!href.includes('/watch/') && !dataNum) continue;
    const number = Number.parseFloat(dataNum || context.match(/(?:episode|ep)[\s\-:#]*(\d+(?:\.\d+)?)/i)?.[1] || '');
    if (!Number.isFinite(number)) continue;
    const slug = href.match(/\/watch\/([^/?#]+)/i)?.[1] || fallbackSlug;
    out.set(number, { number, ids: attr(tag, 'data-ids') || attr(tag, 'data-id'), slug });
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

interface Server { name: string; linkId: string; svId: string; kind: 'sub' | 'dub' | 'raw'; }
function parseServers(html: string): Server[] {
  const out: Server[] = [];
  for (const match of html.matchAll(/<(?:li|div|a)\b[^>]*data-link-id=["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[0];
    const before = html.slice(Math.max(0, match.index! - 2500), match.index!);
    const typeStart = Math.max(before.lastIndexOf('class="type'), before.lastIndexOf("class='type"));
    const groupPrefix = typeStart >= 0 ? before.slice(typeStart) : '';
    const after = html.slice(match.index! + tag.length, match.index! + tag.length + 300);
    const nameText = after.match(/^([\s\S]*?)<\/(?:li|div|a)>/i)?.[1] || after;
    const name = stripTags(nameText).slice(0, 80) || 'Server';
    const typeText = groupPrefix.toLowerCase();
    const kind: Server['kind'] = /\bdub\b/.test(typeText) ? 'dub' : /\bsub\b/.test(typeText) ? 'sub' : 'raw';
    out.push({ name: name.slice(0, 80), linkId: match[1], svId: attr(tag, 'data-sv-id'), kind });
    if (out.length >= MAX_SERVERS) break;
  }
  return out;
}

function directMediaUrl(textBody: string, base: string): string | null {
  const match = textBody.match(/(?:file|source|src)\s*[:=]\s*["'](https?:\/\/[^"']+\.m3u8(?:\?[^"']*)?)["']/i)
    || textBody.match(/(https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?)/i);
  if (!match) return null;
  try {
    const url = new URL(match[1], base);
    return url.protocol === 'https:' && isSafeUpstreamUrl(url.href) ? url.href : null;
  } catch { return null; }
}

async function resolveEmbed(embedUrl: string, epReferer: string, serverName: string, signal: AbortSignal): Promise<{ url: string; referer: string } | null> {
  let parsed: URL;
  try { parsed = new URL(embedUrl); } catch { return null; }
  if (parsed.protocol !== 'https:' || !isSafeUpstreamUrl(parsed.href)) return null;
  const html = await request(parsed.href, epReferer, signal);
  if (!html) return null;
  const lower = serverName.toLowerCase();
  if (lower.includes('vidstream') || lower.includes('vidplay') || lower.includes('vid-')) {
    const epId = html.match(/data-ep-id=["'](\d+)["']/i)?.[1];
    const epType = html.match(/\btype\s*:\s*["'](\w+)["']/i)?.[1];
    const domain = html.match(/domain2_url\s*:\s*["']([^"']+)["']/i)?.[1];
    if (epId && epType && domain) {
      try {
        const api = new URL('/save_data.php', domain);
        api.searchParams.set('id', `${epId}-${epType}`);
        const response = await fetch(api, { headers: { ...HEADERS, Accept: 'application/json,*/*;q=0.8', Referer: epReferer }, redirect: 'error', signal });
        const body = await text(response);
        if (body) {
          const data = JSON.parse(body) as { data?: { sources?: Array<{ url?: string }>; tracks?: Array<{ file?: string; label?: string }> } };
          const source = data.data?.sources?.find(row => typeof row.url === 'string')?.url;
          if (source && /\.m3u8(?:[?#]|$)/i.test(source) && isSafeUpstreamUrl(source)) {
            return { url: source, referer: `${api.origin}/` };
          }
        }
      } catch { /* try a literal direct URL below */ }
    }
  }
  const media = directMediaUrl(html, parsed.href);
  return media ? { url: media, referer: `${parsed.origin}/` } : null;
}

export async function fetchAnikoto(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (query.type !== 'tv' || !Number.isSafeInteger(query.episode) || (query.episode ?? 0) < 1) return [];
  const meta: { title?: string; rawTitle?: string } = await query.resolveMetaFallback?.().catch(() => ({})) ?? {};
  const title = String(query.title || meta.title || meta.rawTitle || '').trim();
  if (title.length < 3) return [];
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(6500)]) : AbortSignal.timeout(6500);
  const series = await findSeries(title, signal);
  if (!series) return [];
  const pageUrl = `${SITE}/watch/${encodeURIComponent(series.slug)}`;
  const page = await request(pageUrl, `${SITE}/`, signal);
  if (!page) return [];
  const animeId = page.match(/id=["']watch-main["'][^>]*data-id=["'](\d+)["']/i)?.[1]
    || page.match(/data-id=["'](\d+)["'][^>]*id=["']watch-main["']/i)?.[1];
  let episodeMarkup = page;
  if (animeId) {
    const ajaxUrl = new URL(`/ajax/episode/list/${encodeURIComponent(animeId)}`, SITE);
    episodeMarkup = ajaxHtml(await request(ajaxUrl.href, pageUrl, signal) || page);
  }
  const episodes = parseEpisodes(episodeMarkup, series.slug);
  const episode = episodes.find(item => item.number === query.episode);
  if (!episode?.ids) return [];
  const listUrl = new URL('/ajax/server/list', SITE);
  listUrl.searchParams.set('servers', episode.ids);
  const listResponse = await request(listUrl.href, `${SITE}/watch/${episode.slug}/ep-${episode.number}`, signal);
  if (!listResponse) return [];
  const listHtml = ajaxHtml(listResponse);
  const servers = parseServers(listHtml).filter(server => server.kind !== 'raw');
  const candidates: RawStreamCandidate[] = [];
  for (const server of servers) {
    const embedEndpoint = new URL('/ajax/server', SITE);
    embedEndpoint.searchParams.set('get', server.linkId);
    if (server.svId) embedEndpoint.searchParams.set('sv', server.svId);
    const epReferer = `${SITE}/watch/${episode.slug}/ep-${episode.number}`;
    const response = await request(embedEndpoint.href, epReferer, signal);
    if (!response) continue;
    let embedUrl = '';
    try {
      const json = JSON.parse(response) as { result?: { url?: string } };
      embedUrl = json.result?.url || '';
    } catch { continue; }
    if (embedUrl.includes('#')) {
      try { embedUrl = Buffer.from(embedUrl.split('#').at(-1) || '', 'base64').toString('utf8'); } catch { /* keep original */ }
    }
    const resolved = await resolveEmbed(embedUrl, epReferer, server.name, signal);
    if (!resolved) continue;
    const manifest = await request(resolved.url, resolved.referer, signal);
    if (!manifest?.trimStart().startsWith('#EXTM3U')) continue;
    candidates.push({
      key: `${resolved.url}:${server.kind}:${server.name}`,
      url: resolved.url,
      type: 'hls',
      quality: 'auto',
      audioLabel: `${server.kind.toUpperCase()} server · ${server.name} (provider label)`,
      headers: { 'User-Agent': UA, Referer: resolved.referer, Origin: new URL(resolved.referer).origin },
      rank: server.kind === 'dub' ? 18 + candidates.length : 24 + candidates.length,
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

export function createSource17Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-17', label: 'Source 17', enabled,
    async resolve(query) {
      const start = Date.now();
      const raw = await fetchAnikoto(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const candidates = checked.candidates.filter(candidate => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({ adapter: 'source-17', lane: 'AK', ok: candidates.length > 0, ms: Date.now() - start,
        detail: `directHls=${raw.length},manifestReachable=${candidates.length}` });
      return { candidates: candidates.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'AK' } : candidate) };
    },
  };
}
