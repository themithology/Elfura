/**
 * Embed69 provider adapter (Source 18).
 *
 * The discovery/decryption and HLS extractor flow is adapted from
 * xuper-plugin/kino-plugin-embed69 (Apache-2.0); see vendor/embed69/LICENSE
 * and NOTICE. Elfura-specific changes: Node crypto, bounded requests,
 * redirect/host checks, SourceAdapter mapping, and no hidden-browser capture.
 */
import crypto from 'node:crypto';
import { isSafeUpstreamUrl } from '../security.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const SITE = 'https://embed69.org';
const SITE_REFERER = 'https://sololatino.net/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const MAX_PAGE_BYTES = 1_200_000;
const MAX_DIFFICULTY = 4;
const POW_CAP = 100_000;
const MAX_EMBEDS = 24;
const EMBED_CONCURRENCY = 6;

const STREAMWISH_HOSTS = ['hlswish.com', 'streamwish.com', 'streamwish.to', 'strwish.com', 'wishembed.com', 'filelions.com', 'hglink.to', 'vibuxer.com'];
const VIDHIDE_HOSTS = ['vidhide.com', 'vidhidepro.com', 'vidhideplus.com', 'dintezuvio.com', 'minochinos.com', 'filelions.to', 'morencius.com'];
const VOE_HOSTS = ['voe.sx'];
const EMBED_HOSTS = [...STREAMWISH_HOSTS, ...VIDHIDE_HOSTS, ...VOE_HOSTS];

type PageResult = { ok: boolean; status: number; text: string; url: string };

function allowedEmbedHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return host === 'embed69.org' || EMBED_HOSTS.some(base => host === base || host.endsWith(`.${base}`));
}

async function readTextLimited(response: Response): Promise<string | null> {
  if (!response.body || Number(response.headers.get('content-length') || 0) > MAX_PAGE_BYTES) {
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
      if (size > MAX_PAGE_BYTES) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function getText(rawUrl: string, headers: Record<string, string>, query: SourceQuery): Promise<PageResult | null> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== 'https:' || !isSafeUpstreamUrl(url.href) || !allowedEmbedHost(url)) return null;
  const signal = query.signal
    ? AbortSignal.any([query.signal, AbortSignal.timeout(2600)])
    : AbortSignal.timeout(2600);
  for (let redirects = 0; redirects <= 3; redirects++) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*', ...headers },
        redirect: 'manual',
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location || redirects === 3) return null;
        url = new URL(location, url);
        if (url.protocol !== 'https:' || !isSafeUpstreamUrl(url.href) || !allowedEmbedHost(url)) return null;
        continue;
      }
      const text = await readTextLimited(response);
      return text === null ? null : { ok: response.ok, status: response.status, text, url: url.href };
    } catch {
      return null;
    }
  }
  return null;
}

function powValue(challenge: string, salt: string, difficulty: number): string | null {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_DIFFICULTY) return null;
  const prefix = '0'.repeat(difficulty);
  for (let nonce = 0; nonce <= POW_CAP; nonce++) {
    if (crypto.createHash('sha256').update(`${challenge}${nonce}`).digest('hex').startsWith(prefix)) {
      return crypto.createHash('sha256').update(`${challenge}${nonce}${salt}`).digest('hex');
    }
  }
  return null;
}

function decryptLink(keyHex: string, encoded: string): string | null {
  try {
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length < 32 || (raw.length - 16) % 16 !== 0) return null;
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), raw.subarray(0, 16));
    const plain = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8').trim();
    const url = new URL(plain);
    return url.protocol === 'https:' && isSafeUpstreamUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

function languageKind(raw: unknown): { tag: string; label: string } | null {
  const text = String(raw || '').toLowerCase();
  if (/\b(sub|subs|vose|subtitulado|subtitulada)\b/.test(text)) return { tag: '', label: 'Subtitled · provider label' };
  if (/\b(lat|latino|latam|mx|mex|col|es-mx)\b/.test(text)) return { tag: 'es-419', label: 'Latin American Spanish · provider label' };
  if (/(?:^|[^a-z0-9ñ])(españa|espana|cast|castellano|esp|español|espanol|es-es|spain)(?:$|[^a-z0-9ñ])/.test(text)) return { tag: 'es-ES', label: 'European Spanish · provider label' };
  return null;
}

function extractArray(html: string): unknown[] {
  const start = /\blet\s+dataLink\s*=\s*\[/i.exec(html);
  if (!start) return [];
  const open = html.indexOf('[', start.index);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < html.length && i - open <= 500_000; i++) {
    const char = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(html.slice(open, i + 1));
        return Array.isArray(parsed) ? parsed.slice(0, MAX_EMBEDS) : [];
      } catch { return []; }
    }
  }
  return [];
}

