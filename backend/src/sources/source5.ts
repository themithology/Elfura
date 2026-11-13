/** Experimental Nxsha-backed HLS source. Provider names and audio labels are
 * hints only: Elfura independently inspects each manifest before promotion. */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const ORIGIN = 'https://nxsha.space';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
// Public web-client protocol passphrase, not a private credential. May rotate.
const PASS = 'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3';
const SERVER_PRIORITY = ['awsind', 'nitro', 'castle', 'streamflix', 'watchout', 'rive-citadel', 'rive-primevids', 'stvv', 'bdxs', 'showbox-online', 'purstream', 'vixolity', 'ophim', 'em-8', 'rive-hindicast', 'mbox', 'mhbox', 'imovr', 'yomovies', 'vidapi', 'rive-flowcast', 'toonstream'];
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
type CurlResult = { status: number; body: string } | null;
export type NxshaTransport = {
  preferCurl?: boolean;
  fetch?: typeof fetch;
  curl?: (url: string, signal: AbortSignal) => Promise<CurlResult>;
};

function curlGet(url: string, signal: AbortSignal): Promise<CurlResult> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: CurlResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => child.kill('SIGTERM');
    const child = execFile('curl', [
      '-sS', '-L', '--max-time', '7', '-w', '\n%{http_code}',
      '-H', `user-agent: ${UA}`,
      '-H', `referer: ${ORIGIN}/`,
      '-H', 'accept: */*',
      url,
    ], { timeout: 7_500, maxBuffer: 1_100_000 }, (error, stdout) => {
      if (error && !stdout) return finish(null);
      const text = String(stdout);
      const index = text.lastIndexOf('\n');
      if (index < 0) return finish(null);
      const status = Number(text.slice(index + 1).trim());
      const body = text.slice(0, index);
      finish(Number.isInteger(status) && status >= 200 && status < 300 && body.length <= 1_000_000
        ? { status, body }
        : null);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function parseEnvelopeText(text: string): Promise<NxPayload | null> {
  if (!text || text.length > 1_000_000) return null;
  try {
    const value = JSON.parse(text) as { _hash?: unknown };
    if (typeof value._hash !== 'string') return null;
    return nxDecode(value._hash);
  } catch { return null; }
}

async function fetchEnvelope(url: string, signal: AbortSignal, transport: NxshaTransport): Promise<NxPayload | null> {
  const curl = transport.curl ?? curlGet;
  const fetcher = transport.fetch ?? globalThis.fetch;
  const curlFirst = transport.preferCurl ?? true;
  if (curlFirst) {
    const response = await curl(url, signal);
    if (response?.status === 200) {
      const decoded = await parseEnvelopeText(response.body);
      if (decoded) return decoded;
    }
  }
  try {
    const response = await fetcher(url, {
      redirect: 'error',
      headers: { 'User-Agent': UA, Referer: ORIGIN + '/', Accept: 'application/json' },
      signal,
    });
    if (response.ok && response.body && Number(response.headers.get('content-length') || 0) <= 1_000_000) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_000_000) return null;
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const decoded = await parseEnvelopeText(Buffer.concat(chunks).toString('utf8'));
      if (decoded) return decoded;
    } else {
      await response.body?.cancel().catch(() => {});
    }
  } catch { /* try curl below when fetch was preferred */ }
  if (!curlFirst) {
    const response = await curl(url, signal);
    if (response?.status === 200) return parseEnvelopeText(response.body);
  }
  return null;
}

export async function fetchFromNxsha(query: SourceQuery, lanes?: readonly string[], transport: NxshaTransport = {}): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return [];
  const season = query.type === 'tv' ? query.season ?? 1 : 0, episode = query.type === 'tv' ? query.episode ?? 1 : 0;
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 0 || episode < 0 || (query.type === 'tv' && episode < 1)) return [];
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(8500)]) : AbortSignal.timeout(8500);
  const params = { tmdbId: query.tmdbId, imdb_id: '', type: query.type, season, episode };
  const get = async (endpoint: string, body: object) => {
    const url = `${ORIGIN}/api/${endpoint}?q=${nxEncode(body)}`;
    const payload = await fetchEnvelope(url, signal, transport);
    if (!payload) throw new Error('upstream unavailable');
    return payload;
  };
  try {
    const root = await get('servers', params);
    const available = Array.isArray(root.servers) ? root.servers : [];
    const priority = lanes ?? SERVER_PRIORITY;
    const ids = [...new Set(available
      .map(s => typeof s.scraper === 'string' ? s.scraper.trim().toLowerCase() : '')
      .filter(x => /^[a-z0-9_-]{1,48}$/.test(x) && (!lanes || priority.includes(x))))]
      .sort((a, b) => {
        const ai = priority.indexOf(a), bi = priority.indexOf(b);
        return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.localeCompare(b);
      })
      .slice(0, lanes ? 6 : 12);
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
        // The additional ScreenScape lanes accept only an unambiguous audio
        // language field/label; avoid promoting multi/subtitle labels as dubs.
        const lang = lanes
          ? (!/sub|caption|multi|dual/i.test(label) ? normalizeLang(label) : normalizeLang('und'))
          : /\bhindi\b/i.test(label) && !/multi|dual|hindi\s*sub/i.test(label) ? normalizeLang('Hindi') : normalizeLang(s.language || 'und');
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
export function createSource5Adapter(enabled: () => boolean, transport?: NxshaTransport): SourceAdapter {
  return { id: 'source-5', label: 'Source 5', enabled, async resolve(query) {
    const start = Date.now(); const candidates = await fetchFromNxsha(query, undefined, transport);
    query.diag?.push({ adapter: 'source-5', lane: 'N', ok: candidates.length > 0, ms: Date.now() - start, detail: `candidates=${candidates.length}` });
    return { candidates: candidates.map(c => query.diag ? { ...c, diagnosticLane: 'N' } : c) };
  } };
}
