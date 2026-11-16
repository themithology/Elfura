/** Experimental Nxsha-backed HLS source. Provider names and audio labels are
 * hints only: Elfura independently inspects each manifest before promotion. */
import crypto from 'node:crypto';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import { candidateEvidence, verifyAndFilterCandidatesDetailed } from './liveness.js';
import { fetchNoRedirect } from './upstream-fetch.js';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

const ORIGIN = 'https://nxsha.space';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
// Public web-client protocol passphrases, not private credentials. The site
// rotates them (public extractors record at least one rotation), and a rotation
// silently turns every stream into "no results", so we keep the known history
// and try each in order rather than trusting one constant to still be current.
// Order matters: current first, then older ones still seen in the wild.
// Each deployment seals with its own passphrase, so a host is only readable
// with the key that belongs to it. Both are public front-ends of the same
// catalogue.
const ENDPOINTS: readonly { origin: string; pass: string }[] = [
  { origin: 'https://nxsha.space', pass: 'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3' },
  { origin: 'https://web.nxsha.app', pass: 'S8x!Jk4ZP1uG8$my' },
];
const PASSES = [
  'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3',
  'S8x!Jk4ZP1uG8$my',
] as const;
const PASS = PASSES[0];
type Server = { scraper?: string };
type Stream = { url?: string; type?: string; label?: string; quality?: string; language?: string; isEmbed?: boolean; headers?: Record<string, unknown> };
type NxPayload = { servers?: Server[]; sources?: Stream[] };
function derive(salt: Buffer, pass: string = PASS) {
  let material = Buffer.alloc(0), previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from(pass), salt])).digest();
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
export function nxDecodeWith(input: string, pass: string): NxPayload {
  if (!/^[A-Za-z0-9_-]+$/.test(input) || input.length > 1_000_000) throw new Error('invalid payload');
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.length < 32 || bytes.subarray(0, 8).toString() !== 'Salted__') throw new Error('invalid envelope');
  const { key, iv } = derive(bytes.subarray(8, 16), pass);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8')) as NxPayload;
}
/** Try every passphrase we know of, current first. */
export function nxDecode(input: string): NxPayload {
  let last: unknown;
  for (const pass of PASSES) {
    try { return nxDecodeWith(input, pass); } catch (error) { last = error; }
  }
  throw last instanceof Error ? last : new Error('undecodable');
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
export interface NxshaOptions {
  /** Collected reasons for an empty result. Never contains URLs or ids. */
  trace?: string[];
}

export async function fetchFromNxsha(
  query: SourceQuery,
  lanes?: readonly string[],
  options: NxshaOptions = {},
): Promise<RawStreamCandidate[]> {
  if (!/^\d{1,12}$/.test(query.tmdbId)) return [];
  const season = query.type === 'tv' ? query.season ?? 1 : 0, episode = query.type === 'tv' ? query.episode ?? 1 : 0;
  if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 0 || episode < 0 || (query.type === 'tv' && episode < 1)) return [];
  const signal = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(8500)]) : AbortSignal.timeout(8500);
  const params = { tmdbId: query.tmdbId, imdb_id: '', type: query.type, season, episode };
  const trace = options.trace;
  // Which deployment we are currently reading. Starts at the primary and flips
  // once if the primary answers but none of our keys open it.
  let active = ENDPOINTS[0];
  const attempted: string[] = [];
  const get = async (endpoint: string, body: object) => {
    const url = `${active.origin}/api/${endpoint}?q=${nxEncode(body)}`;
    // nxsha is same-origin behind one host, so a redirect here is either an
    // http->https upgrade or a path move. Follow a same-origin hop; refuse
    // anything else. `redirect:'error'` used to make the former look like an
    // outage.
    const { response, reason } = await fetchNoRedirect(url, {
      headers: { 'User-Agent': UA, Referer: active.origin + '/', Accept: 'application/json' },
      signal,
    }, { allowSameOriginRedirects: true });
    if (!response) {
      // fetchNoRedirect reports the network failure instead of throwing it, so
      // record it here — otherwise the outer catch sees nothing and the panel
      // shows a bare "Error" for what is usually a reset or a refused connection.
      trace?.push(`${endpoint}=${reason ?? 'no-response'}`);
      throw new Error('upstream-unavailable');
    }
    if (!response.ok) {
      trace?.push(`${endpoint}=http=${response.status}`);
      await response.body?.cancel().catch(() => {});
      throw new Error('upstream-unavailable');
    }
    if (Number(response.headers.get('content-length') || 0) > 1_000_000 || !response.body) { await response.body?.cancel(); throw new Error('oversized response'); }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1_000_000) throw new Error('oversized response'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const raw = Buffer.concat(chunks).toString('utf8');
    let envelope: { _hash?: unknown };
    try {
      envelope = JSON.parse(raw) as { _hash?: unknown };
    } catch {
      trace?.push(`${endpoint}=not-json:${raw.slice(0, 16).replace(/\s+/g, ' ')}`);
      throw new Error('not-json');
    }
    if (typeof envelope._hash !== 'string') {
      trace?.push(`${endpoint}=no-envelope`);
      throw new Error('missing envelope');
    }
    attempted.push(active.origin);
    try {
      return nxDecodeWith(envelope._hash, active.pass);
    } catch (error) {
      // Distinguish the three ways this fails, because they mean opposite
      // things. `bad-envelope` = the payload is not an OpenSSL envelope at all
      // (we got a stub). `bad-magic` = right length, wrong header.  `no-key` =
      // a real envelope that our passphrase does not open, i.e. upstream
      // rotated the key and the constant needs updating.  Collapsing these
      // into one word is what made this look like an outage.
      const bytes = Buffer.from(String(envelope._hash), 'base64url');
      const magic = bytes.subarray(0, 8).toString('latin1');
      const reason = bytes.length < 32 ? 'bad-envelope'
        : magic !== 'Salted__' ? 'bad-magic'
        : (error as NodeJS.ErrnoException).code === 'ERR_OSSL_BAD_DECRYPT' ? 'no-key'
        : 'no-key';
      trace?.push(`${endpoint}=undecodable:${reason}:${bytes.length}b`);
      throw new Error('undecodable');
    }
  };
  /**
   * The same catalogue is served by more than one front-end, each sealing with
   * its own public key. If the primary answers but no key of ours opens it, try
   * the alternate deployment before calling the source dead — that is a mirror
   * we can still read, not a lost provider.
   */
  const getWithFailover = async (endpoint: string, body: object) => {
    try {
      return await get(endpoint, body);
    } catch (error) {
      if ((error as Error).message !== 'undecodable') throw error;
      const alternate = ENDPOINTS.find(e => e.origin !== active.origin);
      if (!alternate) throw error;
      active = alternate;
      trace?.push(`failover=${new URL(alternate.origin).host}`);
      return await get(endpoint, body);
    }
  };
  try {
    const root = await getWithFailover('servers', params);
    const available = Array.isArray(root.servers) ? root.servers : [];
    // Restricted to Nitro and Indian-dub HLS lanes; avoid rejected providers,
    // season packs, embed-only hosts and unbounded request fan-out.
    const allowed = lanes ?? ['nitro', 'mhbox', 'awsind', 'rive-citadel', 'rive-primevids', 'rive-flowcast', 'rive-quasar', 'streamflix', 'vidapi', 'stvv'];
    if (!available.length) trace?.push('servers=none');
    const ids = [...new Set(available.map(s => s.scraper).filter((x): x is string => !!x && allowed.includes(x)))].sort((a,b) => allowed.indexOf(a) - allowed.indexOf(b));
    const rows: Stream[] = []; let finished = 0; let release: (() => void) | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    const all = Promise.all(ids.map(async provider => {
      try { const res = await getWithFailover('sources', { ...params, ex_lang: true, provider }); if (Array.isArray(res.sources)) rows.push(...res.sources.slice(0, 12)); } catch { /* one lane failing is expected */ }
      finally { finished++; if (!query.diag && rows.length && !timer) timer = setTimeout(() => release?.(), 350); }
    }));
    if (query.diag) await all;
    else if (ids.length) await Promise.race([all, new Promise<void>(r => { release = r; }), new Promise<void>(r => setTimeout(r, 2200))]);
    if (timer) clearTimeout(timer);
    if (available.length && !ids.length) {
      // The provider listed servers, but none matched the lanes we accept. That is
      // worth saying: it means the provider renamed or dropped their scrapers.
      trace?.push(`servers=${available.length}/0-matching-lanes`);
    }
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
  } catch (err) {
    // Keep the reason. Previously this was a bare `catch { return []; }`, so an
    // empty result could be a network failure, a refused request, a changed
    // envelope or a genuinely empty server list — and the panel said nothing.
    if (!trace?.length) {
      const name = err instanceof Error ? err.name : 'Error';
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      // Prefer the underlying cause ("ECONNRESET") over the wrapper name
      // ("TypeError"), which says nothing about what actually went wrong.
      trace?.push(`servers=${code ?? (name === 'TimeoutError' ? 'timeout' : name)}`);
    }
    return [];
  }
}
/**
 * The ScreenScape lane set, formerly its own adapter (source-7).
 *
 * It was never an independent source: it imported fetchFromNxsha from this very
 * file and posted to the same ORIGIN, i.e. it was a second lane list over one
 * host. Running it as a separate adapter meant two requests to the same upstream
 * per resolve, two independent failure paths, and two rows in the panel for one
 * provider — and it made a single upstream outage look like two sources dying at
 * once. It is now a lane set inside this adapter, which is what it always was.
 *
 * These lanes are still fetched and verified exactly as before (manifest-proven
 * multi-audio, explicitly labelled dubs); only the bookkeeping changed.
 */
