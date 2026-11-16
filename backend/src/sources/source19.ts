/**
 * DesiDubAnime — Hindi / Tamil / Telugu / multi-audio dubbed anime (Source 19)
 * ===========================================================================
 * WordPress + "Kiranime Pro" site, resolved entirely server-side:
 *
 *   search   : /wp-json/wp/v2/anime?search=<title>   (JSON, no scraping of the
 *              theme's card markup for matching)
 *   episodes : /watch/ pages, `.episode-list-item` anchors carry number + title
 *   servers  : <span data-embed-id="b64(name):b64(url)">
 *              - Streamp2p  -> /api/v1/video?id=<id> returns hex, AES-128-CBC
 *                (key `kiemtienmua911ca`, iv `1234567890oiuytr`) wrapping JSON
 *                with `cfNative` / `source` HLS URLs and subtitle tracks.
 *              - VidMoly    -> plain JW-Player setup exposing a master.m3u8
 *                (multi-audio) plus English VTT.
 *              Mirrordub / Abyss / filesforever are encrypted multi-host
 *              wrappers and are deliberately ignored.
 *
 * Only HLS playlists leave this adapter; everything is verified through the
 * shared liveness probe like any other lane.
 */
import crypto from 'node:crypto';
import { isSafeUpstreamUrl } from '../security.js';
import { candidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { normalizeLang } from './lang.js';
import type { RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://www.desidubanime.me';
const P2P_KEY = 'kiemtienmua911ca';
const P2P_IV = '1234567890oiuytr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_SERVERS = 6;
const MAX_CANDIDATES = 6;

const SUB_LANG: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  ja: 'Japanese',
  es: 'Spanish',
  ar: 'Arabic',
};

function decodeEntities(value: string): string {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return SITE;
  }
}

function absUrl(value: string, base: string): string {
  const raw = String(value ?? '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  return `${originOf(base)}${raw.startsWith('/') ? '' : '/'}${raw}`;
}

function base64Text(value: string): string {
  try {
    return Buffer.from(String(value).replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function getText(
  url: string,
  signal: AbortSignal,
  accept = 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
): Promise<{ status: number; body: string; url: string } | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: accept, Referer: `${SITE}/` },
      redirect: 'follow',
      signal,
    });
    const body = await readBounded(response, MAX_HTML_BYTES);
    if (body === null) return null;
    const finalUrl = response.url || url;
    if (!isSafeUpstreamUrl(finalUrl)) return null;
    return { status: response.status, body, url: finalUrl };
  } catch {
    return null;
  }
}

