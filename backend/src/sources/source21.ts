/**
 * KMMovies — Bollywood / Hollywood / dual-audio / K-drama catalogue (Source 21)
 * ============================================================================
 * WordPress site with a fully server-rendered catalogue:
 *
 *   search : /?s=<query>  -> <article class="movie-card" aria-label="Title (Year)">
 *   post   : <h1 class="hero-title"> + #download-links → a.dl-btn
 *            each button links to a KMCLOUD share (/s/<id>); the share exposes
 *            provider mirror routes:
 *              /d/<id>/watch_online  -> a native player page whose `videoUrl`
 *                                       (or R2 object) is the playable file
 *              /d/<id>/sonicboom     -> signed worker download
 *            Series posts list one "combined" file per season.
 *   stream : the resolved R2 / worker object URL, served with Range support.
 *
 * Only files that resolve to a direct playable object are returned; Google
 * Drive copies (`/go/<id>/mydirect`) and archive uploads are ignored because
 * they need a browser session and are not seekable video.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://kmmovies.beer';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 3;
const MAX_CANDIDATES = 4;

function decode(value: string): string {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function strip(html: string): string {
  return decode(String(html ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
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

async function getPage(
  url: string,
  signal: AbortSignal,
  extra: Record<string, string> = {},
): Promise<{ body: string; url: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: `${SITE}/`,
        ...extra,
      },
      redirect: 'follow',
      signal,
    });
    const body = await readBounded(response, MAX_HTML_BYTES);
    if (body === null) return null;
    const finalUrl = response.url || url;
    if (!isSafeUpstreamUrl(finalUrl)) return null;
    return { body, url: finalUrl };
  } catch {
    return null;
  }
}

function titleKey(value: string): string {
  return decode(value)
    .toLowerCase()
    .replace(/\((?:19|20)\d{2}\)\s*$/, ' ')
    .replace(/\bs\d{1,2}(?:\s*-\s*s?\d{1,2})?\s*$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface Card {
  url: string;
  title: string;
}

/** Listing cards from a search page. */
export function parseCards(html: string, base = SITE): Card[] {
  const out: Card[] = [];
  const seen = new Set<string>();
  const re = /<article class="movie-card"[^>]*aria-label="([^"]*)"[^>]*>([\s\S]*?)<\/article>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const href = (match[2].match(/<a href="([^"]+)"/) || [])[1];
    if (!href) continue;
    const url = /^https?:\/\//i.test(href) ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`;
    if (seen.has(url) || !isSafeUpstreamUrl(url)) continue;
    seen.add(url);
    out.push({ url, title: decode(match[1]).trim() });
    if (out.length >= 12) break;
  }
  return out;
}

interface KmFile {
  origin: string;
  id: string;
  label: string;
}

/** `<a href="https://one.kmcloud.lol/s/<id>" class="dl-btn">` entries. */
export function parseDlButtons(html: string): KmFile[] {
  const out: KmFile[] = [];
  const seen = new Set<string>();
  const re = /<a href="([^"]+)" class="dl-btn[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const share = match[1].match(/^https?:\/\/([a-z0-9.-]*kmcloud\.[a-z]+)\/s\/([A-Za-z0-9_-]+)/i);
    if (!share) continue;
    const origin = `https://${share[1]}`;
    const id = share[2];
    if (seen.has(`${origin}/${id}`) || !isSafeUpstreamUrl(origin)) continue;
    seen.add(`${origin}/${id}`);
    const resolution = strip((match[2].match(/class="dl-res">([\s\S]*?)<\/span>/) || [])[1]);
    const size = strip((match[2].match(/class="dl-size">([\s\S]*?)<\/span>/) || [])[1]);
    out.push({ origin, id, label: [resolution, size].filter(Boolean).join(' · ') });
  }
  return out;
}

function qualityOf(label: string): string {
  const match = String(label ?? '').match(/(\d{3,4})p/i);
  return match ? `${match[1]}p` : 'auto';
}

/**
 * Season markers in a series post. Only "combined" season files are usable
 * without walking every episode page, so the parser keeps those.
 */
export function parseSeasonFiles(html: string): Map<number, KmFile[]> {
  const result = new Map<number, KmFile[]>();
  const start = html.indexOf('id="download-links"');
  if (start < 0) return result;
  const section = html.slice(start);
  const blocks = section.split(/<div class="season-block(?:\s+open)?\s*">/).slice(1);
  for (const block of blocks) {
    const header = strip((block.match(/class="season-block-title">([\s\S]*?)<\/span>/) || [])[1]);
    const season = Number((header.match(/Season\s*(\d+)/i) || [])[1] || 0) || 1;
    const combined = (block.match(/data-type="combined-\d+">([\s\S]*?)<\/div>\s*<\/div>/) || [])[1] || '';
    const files = parseDlButtons(combined);
    if (files.length) result.set(season, files);
  }
  return result;
}

