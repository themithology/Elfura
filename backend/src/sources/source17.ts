/**
 * Source 17 — TGVIDX's public, TMDB-keyed multi-server inventory.
 *
 * The website sends a TanStack server-function request, then reverses a
 * base64 string and applies a public client-side XOR transform. This is only
 * wire obfuscation, not an authentication credential. Both the function hash
 * and transform can change when the upstream deploys; fail closed if so.
 *
 * One adapter preserves the dynamically changing server inventory rather than
 * inventing fixed provider numbers. Greybox rows are retained as alternate
 * discovery paths even though Source 25 also queries Greybox directly.
 * Pirate rows point back to this project's deployment and must never be fed
 * into it as a new upstream: that would create a recursive playback loop.
 */
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type { RawSourceResult, RawStreamCandidate, RawTrackRef, SourceAdapter, SourceQuery } from './types.js';

const ORIGIN = 'https://tgvidx.lovable.app';
const RPC = '/_serverFn/ff183e1ad6d02c4c08e8e73151c60e5dcc23f8f4c9db53eac9d271b87a56e121';
const PUBLIC_TRANSFORM = 'tGfL1x#9vQ';
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ROWS = 200;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

type Row = { server?: unknown; label?: unknown; type?: unknown; quality?: unknown; url?: unknown; subtitles?: unknown };
type Payload = { ok?: unknown; type?: unknown; tmdb_id?: unknown; season?: unknown; episode?: unknown; links?: unknown };

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('response too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('response too large');
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Parse only the expected Seroval return envelope, not arbitrary JS. */
export function decodeTgvidxResponse(text: string): Payload | null {
  try {
    const envelope = JSON.parse(text);
    const root = envelope?.p;
    if (envelope?.t !== 10 || !Array.isArray(root?.k) || !Array.isArray(root?.v)) return null;
    const result = root.v[root.k.indexOf('result')];
    const nested = result?.p;
    if (result?.t !== 10 || !Array.isArray(nested?.k) || !Array.isArray(nested?.v)) return null;
    const encoded = nested.v[nested.k.indexOf('p')];
    if (encoded?.t !== 1 || typeof encoded.s !== 'string' || encoded.s.length > MAX_RESPONSE_BYTES || !/^[A-Za-z0-9+/=_-]+$/.test(encoded.s)) return null;
    const bytes = Buffer.from(encoded.s.split('').reverse().join(''), 'base64');
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= PUBLIC_TRANSFORM.charCodeAt(i % PUBLIC_TRANSFORM.length) ^ (i & 255);
    const decoded = JSON.parse(bytes.toString('utf8'));
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Payload : null;
  } catch { return null; }
}

function notOwnPlayer(raw: string, depth = 0): boolean {
  try {
    const u = new URL(raw);
    if (/(?:^|\.)theogpiratebot\.(?:to|online)$/i.test(u.hostname)) return false;
    // Some wrappers carry another absolute URL in a query parameter. Check
    // plain and base64-encoded values too, without attempting to decrypt tokens.
    if (depth < 3) for (const value of u.searchParams.values()) {
      const alternatives = [value];
      if (value.length <= 16000 && /^[A-Za-z0-9_+/=-]+$/.test(value)) {
        alternatives.push(Buffer.from(value, 'base64url').toString('utf8'));
      }
      for (const nested of alternatives) if (/^https?:\/\//i.test(nested) && !notOwnPlayer(nested, depth + 1)) return false;
    }
    return true;
  } catch { return false; }
}
function mediaUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 16000) return null;
  try {
    const url = new URL(raw, ORIGIN).href;
    return isSafeUpstreamUrl(url) && notOwnPlayer(url) ? url : null;
  } catch { return null; }
}
function kind(row: Row, url: string): 'hls' | 'dash' | 'mp4' | null {
  const declared = String(row.type ?? '').toLowerCase();
  if (declared === 'hls' || declared === 'm3u8') return 'hls';
  if (declared === 'dash' || declared === 'mpd') return 'dash';
  if (declared === 'mp4') return 'mp4';
  if (/\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  if (/\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (/\.mp4(?:[?#]|$)/i.test(url)) return 'mp4';
  return null;
}
function quality(raw: unknown): string {
  const q = String(raw ?? '').trim().toLowerCase();
  return /^(?:360|480|720|1080|1440|2160)p$/.test(q) ? q : 'auto';
}
function headersFor(url: string): Record<string, string> {
  const origin = new URL(url).hostname === 'greyboxtv.duckdns.org' ? 'https://greyboxtv.duckdns.org' : ORIGIN;
  return { 'User-Agent': USER_AGENT, Referer: `${origin}/`, Origin: origin };
}
function subtitles(row: Row): RawTrackRef[] {
  if (!Array.isArray(row.subtitles)) return [];
  const result: RawTrackRef[] = [];
  const seen = new Set<string>();
  for (const sub of row.subtitles.slice(0, 100)) {
    if (!sub || typeof sub !== 'object') continue;
    const url = mediaUrl(sub.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const lang = normalizeLang(typeof sub.lang === 'string' ? sub.lang : '').code;
    const label = typeof sub.label === 'string' && sub.label.trim() ? sub.label.trim().slice(0, 60) : lang.toUpperCase();
    result.push({ url, lang, label, headers: headersFor(url) });
  }
  return result;
}

export function createSource17Adapter(enabled: () => boolean): SourceAdapter {
  return {
    id: 'source-17', label: 'Source 17', enabled,
    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      if (!enabled() || !/^\d{1,12}$/.test(query.tmdbId)) return { candidates: [] };
      if (query.type === 'tv' && (!Number.isInteger(query.season) || !Number.isInteger(query.episode) || (query.season ?? 0) < 0 || (query.episode ?? 0) < 1 || (query.season ?? 0) > 9999 || (query.episode ?? 0) > 9999)) return { candidates: [] };
      const start = Date.now();
      const diag = (ok: boolean, detail: string) => query.diag?.push({ adapter: 'source-17', lane: 'inventory', ok, ms: Date.now() - start, detail });
      const timeout = AbortSignal.timeout(12_000);
      const signal = query.signal ? AbortSignal.any([query.signal, timeout]) : timeout;
      const path = query.type === 'movie' ? `/api/m/${query.tmdbId}` : `/api/tv/${query.tmdbId}/${query.season}/${query.episode}`;
      const request = { t: { t: 10, i: 0, p: { k: ['data'], v: [{ t: 10, i: 1, p: { k: ['path'], v: [{ t: 1, s: path }] }, o: 0 }] }, o: 0 }, f: 127, m: [] };
      try {
        const res = await fetch(ORIGIN + RPC, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-tsr-serverfn': 'true', 'User-Agent': USER_AGENT, Referer: `${ORIGIN}/`, Origin: ORIGIN }, body: JSON.stringify(request), signal });
        if (!res.ok) { await res.body?.cancel().catch(() => {}); diag(false, `http=${res.status}`); return { candidates: [] }; }
        const data = decodeTgvidxResponse(await readBounded(res));
        if (!data || data.ok !== true || String(data.tmdb_id) !== query.tmdbId || data.type !== query.type || (data.season != null && Number(data.season) !== query.season) || (data.episode != null && Number(data.episode) !== query.episode) || !Array.isArray(data.links)) {
          diag(false, 'invalid inventory or identity'); return { candidates: [] };
        }
        const candidates: RawStreamCandidate[] = [];
        const seen = new Set<string>();
        for (const row of data.links.slice(0, MAX_ROWS) as Row[]) {
          if (!row || typeof row !== 'object') continue;
          const name = typeof row.server === 'string' ? row.server : '';
          const label = typeof row.label === 'string' ? row.label : '';
          if (/\b(?:tg\s*)?pirate\b/i.test(name) || /\b(?:tg\s*)?pirate\b/i.test(label)) continue;
          const url = mediaUrl(row.url);
          if (!url || seen.has(url)) continue;
          const type = kind(row, url);
          if (!type) continue;
          seen.add(url);
          const tracks = subtitles(row);
          candidates.push({ key: url, url, type, quality: quality(row.quality), headers: headersFor(url), rank: 60 + Math.min(candidates.length, 30), ...(/\bhindi\b/i.test(label) ? { claimedAudioLang: 'hi' } : {}), ...(tracks.length ? { subtitles: tracks } : {}) });
        }
        diag(candidates.length > 0, `rows=${data.links.length} candidates=${candidates.length}`);
        return { candidates };
      } catch (error) {
        diag(false, `request ${(error as Error)?.name || 'Error'}`);
        return { candidates: [] };
      }
    },
  };
}