export const SCREENSCAPE_LANES = ['mbox', 'bdxs', 'watchout', 'rive-hindicast', 'purstream', 'em-8'] as const;

export function createSource5Adapter(
  enabled: () => boolean,
  screenscapeEnabled: () => boolean = () => false,
): SourceAdapter {
  return {
    id: 'source-5',
    label: 'Source 5',
    enabled,
    async resolve(query) {
      const start = Date.now();
      // Both lane sets hit the same origin, so they are issued together rather
      // than as two adapters racing the same upstream. The ScreenScape half is
      // bounded tighter (4s) because it is the slower, more speculative set; if
      // it loses that race the primary lanes still answer on time.
      const discoverySignal = query.signal
        ? AbortSignal.any([query.signal, AbortSignal.timeout(4000)])
        : AbortSignal.timeout(4000);

      // Source-7 used to be a separate adapter that was off by default. The gate
      // is preserved exactly: merging the two must not quietly start fetching six
      // extra lanes on every resolve of a source that was meant to be fast.
      const wantScreenscape = screenscapeEnabled();
      const trace: string[] = [];
      const [primary, screenscape] = await Promise.all([
        fetchFromNxsha(query, undefined, { trace }),
        wantScreenscape
          ? fetchFromNxsha(
              { ...query, signal: discoverySignal, diag: [], onLateResult: undefined },
              SCREENSCAPE_LANES,
              { trace },
            )
          : Promise.resolve([] as RawStreamCandidate[]),
      ]);

      const primaryRows = primary.map((c) => (query.diag ? { ...c, diagnosticLane: 'N' } : c));

      // ScreenScape rows are only kept when they prove multi-audio or an
      // explicitly labelled dub. That filter is unchanged from the old adapter;
      // it is the whole reason these lanes were kept separate.
      const verified = screenscape.length
        ? await verifyAndFilterCandidatesDetailed(screenscape, query.signal)
        : { candidates: [] as RawStreamCandidate[] };
      const seen = new Set(primaryRows.map((c) => c.url));
      const extraRows = verified.candidates
        .filter((candidate) => {
          const evidence = candidateEvidence(candidate);
          const multiAudio = (evidence?.discoveredAudioLangs?.length ?? 0) > 1;
          const labelled = !!candidate.audioLang && candidate.audioLang !== 'und';
          return !!evidence?.alive && (multiAudio || labelled) && !seen.has(candidate.url);
        })
        .map((candidate) => (query.diag ? { ...candidate, diagnosticLane: 'S' } : candidate));

      query.diag?.push({
        adapter: 'source-5',
        lane: 'N',
        ok: primaryRows.length > 0 || extraRows.length > 0,
        ms: Date.now() - start,
        detail:
          `candidates=${primaryRows.length},screenscape=${screenscape.length},` +
          `verified=${extraRows.length}${trace.length ? ` ${[...new Set(trace)].slice(0, 4).join(' ')}` : ''}`,
      });
      return { candidates: [...primaryRows, ...extraRows] };
    },
  };
}
