/** HLS candidates resolved from the Bingr watch-page protocol. Research-derived;
 * upstream labels are hints only: liveness verifies audio from the manifest. */
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type { RawSourceResult, RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const ORIGIN = 'https://bingr.one';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
type Payload = { servers?: { id?: string }[]; streams?: { url?: string; language?: string; quality?: string; type?: string }[] };

export function decodeBingrPayload(blob: string): Payload {
  if (!/^v1\.[A-Za-z0-9_-]+$/.test(blob) || blob.length > 1_500_000) throw new Error('invalid payload');
  const bytes = Buffer.from(blob.slice(3), 'base64url');
  if (bytes.length < 13) throw new Error('short payload');
  const iv = bytes.subarray(0, 12), data = Buffer.from(bytes.subarray(12));
  const seed = Buffer.concat([Buffer.from('vY7#qL2!mZ9@wK4$'), iv]);
  let state = Array.from({ length: 4 }, (_, i) => {
    let x = (0x811c9dc5 ^ Math.imul(0x9e3779b9, i)) >>> 0;
    for (const byte of seed) x = Math.imul(x ^ byte, 0x1000193) >>> 0;
    return x;
  });
  let word = 0;
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 0) {
      const [a, b, c, oldD] = state; const d = (oldD + 1) >>> 0;
      word = (a + b + d) >>> 0;
      state = [(b ^ (b >>> 9)) >>> 0, Math.imul(c, 9) >>> 0, (((c << 21) | (c >>> 11)) + word) >>> 0, d];
    }
    data[i] ^= (word >>> ((i % 4) * 8)) & 255;
  }
  const text = data.toString('utf8');
  const end = text.lastIndexOf('}');
  if (end < 0) throw new Error('invalid plaintext');
  return JSON.parse(text.slice(0, end + 1)) as Payload;
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (size <= limit) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('response too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function fetchFromBingr(query: SourceQuery): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return [];
  const season = query.season ?? 1, episode = query.episode ?? 1;
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 0 || episode < 1) return [];
  const path = query.type === 'movie' ? `/watch/movie/${query.tmdbId}` : `/watch/tv/${query.tmdbId}/${season}/${episode}`;
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(8500)]) : AbortSignal.timeout(8500);
  const get = async (url: string, limit: number) => {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: ORIGIN + path, Accept: '*/*' }, redirect: 'error', signal });
    if (!r.ok) { await r.body?.cancel(); return ''; }
    return readBounded(r, limit);
  };
  try {
    const html = await get(ORIGIN + path, 2_000_000);
    let rsc = '';
    for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\[\s\S])*)"\]\)/g)) {
      try { rsc += JSON.parse('"' + m[1] + '"') as string; } catch { /* ignore malformed chunk */ }
    }
    const token = rsc.match(/"token":"([^"\\]{1,2048})"/)?.[1];
    const blob = rsc.match(/v1\.[A-Za-z0-9_-]{60,}/)?.[0];
    if (!blob) return [];
    const first = decodeBingrPayload(blob);
    const ids = (Array.isArray(first.servers) ? first.servers : []).map(s => s.id).filter((id): id is string => typeof id === 'string' && /^[a-z0-9_-]{1,40}$/i.test(id));
    // Race all advertised servers; the outer registry bounds startup and warms
    // the cache for later recovery if an upstream completes after that deadline.
    const rows: Payload[] = [first];
    let settled = 0; let release: (() => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    const lanes = token ? ids.slice(0, 8) : [];
    const all = Promise.all(lanes.map(async id => {
      try {
        const q = new URLSearchParams({ kind: query.type, t: token || "", provider: id, tmdb: query.tmdbId });
        if (query.type === 'tv') { q.set('s', String(season)); q.set('e', String(episode)); }
        const body = await get(`${ORIGIN}/api/sources?${q}`, 1_500_000);
        if (body.startsWith('v1.')) rows.push(decodeBingrPayload(body.trim()));
      } catch { /* an individual lane must not block the others */ }
      finally {
        settled++;
        if (!query.diag && rows.some(r => r.streams?.length) && !timer) timer = setTimeout(() => release?.(), 350);
      }
    }));
    if (query.diag) await all;
    else if (lanes.length) await Promise.race([all, new Promise<void>(resolve => { release = resolve; }), new Promise<void>(resolve => setTimeout(resolve, 2200))]);
    if (timer) clearTimeout(timer);
    const build = (): RawStreamCandidate[] => {
    const result: RawStreamCandidate[] = [], seen = new Set<string>();
    for (const row of rows) for (const stream of Array.isArray(row.streams) ? row.streams.slice(0, 40) : []) {
      const url = stream.url;
      if (typeof url !== 'string' || !isSafeUpstreamUrl(url) || seen.has(url)) continue;
      // A known bridge may expose HLS without a filename extension.
      const host = new URL(url).hostname.toLowerCase();
      if (!/\.m3u8(?:[?#]|$)/i.test(url) && !/hls|m3u8/i.test(String(stream.type || '')) && !/(?:^|\.)dash-hls-bridge\.johndoesdmc\.workers\.dev$/.test(host)) continue;
      seen.add(url);
      const lang = normalizeLang(typeof stream.language === 'string' ? stream.language : 'und');
      result.push({ key: url, url, type: 'hls', quality: typeof stream.quality === 'string' && /^[\w .-]{1,24}$/.test(stream.quality) ? stream.quality : 'auto',
        ...(lang.code !== 'und' ? { audioLang: lang.code, audioLabel: lang.label } : {}), rank: 10 + result.length });
      if (result.length >= 40) return result;
    }
    return result;
    };
    const current = build();
    if (!query.diag && settled < lanes.length && query.onLateResult) void all.then(() => query.onLateResult?.({ candidates: build() }));
    return current;
  } catch { return []; }
}

export function createSource4Adapter(enabled: () => boolean): SourceAdapter {
  return { id: 'source-4', label: 'Source 4', enabled,
    async resolve(query): Promise<RawSourceResult> {
      const start = Date.now();
      const candidates = await fetchFromBingr(query);
      query.diag?.push({ adapter: 'source-4', lane: 'B', ok: candidates.length > 0, ms: Date.now() - start, detail: `candidates=${candidates.length}` });
      return { candidates: candidates.map(c => query.diag ? { ...c, diagnosticLane: 'B' } : c) };
    } };
}