/** Title normalisation used only for match scoring (never shown to clients). */
function titleKey(value: string): string {
  return decodeEntities(String(value ?? ''))
    .toLowerCase()
    .replace(/\((?:hindi|tamil|telugu|english|multi|dub|sub)[^)]*\)/gi, ' ')
    .replace(/\b(?:season|part)\s*\d+\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Find the best WordPress anime post for a title. */
export async function searchDesiDub(
  title: string,
  signal: AbortSignal,
): Promise<{ link: string; title: string } | null> {
  const wanted = titleKey(title);
  if (!wanted) return null;
  const endpoint = `${SITE}/wp-json/wp/v2/anime?search=${encodeURIComponent(title)}&per_page=6&_fields=id,slug,link,title`;
  const response = await getText(endpoint, signal, 'application/json');
  if (!response || response.status >= 400) return null;
  let rows: unknown;
  try {
    rows = JSON.parse(response.body) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  let best: { link: string; title: string; score: number } | null = null;
  for (const row of rows.slice(0, 6)) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as { link?: unknown; title?: { rendered?: unknown } };
    const link = typeof entry.link === 'string' ? entry.link : '';
    const rendered = typeof entry.title?.rendered === 'string' ? stripTags(entry.title.rendered) : '';
    if (!link || !/^https?:\/\//i.test(link) || !isSafeUpstreamUrl(link)) continue;
    const candidateKey = titleKey(rendered);
    let score = 0;
    if (candidateKey === wanted) score = 3;
    else if (candidateKey.startsWith(wanted) || wanted.startsWith(candidateKey)) score = 2;
    else if (candidateKey.includes(wanted) || wanted.includes(candidateKey)) score = 1;
    if (score === 0) continue;
    if (!best || score > best.score) best = { link, title: rendered, score };
  }
  return best ? { link: best.link, title: best.title } : null;
}

interface EpisodeLink {
  url: string;
  number: number;
}

/** `.episode-list-item` anchors (number + href). */
export function parseEpisodeLinks(html: string, base: string): EpisodeLink[] {
  const out: EpisodeLink[] = [];
  const seen = new Set<string>();
  const re = /<a\b([^>]*\bepisode-list-item\b[^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const href = (match[1].match(/href="([^"]+)"/i) || [])[1];
    if (!href || !/\/watch\//i.test(href)) continue;
    const url = absUrl(decodeEntities(href), base);
    if (seen.has(url) || !isSafeUpstreamUrl(url)) continue;
    seen.add(url);
    const query = (match[1].match(/data-episode-search-query="([^"]*)"/i) || [])[1] || '';
    const fromUrl = url.match(/-episode-(\d+)(?:[-/]|$)/i) || url.match(/-(\d+)x(\d+)(?:[-/]|$)/i);
    const number = Number.parseFloat(query) || Number(fromUrl?.[fromUrl.length - 1] ?? '') || 0;
    out.push({ url, number: Number.isFinite(number) ? number : 0 });
  }
  return out;
}

/** All `/watch/` links on an anime page (the newest episode is usually first). */
export function parseWatchLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href="([^"]*\/watch\/[^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const url = absUrl(decodeEntities(match[1]), base);
    if (seen.has(url) || !isSafeUpstreamUrl(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function seasonEpisodeOf(url: string): { season?: number; episode?: number } {
  const x = url.match(/-(\d+)x(\d+)(?:[-/]|$)/i);
  if (x) return { season: Number(x[1]), episode: Number(x[2]) };
  const season = url.match(/-season-(\d+)(?:[-/]|$)/i);
  const episode = url.match(/-episode-(\d+)(?:[-/]|$)/i);
  return {
    ...(season ? { season: Number(season[1]) } : {}),
    ...(episode ? { episode: Number(episode[1]) } : {}),
  };
}

/** Pick the watch page for `season`/`episode`, reading the episode list only when needed. */
async function resolveWatchPage(
  animePageHtml: string,
  pageUrl: string,
  season: number,
  episode: number,
  signal: AbortSignal,
): Promise<string | null> {
  const links = parseWatchLinks(animePageHtml, pageUrl);
  if (links.length === 0) return null;

  const exact = links.find((link) => {
    const parts = seasonEpisodeOf(link);
    return parts.episode === episode && (parts.season === undefined || parts.season === season);
  });
  if (exact) return exact;

  const sample = await getText(links[0], signal);
  if (sample) {
    const listed = parseEpisodeLinks(sample.body, sample.url);
    const bySeason = listed.find((link) => {
      const parts = seasonEpisodeOf(link.url);
      return link.number === episode && parts.season === season;
    });
    if (bySeason) return bySeason.url;
    const byNumber = listed.find((link) => link.number === episode);
    if (byNumber) return byNumber.url;
  }

  const loose = links.find((link) => seasonEpisodeOf(link).episode === episode);
  return loose ?? null;
}

interface EmbedServer {
  name: string;
  url: string;
}

/** `data-embed-id="b64(name):b64(url)"` plus a bare `<iframe>` fallback. */
export function parseEmbedServers(html: string): EmbedServer[] {
  const out: EmbedServer[] = [];
  const seen = new Set<string>();
  const re = /data-embed-id="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const raw = decodeEntities(match[1]);
    const split = raw.indexOf(':');
    if (split <= 0) continue;
    const name = base64Text(raw.slice(0, split)).trim();
    let url = base64Text(raw.slice(split + 1)).trim();
    if (!/^https?:\/\//i.test(url)) {
      const iframe = url.match(/src\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
      if (iframe) url = decodeEntities(iframe[1]);
    }
    if (!/^https?:\/\//i.test(url) || !isSafeUpstreamUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ name: name || 'Server', url });
    if (out.length >= MAX_SERVERS) break;
  }
  if (out.length === 0) {
    const iframe = html.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/i);
    if (iframe && isSafeUpstreamUrl(iframe[1])) out.push({ name: 'Server', url: decodeEntities(iframe[1]) });
  }
  return out;
}

function isP2PHost(url: string): boolean {
  return /^https?:\/\/[^/]*(?:p2pplay|strp2p|rpmstream|upns)\.[^/]+\//i.test(url) && url.includes('#');
}

function isVidMolyHost(url: string): boolean {
  return /^https?:\/\/(?:www\.)?vidmoly\.[a-z]+\//i.test(url);
}

function qualityOf(value: string): string {
  const match = String(value ?? '').match(/\b(2160|1440|1080|720|576|480|360|240)p\b/i);
  if (match) return `${match[1]}p`;
  if (/\b4k\b/i.test(value)) return '2160p';
  return 'auto';
}

const AUDIO_TOKEN =
  /\b((?:Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|English|Eng|Japanese|Jap|Korean|Kor)(?:[-+_ ](?:Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|English|Eng|Japanese|Jap|Korean|Kor))*)\b/i;

function audioOf(value: string): { code: string; label: string } | null {
  const match = String(value ?? '').match(AUDIO_TOKEN);
  if (!match) return null;
  const normalized = normalizeLang(match[1].replace(/[_+]/g, '-'));
  if (!normalized.code || normalized.code === 'und') return null;
  return { code: normalized.code, label: normalized.label };
}

/** Streamp2p: hex body -> AES-128-CBC JSON -> HLS urls. */
export async function extractStreamp2p(
  server: EmbedServer,
  signal: AbortSignal,
): Promise<RawStreamCandidate[]> {
  const origin = originOf(server.url);
  const fragment = server.url.split('#')[1] ?? '';
  const id = fragment.replace(/^\/+/, '').split(/[?&/]/)[0];
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) return [];
  const endpoint =
    `${origin}/api/v1/video?id=${encodeURIComponent(id)}` +
    `&w=1920&h=1080&r=${encodeURIComponent(SITE.replace(/^https?:\/\//i, ''))}`;
  const response = await getText(endpoint, signal, '*/*');
  if (!response || response.status >= 400) return [];
  const hex = response.body.trim();
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 32 !== 0) return [];

  let payload: unknown;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-128-cbc',
      Buffer.from(P2P_KEY, 'utf8'),
      Buffer.from(P2P_IV, 'utf8'),
    );
    const plain = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('utf8');
    payload = JSON.parse(plain.replace(/[\u0000-\u001f]+$/g, ''));
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const row = payload as { cfNative?: unknown; source?: unknown; title?: unknown; subtitle?: unknown };

  const headers = { 'User-Agent': UA, Referer: `${origin}/`, Origin: origin };
  const subtitles: RawTrackRef[] = [];
  if (row.subtitle && typeof row.subtitle === 'object' && !Array.isArray(row.subtitle)) {
    for (const [code, value] of Object.entries(row.subtitle as Record<string, unknown>)) {
      if (typeof value !== 'string' || !value) continue;
      const track = absUrl(value.split('#')[0], origin);
      if (!/\.(?:vtt|srt)(?:[?#]|$)/i.test(track) || !isSafeUpstreamUrl(track)) continue;
      subtitles.push({ lang: code, label: SUB_LANG[code] ?? code.toUpperCase(), url: track, format: /\.srt/i.test(track) ? 'srt' : 'vtt' });
    }
  }

  const label = typeof row.title === 'string' ? row.title : '';
  const audio = audioOf(label);
  const quality = qualityOf(label);
  const out: RawStreamCandidate[] = [];
  for (const [index, raw] of [row.cfNative, row.source].entries()) {
    if (typeof raw !== 'string' || !raw) continue;
    const url = absUrl(raw, origin);
    if (!/\.m3u8(?:[?#]|$)/i.test(url) || !isSafeUpstreamUrl(url)) continue;
    out.push({
      key: url,
      url,
      type: 'hls',
      quality,
      headers,
      // This provider serves HLS from its own edge front; those hosts are its
      // CDN, not a third-party relay, so the lane races on equal footing.
      rank: 40 + index,
      ...(audio ? { claimedAudioLang: audio.code, audioLabel: audio.label } : {}),
      ...(subtitles.length ? { subtitles } : {}),
    });
  }
  return out;
}

/** VidMoly: JW Player setup with a master.m3u8 (usually multi-audio). */
export async function extractVidMoly(
  server: EmbedServer,
  signal: AbortSignal,
): Promise<RawStreamCandidate[]> {
  const response = await getText(server.url, signal);
  if (!response || response.status >= 400) return [];
  const html = response.body;
  const master =
    (html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*['"]([^'"]+)['"]/) || [])[1] ||
    (html.match(/file\s*:\s*['"](https?:[^'"]+\.m3u8[^'"]*)['"]/) || [])[1];
  if (!master) return [];
  const origin = originOf(response.url);
  const url = absUrl(master, origin);
  if (!isSafeUpstreamUrl(url) || !/\.m3u8(?:[?#]|$)/i.test(url)) return [];

  const subtitles: RawTrackRef[] = [];
  const subRe = /file\s*:\s*['"]([^'"]+\.vtt)['"]\s*,\s*label\s*:\s*['"]([^'"]*)['"]/gi;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = subRe.exec(html))) {
    const track = absUrl(match[1], origin);
    if (seen.has(track) || !isSafeUpstreamUrl(track)) continue;
    seen.add(track);
    const label = match[2] || 'English';
    const normalized = normalizeLang(label);
    subtitles.push({
      lang: normalized.code !== 'und' ? normalized.code : 'en',
      label: normalized.code !== 'und' ? normalized.label : label,
      url: track,
      format: 'vtt',
    });
  }

  const audio = audioOf(server.name);
  return [
    {
      key: url,
      url,
      type: 'hls',
      quality: 'auto',
      headers: { 'User-Agent': UA, Referer: `${origin}/`, Origin: origin },
      rank: 45,
      ...(audio ? { claimedAudioLang: audio.code, audioLabel: audio.label } : {}),
      ...(subtitles.length ? { subtitles } : {}),
    },
  ];
}

export async function fetchFromDesiDub(query: SourceQuery): Promise<RawStreamCandidate[]> {
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1)) {
    return [];
  }
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(7000)])
    : AbortSignal.timeout(7000);

  const meta = query.title
    ? { title: query.title }
    : await query.resolveMetaFallback?.().catch(() => undefined);
  const title = meta?.title?.trim();
  if (!title) return [];

  const match = await searchDesiDub(title, signal);
  if (!match) return [];

  const animePage = await getText(match.link, signal);
  if (!animePage) return [];

  const watchUrl = await resolveWatchPage(animePage.body, animePage.url, season, episode, signal);
  if (!watchUrl) return [];

  const watchPage = await getText(watchUrl, signal);
  if (!watchPage) return [];

  const servers = parseEmbedServers(watchPage.body);
  const jobs = servers.slice(0, MAX_SERVERS).map(async (server) => {
    try {
      if (isP2PHost(server.url)) return await extractStreamp2p(server, signal);
      if (isVidMolyHost(server.url)) return await extractVidMoly(server, signal);
      return [];
    } catch {
      return [];
    }
  });
  const rows = (await Promise.all(jobs)).flat();

  const out: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of rows) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    out.push(candidate);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out.sort((a, b) => a.rank - b.rank);
}

export function createSource19Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-19',
    label: 'Source 19',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const raw = await fetchFromDesiDub(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const usable = checked.candidates.filter((candidate) => !!candidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-19',
        lane: 'DD',
        ok: usable.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},reachable=${usable.length}`,
      });
      return {
        candidates: usable.map((candidate) =>
          query.diag ? { ...candidate, diagnosticLane: 'DD' } : candidate,
        ),
      };
    },
  };
}