function unpackPacker(source: string): string | null {
  const match = /}\s*\(\s*'((?:\\'|[^'])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\'|[^'])*)'\.split\('\|'\)/.exec(source);
  if (!match) return null;
  const radix = Number(match[2]);
  if (radix < 2 || radix > 62) return null;
  const alpha = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const keys = match[4].split('|');
  return match[1].replace(/\\'/g, "'").replace(/\b[0-9a-zA-Z]+\b/g, word => {
    let index = 0;
    for (const char of word) index = index * radix + alpha.indexOf(char);
    return Number.isSafeInteger(index) && index >= 0 && keys[index] ? keys[index] : word;
  });
}

function hlsFromText(source: string, base: string, keys: string[]): string | null {
  for (const key of keys) {
    const match = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`).exec(source);
    if (match) {
      try { return new URL(match[1].replace(/\\\//g, '/'), base).href; } catch { /* try next */ }
    }
  }
  const file = /\bfile\s*:\s*["']([^"']+\.m3u8[^"']*)["']/.exec(source);
  if (file) {
    try { return new URL(file[1], base).href; } catch { /* no direct playlist */ }
  }
  return null;
}

function voeDecode(encoded: string): Record<string, unknown> | null {
  try {
    let value = encoded.replace(/[a-z]/gi, char => {
      const base = char <= 'Z' ? 65 : 97;
      return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
    });
    for (const junk of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) value = value.split(junk).join('');
    value = Buffer.from(value, 'base64').toString('latin1');
    value = [...value].map(char => String.fromCharCode(char.charCodeAt(0) - 3)).reverse().join('');
    const json = Buffer.from(value, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function isHlsOrMp4(raw: string): RawStreamCandidate['type'] | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !isSafeUpstreamUrl(url.href)) return null;
    if (/\.m3u8$/i.test(url.pathname)) return 'hls';
    if (/\.mp4$/i.test(url.pathname)) return 'mp4';
    return null;
  } catch { return null; }
}

async function resolveEmbed(embedUrl: string, query: SourceQuery): Promise<{ url: string; type: RawStreamCandidate['type']; headers: Record<string, string> } | null> {
  let parsed: URL;
  try { parsed = new URL(embedUrl); } catch { return null; }
  if (!isSafeUpstreamUrl(parsed.href) || !allowedEmbedHost(parsed)) return null;
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const referer = `${parsed.origin}/`;
  const page = await getText(parsed.href, { Referer: referer }, query);
  if (!page?.ok) return null;
  let stream: string | null = null;
  let headers: Record<string, string> = { Referer: referer, 'User-Agent': UA };
  if ([...STREAMWISH_HOSTS].some(h => host === h || host.endsWith(`.${h}`))) {
    const base = new URL(page.url).origin;
    stream = hlsFromText(page.text, base, ['hls4', 'hls2', 'hls3']) ?? hlsFromText(unpackPacker(page.text) || '', base, ['hls4', 'hls2', 'hls3']);
  } else if (VIDHIDE_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
    const base = new URL(page.url).origin;
    stream = hlsFromText(page.text, base, ['hls4', 'hls2']) ?? hlsFromText(unpackPacker(page.text) || '', base, ['hls4', 'hls2']);
    headers = { Referer: base + '/', Origin: base, 'User-Agent': UA };
  } else if (VOE_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
    if (/window\.location\.href\s*=\s*'[^']+'/.test(page.text)) return null; // rotating host requires browser capture
    const payload = /<script\s+type="application\/json">\s*\["([^"]+)"\]/.exec(page.text)?.[1];
    const decoded = payload ? voeDecode(payload) : null;
    const direct = decoded?.source || decoded?.direct_access_url;
    const match = typeof direct === 'string' ? direct : /'hls'\s*:\s*'([^']+)'/.exec(page.text)?.[1] || /(https?:\/\/[^"'\s]+\.mp4[^"'\s]*)/.exec(page.text)?.[1];
    if (typeof match === 'string') stream = match;
  }
  const type = stream ? isHlsOrMp4(stream) : null;
  return type && stream ? { url: stream, type, headers } : null;
}

export async function fetchFromEmbed69(query: SourceQuery): Promise<RawStreamCandidate[]> {
  let imdbId = query.imdbId || '';
  if (!/^tt\d{5,12}$/.test(imdbId) && query.resolveMetaFallback) {
    try { imdbId = (await query.resolveMetaFallback()).imdbId || ''; } catch { return []; }
  }
  if (!/^tt\d{5,12}$/.test(imdbId)) return [];
  let path = imdbId;
  if (query.type === 'tv') {
    const season = Number(query.season), episode = Number(query.episode);
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) return [];
    path += `-${season}x${String(episode).padStart(2, '0')}`;
  }
  const page = await getText(`${SITE}/f/${path}`, { Referer: SITE_REFERER }, query);
  if (!page?.ok) return [];
  const challenge = /POW_CHALLENGE\s*=\s*'([^']*)'/.exec(page.text)?.[1];
  const salt = /POW_SALT\s*=\s*'([^']*)'/.exec(page.text)?.[1];
  const difficulty = Number(/POW_DIFFICULTY\s*=\s*(\d+)/.exec(page.text)?.[1]);
  const keyHex = challenge && salt != null ? powValue(challenge, salt, difficulty) : null;
  if (!keyHex) return [];
  const entries = extractArray(page.text);
  const work = new Map<string, { embedUrl: string; servername: string; languages: { tag: string; label: string }[] }>();
  for (const langGroup of entries) {
    if (!langGroup || typeof langGroup !== 'object' || Array.isArray(langGroup)) continue;
    const group = langGroup as { video_language?: unknown; sortedEmbeds?: unknown };
    const lang = languageKind(group.video_language);
    if (!lang || !Array.isArray(group.sortedEmbeds)) continue;
    for (const row of group.sortedEmbeds.slice(0, 16)) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const embed = row as { servername?: unknown; link?: unknown };
      if (String(embed.servername || '').toLowerCase() === 'download' || typeof embed.link !== 'string') continue;
      const embedUrl = decryptLink(keyHex, embed.link);
      if (!embedUrl) continue;
      const existing = work.get(embedUrl);
      if (existing) {
        if (!existing.languages.some(value => value.tag === lang.tag && value.label === lang.label)) existing.languages.push(lang);
      } else if (work.size < MAX_EMBEDS) {
        work.set(embedUrl, { embedUrl, servername: String(embed.servername || ''), languages: [lang] });
      }
    }
  }

  const out: RawStreamCandidate[] = [];
  const seenCandidates = new Set<string>();
  const labelsByUrl = new Map<string, Set<string>>();
  const jobs = [...work.values()];
  for (let offset = 0; offset < jobs.length && out.length < 12; offset += EMBED_CONCURRENCY) {
    if (query.signal?.aborted) break;
    const batch = await Promise.all(jobs.slice(offset, offset + EMBED_CONCURRENCY).map(async item => {
      const directType = isHlsOrMp4(item.embedUrl);
      const resolved = directType
        ? { url: item.embedUrl, type: directType, headers: { Referer: SITE_REFERER, 'User-Agent': UA } }
        : await resolveEmbed(item.embedUrl, query);
      return { item, resolved };
    }));
    for (const { item, resolved } of batch) {
      if (!resolved) continue;
      const claims = labelsByUrl.get(resolved.url) ?? new Set<string>();
      for (const language of item.languages) claims.add(language.tag || 'sub');
      labelsByUrl.set(resolved.url, claims);
      const headersKey = JSON.stringify(Object.entries(resolved.headers).sort(([a], [b]) => a.localeCompare(b)));
      const identity = `${resolved.url}|${headersKey}`;
      if (seenCandidates.has(identity)) continue;
      seenCandidates.add(identity);
      const firstLanguage = item.languages[0];
      out.push({
        key: `${firstLanguage.tag || 'sub'}:${resolved.url}`,
        url: resolved.url,
        type: resolved.type,
        quality: /\b(2160|1440|1080|720|540|480|360)p\b/i.exec(`${item.servername} ${resolved.url}`)?.[0]?.toLowerCase() || 'auto',
        rank: out.length + (firstLanguage.tag ? 20 : 30),
        headers: resolved.headers,
        ...(firstLanguage.tag ? { claimedAudioLang: firstLanguage.tag } : {}),
        audioLabel: firstLanguage.label,
      });
      if (out.length >= 12) break;
    }
  }

  return out.map(candidate => {
    if ((labelsByUrl.get(candidate.url)?.size ?? 0) < 2) return candidate;
    const { claimedAudioLang: _claim, ...unclaimed } = candidate;
    return { ...unclaimed, audioLabel: 'Conflicting provider language labels' };
  });
}

export function createSource18Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-18',
    label: 'Source 18',
    enabled,
    async resolve(query) {
      const started = Date.now();
      const candidates = await fetchFromEmbed69(query);
      query.diag?.push({ adapter: 'source-18', lane: 'E', ok: candidates.length > 0, ms: Date.now() - started, detail: `directCandidates=${candidates.length}` });
      return { candidates: candidates.map(candidate => query.diag ? { ...candidate, diagnosticLane: 'E' } : candidate) };
    },
  };
}
