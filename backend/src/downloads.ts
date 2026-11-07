/** Isolated download catalogue. No arbitrary client URL is ever fetched. */
import { openStreamTicket, sealStreamTicket } from './security.js';
export type DownloadQuery = { type: 'movie' | 'tv'; tmdb: string; season?: number; episode?: number };
type DownloadItem = { name: string; quality: string; size: string; languages: string[]; kind: string; link: string };
const cache = new Map<string, { expires: number; items: DownloadItem[] }>();
const inflight = new Map<string, Promise<DownloadItem[]>>();
const names: [string, RegExp][] = [
  ['Hindi', /\bhindi\b/i], ['English', /\benglish\b/i], ['Tamil', /\btamil\b/i],
  ['Telugu', /\btelugu\b/i], ['Malayalam', /\bmalayalam\b/i], ['Kannada', /\bkannada\b/i],
  ['Japanese', /\bjapanese\b/i], ['Korean', /\bkorean\b/i], ['Bengali', /\bbengali\b/i],
  ['Marathi', /\bmarathi\b/i], ['Spanish', /\bspanish\b/i], ['French', /\bfrench\b/i],
];
export function labelLanguages(filename: string): string[] {
  // Remove subtitle-only mentions before inferring audio from a filename.
  const normalized = filename.replace(/(?:english|hindi|tamil|telugu|malayalam|kannada|japanese|korean|bengali|spanish|french)[ ._-]*(?:subtitles?|subs?)\b/gi, '');
  const result = names.filter(([, re]) => re.test(normalized)).map(([label]) => label);
  return result.length ? result : ['Unknown'];
}
function allowedDownloadUrl(raw: string): boolean {
  try {
    const u = new URL(raw); const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      (h === 'pixeldrain.dev' || h === 'pixeldrain.com' || h === 'hubcloud.pw' || h.endsWith('.hubcloud.pw') || h.endsWith('.r2.cloudflarestorage.com'));
  } catch { return false; }
}
function unwrap(raw: unknown): string | null {
  try {
    const u = new URL(String(raw));
    if (u.origin !== 'https://tgdl.lovable.app' || u.pathname !== '/dl') return null;
    const encoded = u.searchParams.get('u') || '';
    if (!/^[A-Za-z0-9_-]{1,8192}={0,2}$/.test(encoded)) return null;
    const dest = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!allowedDownloadUrl(dest) || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(dest)) return null;
    return dest;
  } catch { return null; }
}
export function normalizeDownloadResponse(data: unknown, query: DownloadQuery): DownloadItem[] {
  if (!data || typeof data !== 'object') return [];
  const payload = data as { success?: boolean; type?: string; tmdb_id?: string | number; season?: number; episode?: number; downloads?: unknown };
  if (!payload.success || payload.type !== query.type || String(payload.tmdb_id) !== query.tmdb ||
      (query.type === 'tv' && (Number(payload.season) !== query.season || Number(payload.episode) !== query.episode)) || !Array.isArray(payload.downloads)) return [];
  const result: DownloadItem[] = []; const seen = new Set<string>();
  for (const raw of payload.downloads.slice(0, 150)) {
    if (!raw || typeof raw !== 'object') continue;
    const x = raw as Record<string, unknown>;
    const link = unwrap(x.download_url); if (!link || seen.has(link)) continue;
    const clean = (s: unknown, max: number) => typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
    const name = clean(x.name, 220); if (!name || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(name)) continue;
    seen.add(link);
    result.push({ name, quality: clean(x.quality, 20) || 'Unknown', size: clean(x.size, 25), languages: labelLanguages(name), kind: new URL(link).hostname.endsWith('.hubcloud.pw') ? 'External download page' : 'File link', link });
  }
  return result;
}
export async function resolveDownloads(query: DownloadQuery): Promise<DownloadItem[]> {
  const key = `${query.type}:${query.tmdb}:${query.season || 0}:${query.episode || 0}`;
  const hit = cache.get(key); if (hit && hit.expires > Date.now()) return hit.items;
  const pending = inflight.get(key); if (pending) return pending;
  const task = (async () => {
    try {
      const suffix = query.type === 'tv' ? `/${query.season}/${query.episode}` : '';
      const path = `${query.type}/${query.tmdb}${suffix}`;
      // V2 first; V1 is a fallback, not an extra delay when V2 works.
      for (const prefix of ['v2/', '']) {
        try {
        const response = await fetch(`https://tgdl.lovable.app/api/${prefix}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
        if (!response.ok) continue;
        const items = normalizeDownloadResponse(await response.json(), query);
        if (items.length) {
          if (cache.size >= 200) cache.delete(cache.keys().next().value!);
          cache.set(key, { items, expires: Date.now() + 60_000 });
          return items;
        }
        } catch { /* try next pipeline */ }
      }
    } catch { /* a failed external service never affects the player */ }
    return [];
  })();
  inflight.set(key, task); try { return await task; } finally { inflight.delete(key); }
}
export function issueDownloadTicket(secret: Buffer, item: DownloadItem): string {
  return sealStreamTicket(secret, { u: item.link, h: { purpose: 'download-v1', name: item.name, quality: item.quality, size: item.size, languages: item.languages.join(', '), kind: item.kind } }, 1800);
}
export function openDownloadTicket(secret: Buffer, token: string): { url: string; name: string; quality: string; size: string; languages: string; kind: string } | null {
  if (token.length > 12000) return null;
  const data = openStreamTicket(secret, token);
  if (!data || data.h?.purpose !== 'download-v1' || !allowedDownloadUrl(data.u) || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(data.u)) return null;
  return { url: data.u, name: data.h.name || '', quality: data.h.quality || '', size: data.h.size || '', languages: data.h.languages || '', kind: data.h.kind || '' };
}
