/** Experimental Nxsha-backed HLS source. Provider names and audio labels are
 * hints only: Elfura independently inspects each manifest before promotion. */
import crypto from 'node:crypto';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const ORIGIN = 'https://nxsha.space';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
// Public web-client protocol passphrase, not a private credential. May rotate.
const PASS = 'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3';
type Server = { scraper?: string };
type Stream = { url?: string; type?: string; label?: string; quality?: string; language?: string; isEmbed?: boolean; headers?: Record<string, unknown> };
type NxPayload = { servers?: Server[]; sources?: Stream[] };
function derive(salt: Buffer) {
  let material = Buffer.alloc(0), previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from(PASS), salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}
export function nxEncode(input: object): string {
  const salt = crypto.randomBytes(8); const { key, iv } = derive(salt);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const body = JSON.stringify({ ...input, _req_ts: Date.now(), _req_salt: crypto.randomBytes(6).toString('base64url') });
  return Buffer.concat([Buffer.from('Salted__'), salt, cipher.update(body), cipher.final()]).toString('base64url');
}
export function nxDecode(input: string): NxPayload {
  if (!/^[A-Za-z0-9_-]+$/.test(input) || input.length > 1_000_000) throw new Error('invalid payload');
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.length < 32 || bytes.subarray(0, 8).toString() !== 'Salted__') throw new Error('invalid envelope');
  const { key, iv } = derive(bytes.subarray(8, 16));
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8')) as NxPayload;
}
function headerHints(h: Record<string, unknown> | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': UA, Referer: ORIGIN + '/' };
  for (const [key, value] of Object.entries(h || {})) {
    if (!/^(referer|origin|user-agent)$/i.test(key) || typeof value !== 'string' || value.length > 2048 || /[\r\n]/.test(value)) continue;
    if (/^(referer|origin)$/i.test(key) && !isSafeUpstreamUrl(value)) continue;
    const canonical = /^referer$/i.test(key) ? 'Referer' : /^origin$/i.test(key) ? 'Origin' : 'User-Agent';
    headers[canonical] = value;
  }
  return headers;
}
export async function fetchFromNxsha(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return [];
  const season = query.type === 'tv' ? query.season ?? 1 : 0, episode = query.type === 'tv' ? query.episode ?? 1 : 0;
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 0 || episode < 0 || (query.type === 'tv' && episode < 1)) return [];
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(8500)]) : AbortSignal.timeout(8500);
  const params = { tmdbId: query.tmdbId, imdb_id: '', type: query.type, season, episode };
  const get = async (endpoint: string, body: object) => {
    const url = `${ORIGIN}/api/${endpoint}?q=${nxEncode(body)}`;
    const response = await fetch(url, { redirect: 'error', headers: { 'User-Agent': UA, Referer: ORIGIN + '/', Accept: 'application/json' }, signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error('upstream unavailable'); }
    if (Number(response.headers.get('content-length') || 0) > 1_000_000 || !response.body) { await response.body?.cancel(); throw new Error('oversized response'); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1_000_000) throw new Error('oversized response'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { _hash?: unknown };
    if (typeof envelope._hash !== 'string') throw new Error('missing envelope');
    return nxDecode(envelope._hash);
  };
  try {
    const root = await get('servers', params);
    const available = Array.isArray(root.servers) ? root.servers : [];
    // Restricted to Nitro and Indian-dub HLS lanes; avoid rejected providers,
    // season packs, embed-only hosts and unbounded request fan-out.
    const allowed = ['nitro', 'mhbox', 'awsind', 'rive-citadel', 'rive-primevids', 'rive-flowcast', 'rive-quasar', 'streamflix', 'vidapi', 'stvv'];
    const ids = [...new Set(available.map(s => s.scraper).filter((x): x is string => !!x && allowed.includes(x)))].sort((a,b) => allowed.indexOf(a) - allowed.indexOf(b));
    const rows: Stream[] = []; let finished = 0; let release: (() => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    const all = Promise.all(ids.map(async provider => {
      try { const res = await get('sources', { ...params, ex_lang: true, provider }); if (Array.isArray(res.sources)) rows.push(...res.sources.slice(0, 12)); } catch { /* one lane failing is expected */ }
      finally { finished++; if (!query.diag && rows.length && !timer) timer = setTimeout(() => release?.(), 350); }
    }));
    if (query.diag) await all;
    else if (ids.length) await Promise.race([all, new Promise<void>(r => { release = r; }), new Promise<void>(r => setTimeout(r, 2200))]);
    if (timer) clearTimeout(timer);
    const build = () => {
      const result: RawStreamCandidate[] = [], seen = new Set<string>();
      for (const s of rows) {
        const url = s.url;
        if (typeof url !== 'string' || !isSafeUpstreamUrl(url) || seen.has(url) || /vidara/i.test(url) || s.isEmbed || /embed/i.test(s.type || '')) continue;
        if (!/\.m3u8(?:[?#]|$)/i.test(url) && !/^(hls|m3u8|application\/vnd\.apple\.mpegurl)$/i.test(s.type || '')) continue;
        const label = String(s.language || s.label || '');
        const lang = /\bhindi\b/i.test(label) && !/multi|dual|hindi\s*sub/i.test(label) ? normalizeLang('Hindi') : normalizeLang(s.language || 'und');
        seen.add(url);
        result.push({ key: url, type: 'hls', url, headers: headerHints(s.headers), quality: /\b(2160|1080|720|480)p?\b/i.exec(String(s.quality || s.label || ''))?.[1] ? `${/\b(2160|1080|720|480)p?\b/i.exec(String(s.quality || s.label || ''))![1]}p` : 'auto', ...(lang.code !== 'und' ? { audioLang: lang.code, audioLabel: lang.label } : {}), rank: 15 + result.length });
        if (result.length >= 30) break;
      }
      return result;
    };
    const current = build();
    if (!query.diag && finished < ids.length && query.onLateResult) void all.then(() => query.onLateResult?.({ candidates: build() }));
    return current;
  } catch { return []; }
}
export function createSource5Adapter(enabled: () => boolean): SourceAdapter {
  return { id: 'source-5', label: 'Source 5', enabled, async resolve(query) {
    const start = Date.now(); const candidates = await fetchFromNxsha(query);
    query.diag?.push({ adapter: 'source-5', lane: 'N', ok: candidates.length > 0, ms: Date.now() - start, detail: `candidates=${candidates.length}` });
    return { candidates: candidates.map(c => query.diag ? { ...c, diagnosticLane: 'N' } : c) };
  } };
}