/** Resolve a KMCLOUD share to a direct playable object URL. */
export async function resolveKmFile(file: KmFile, signal: AbortSignal): Promise<string | null> {
  const watch = await getPage(`${file.origin}/d/${file.id}/watch_online`, signal, {
    Referer: `${file.origin}/s/${file.id}`,
    Range: 'bytes=0-0',
  });
  if (watch) {
    const query = watch.url.match(/[?&]videoUrl=([^&#]+)/) || watch.body.match(/videoUrl=([^"'&\s]+)/);
    if (query) {
      try {
        const decoded = decodeURIComponent(query[1]);
        if (/^https?:\/\//i.test(decoded) && isSafeUpstreamUrl(decoded)) return decoded;
      } catch {
        /* ignore malformed encoding */
      }
    }
    const r2 = watch.body.match(/https?:\/\/[a-z0-9.-]+\.r2\.dev\/[^"'\s<>]+/i);
    if (r2 && isSafeUpstreamUrl(decode(r2[0]))) return decode(r2[0]);
  }
  const sonic = await getPage(`${file.origin}/d/${file.id}/sonicboom`, signal, {
    Referer: `${file.origin}/s/${file.id}`,
  });
  if (!sonic) return null;
  const signed = sonic.body.match(/href="(\?file=[^"]*(?:dl=r2|dl=worker)[^"]*)"/);
  if (!signed) return null;
  const url = `${sonic.url.replace(/\?.*$/, '')}${decode(signed[1])}`;
  return isSafeUpstreamUrl(url) ? url : null;
}

export async function fetchFromKmMovies(query: SourceQuery): Promise<RawStreamCandidate[]> {
  const season = query.season ?? 1;
  const episode = query.episode ?? 1;
  if (query.type === 'tv' && (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1)) {
    return [];
  }
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(9000)])
    : AbortSignal.timeout(9000);

  const meta = query.title ? { title: query.title } : await query.resolveMetaFallback?.().catch(() => undefined);
  const title = meta?.title?.trim();
  if (!title) return [];
  const wanted = titleKey(title);
  if (!wanted) return [];

  const search = await getPage(`${SITE}/?s=${encodeURIComponent(title)}`, signal);
  if (!search) return [];
  const cards = parseCards(search.body, SITE);
  let best: { url: string; score: number } | null = null;
  for (const card of cards) {
    const key = titleKey(card.title);
    let score = 0;
    if (key === wanted) score = 3;
    else if (key.startsWith(wanted) || wanted.startsWith(key)) score = 2;
    else if (key.includes(wanted) || wanted.includes(key)) score = 1;
    if (score === 0) continue;
    if (!best || score > best.score) best = { url: card.url, score };
  }
  if (!best) return [];

  const post = await getPage(best.url, signal);
  if (!post) return [];

  let files: KmFile[] = [];
  if (query.type === 'tv') {
    const seasons = parseSeasonFiles(post.body);
    files = seasons.get(season) ?? (seasons.size === 1 ? [...seasons.values()][0] : []);
  } else {
    files = parseDlButtons(post.body);
  }
  if (!files.length) return [];

  const ranked = [...files]
    .sort((a, b) => (Number(qualityOf(b.label).replace(/\D/g, '')) || 0) - (Number(qualityOf(a.label).replace(/\D/g, '')) || 0))
    .slice(0, MAX_FILES);

  const resolved = await Promise.all(
    ranked.map(async (file, index) => {
      const url = await resolveKmFile(file, signal).catch(() => null);
      if (!url) return null;
      return {
        key: url,
        url,
        type: 'mp4',
        quality: qualityOf(file.label),
        headers: { 'User-Agent': UA, Referer: `${file.origin}/s/${file.id}` },
        rank: 55 + index,
      } satisfies RawStreamCandidate;
    }),
  );

  const out: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of resolved) {
    if (!candidate || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    out.push(candidate);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export function createSource21Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-21',
    label: 'Source 21',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const raw = await fetchFromKmMovies(query);
      const checked = await verifyAndFilterCandidatesDetailed(raw, query.signal);
      const usable = checked.candidates.filter((candidate) => !!cachedCandidateEvidence(candidate)?.alive);
      query.diag?.push({
        adapter: 'source-21',
        lane: 'KM',
        ok: usable.length > 0,
        ms: Date.now() - started,
        detail: `candidates=${raw.length},reachable=${usable.length}`,
      });
      return {
        candidates: usable.map((candidate) =>
          query.diag ? { ...candidate, diagnosticLane: 'KM' } : candidate,
        ),
      };
    },
  };
}
