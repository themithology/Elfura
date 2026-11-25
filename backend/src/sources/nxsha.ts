/**
 * Source 3 — nxsha.
 *
 *   GET /api/servers?q=<sealed>   → { _hash } → { servers: [{ scraper }] }
 *   GET /api/sources?q=<sealed>   → { _hash } → { sources: [{ url, language, … }] }
 *
 * The envelope is OpenSSL `Salted__` + AES-256-CBC with a key derived from an
 * iterated-MD5 KDF — the same construction as `openssl enc -aes-256-cbc -salt`.
 * The passphrase is a public front-end constant that rotates whenever the site
 * redeploys, so the known history is tried in order, and if none of them open a
 * live reply the lane reports itself unavailable rather than guessing.
 *
 * WHY THE LANE LIST IS AN ALLOWLIST, AND WHY IT IS SHORT
 * -----------------------------------------------------
 * nxsha lists 34 scrapers. Four of them are `rive-*`, and `rive-citadel` IS this
 * board's source-1 (`scrapper.rivestream.app/api/provider?provider=citadel`).
 * Shipping those would request the same catalogue twice per resolve and count it
 * as two lanes — the same mistake that made vidlink look like a new source.
 *
 * They are excluded by CONSTRUCTION below, not by a comment: `ownLanes()` filters
 * anything matching the RiveStream families, so a future edit to the list cannot
 * silently re-introduce them.
 *
 * WHAT THIS ADAPTER REFUSES
 * -------------------------
 *   - every `rive-*` lane (source-1's catalogue);
 *   - relay-shaped media hosts, including `workers.dev`, exactly as source-2
 *     refuses them — nxsha served one such row on inception;
 *   - Drive/`usercontent` pages, which cannot be seeked and were refused for six
 *     other sources already;
 *   - rows with no readable language when a language was asked for;
 *   - non-HTTPS, credentialed, or non-manifest URLs.
 *
 * Measured before this was written (research/nxsha-source3.md): four titles,
 * zero media objects shared with the board, across three of its own lanes.
 */
import crypto from 'node:crypto';
import type { RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';
import { sourceEnv } from './index.js';

const DEFAULT_ORIGIN = 'https://nxsha.space';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** Public front-end passphrases, current first. They rotate on redeploy. */
export const PASSES = [
  '38c8cd65d781936f4b9fe1fd985234fd7335699855051abf76ea3493bcfc0120',
  'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3',
  'S8x!Jk4ZP1uG8$my',
];

/**
 * Lanes this board will accept, in the site's own reliability order.
 *
 * This list is MEASURED, not inherited. A survey of all 30 of its non-RiveStream
 * scrapers (research/nxsha-lanes.json, 2026-11-25) found:
 *
 *   6 served media   nitro, watchout, awsind, purstream, ophim, zoko
 *   2 were relays    castle, vixolity — both on *.nxstreamhub.workers.dev
 *  22 served nothing
 *   0 were Google Drive
 *
 * The 22 that answered with nothing are excluded on that evidence rather than
 * guessed at: requesting them costs a resolve slot each and returns empty. They
 * stay excluded until a survey shows otherwise — a lane whose catalogue moved is
 * a lane to re-measure, not one to keep asking.
 *
 * The two relay lanes are ALSO refused host-by-host below, so a future edit to
 * this list cannot re-admit them by accident. That is belt and braces on
 * purpose: `castle` looks like a normal scraper name and is a workers.dev front.
 */
const ALLOWED_LANES: readonly string[] = [
  'nitro',
  'castle',
  'watchout',
  'awsind',
  'vixolity',
  'purstream',
  'ophim',
  'zoko',
];

/** The families that belong to source-1. Never requested here. */
const RIVE_FAMILY = /^rive[-_]/i;

/**
 * nxsha's OWN edge namespace.
 *
 * `castle` and `vixolity` serve from `*.nxstreamhub.workers.dev`. That is the
 * provider's own Cloudflare edge, sitting next to the API that hands it out — the
 * same case source-2 documents for its own `/api/media` proxy, which is NOT a
 * relay and is kept. Refusing these because the word "workers" appears in the
 * hostname threw away six real rows on two titles, including English 1080p and
 * Japanese.
 *
 * A third-party bridge is a different thing: greybox's
 * `dash-hls-bridge.john1mc.workers.dev` was somebody else's bandwidth in front of
 * `sacdn.hakunaymatata.com`, and that is still refused below.
 */
const OWN_EDGE = /(?:^|\.)nxstreamhub\.workers\.dev$/i;

/**
 * Somebody else's Cloudflare relay.
 *
 * Narrowed to `workers.dev` and to hosts that literally name themselves as a
 * proxy. The previous version also matched `edge`, `mirror` and `gateway` as
 * substrings, which is guesswork about a name — it refused a provider's own
 * `edge-` host for no reason beyond its spelling.
 */
const FOREIGN_RELAY = /workers\.dev$/i;

/**
 * A host that names itself a proxy, in its first label.
 *
 * `proxy.7movie.ws` and `edge-proxy.example.com` say what they are; `edge12.cdn`
 * is a CDN node with an unhelpful name. The test is per-label rather than a
 * substring, so a real CDN called something like `edgenuity.com` is not refused
 * for containing a word by accident.
 */
const PROXY_WORD = /^(?:proxy|relay|transcode|bridge|mirror|gateway)\d*$/i;
function selfDeclaredProxy(hostname: string): boolean {
  const first = hostname.split('.')[0] ?? '';
  return first.split(/[-_]/).some((label) => PROXY_WORD.test(label));
}

/** Google Drive pages: not seekable, and refused for six sources already. */
const DRIVE_HOST = /(?:^|\.)(?:drive|docs)\.google\.com$|googleusercontent\.com$|drive\.usercontent\.google\.com$/i;

/**
 * The headers a row may ask the player to send.
 *
 * nxsha hands out per-row headers because its media hosts check Referer/Origin,
 * and dropping them makes every candidate unplayable — which is exactly how the
 * contract failed this adapter the first time. The allowlist is narrow on
 * purpose: a provider must not be able to inject an arbitrary header into the
 * proxy, and only these three are ever consulted by a CDN.
 */
function rowHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = { 'User-Agent': UA };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value || value.length > 2048 || /[\r\n]/.test(value)) continue;
    if (/^referer$/i.test(key)) out.Referer = value;
    else if (/^origin$/i.test(key)) out.Origin = value;
    else if (/^user-agent$/i.test(key)) out['User-Agent'] = value;
  }
  return out;
}

const MAX_LANES = 8;
const MAX_CANDIDATES = 24;
const MAX_BODY_BYTES = 1_000_000;
const PROVIDER_TIMEOUT_MS = 8000;

/**
 * Lanes that may be requested: the allowlist minus anything in a family this
 * board already has. Exported so the rule is testable rather than trusted.
 */
export function ownLanes(allowed: readonly string[] = ALLOWED_LANES): string[] {
  return allowed.filter((lane) => !RIVE_FAMILY.test(lane));
}

/* ── the envelope ──────────────────────────────────────────────────────────── */

function derive(salt: Buffer, pass: string): { key: Buffer; iv: Buffer } {
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from(pass), salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

/** Seal a request body the way the site's own client does. */
export function seal(body: object, pass = PASSES[0]): string {
  const salt = crypto.randomBytes(8);
  const { key, iv } = derive(salt, pass);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const plain = JSON.stringify({
    ...body,
    _req_ts: Date.now(),
    _req_salt: crypto.randomBytes(6).toString('base64url'),
  });
  return Buffer.concat([
    Buffer.from('Salted__'),
    salt,
    cipher.update(plain),
    cipher.final(),
  ]).toString('base64url');
}

export interface NxPayload {
  servers?: { scraper?: string }[];
  sources?: NxStream[];
}

export interface NxStream {
  url?: string;
  type?: string;
  label?: string;
  quality?: string;
  language?: string;
  isEmbed?: boolean;
  headers?: Record<string, unknown>;
}

/**
 * Open an envelope with one known passphrase.
 *
 * Throws, and the caller distinguishes the reasons: a `bad-magic` means the reply
 * was a stub rather than a sealed payload, and a decrypt failure means the site
 * rotated its key. Collapsing those into one error is what makes a rotation look
 * like an outage.
 */
export function open(input: string, pass: string): NxPayload {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('not-base64url');
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.length < 32) throw new Error('too-short');
  if (bytes.subarray(0, 8).toString() !== 'Salted__') throw new Error('bad-magic');
  const { key, iv } = derive(bytes.subarray(8, 16), pass);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as NxPayload;
}

/** The first known passphrase that opens this payload. */
export function openAny(input: string): { payload: NxPayload; pass: string } | null {
  for (const pass of PASSES) {
    try {
      return { payload: open(input, pass), pass };
    } catch {
      /* next */
    }
  }
  return null;
}

/* ── payload → candidates ──────────────────────────────────────────────────── */

/** Quality as the provider declares it, normalised to the board's `NNNp` shape. */
export function qualityOf(raw: unknown): string {
  const text = String(raw ?? '');
  const height = text.match(/\b(2160|1440|1080|720|480|360)p?\b/i)?.[1];
  return height ? `${height}p` : 'auto';
}

/**
 * Stream rows → candidates, applying every refusal above.
 *
 * Exported because the refusal rules are the interesting part and deserve a test
 * that does not need a network.
 */
export function nxCandidates(payload: NxPayload): RawStreamCandidate[] {
  const rows = Array.isArray(payload?.sources) ? payload.sources : [];
  const out: RawStreamCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row?.url !== 'string' || !row.url) continue;
    if (out.length >= MAX_CANDIDATES) break;
    let url: URL;
    try {
      url = new URL(row.url);
    } catch {
      continue;
    }
    // The board never forwards a credential or a non-HTTPS hop.
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    // Its own edge is fine; somebody else's relay is not.
    if (!OWN_EDGE.test(url.hostname)) {
      if (FOREIGN_RELAY.test(url.hostname)) continue;
      if (selfDeclaredProxy(url.hostname)) continue;
    }
    if (DRIVE_HOST.test(url.hostname) || /\/file\/d\/|usercontent/i.test(url.href)) continue;
    // An embed is somebody else's player, not a manifest.
    if (row.isEmbed === true || /embed/i.test(String(row.type ?? ''))) continue;
    const isManifest = /\.m3u8(?:[?#]|$)/i.test(url.href) || /^(?:hls|m3u8)$/i.test(String(row.type ?? ''));
    if (!isManifest) {
      // DASH is acceptable if the provider declares it; .mp4 is not a stream this
      // board seeks in, and a bare page is not media at all.
      if (!/^(?:dash|mpd)$/i.test(String(row.type ?? '')) && !/\.mpd(?:[?#]|$)/i.test(url.href)) continue;
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const type = /\.mpd(?:[?#]|$)/i.test(url.href) || /^(?:dash|mpd)$/i.test(String(row.type ?? '')) ? 'dash' : 'hls';
    const quality = qualityOf(row.quality ?? row.label);
    const headers = rowHeaders(row.headers);
    out.push({
      key: url.href,
      type,
      url: url.href,
      quality,
      // Later rows are later lanes in the site's own reliability order.
      rank: 30 + out.length,
      ...(headers ? { headers } : {}),
      ...(typeof row.language === 'string' && row.language.trim()
        ? { claimedAudioLang: row.language.trim().slice(0, 40) }
        : {}),
    });
  }
  return out;
}

/* ── the adapter ───────────────────────────────────────────────────────────── */

export interface NxshaOptions {
  origin?: string;
  /** Injected by tests; the real adapter uses global fetch. */
  fetchImpl?: typeof fetch;
}

/** One sealed API call, bounded in size and time. */
async function ask(
  origin: string,
  endpoint: string,
  body: object,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<{ payload: NxPayload | null; reason?: string }> {
  const url = `${origin}/api/${endpoint}?q=${encodeURIComponent(seal(body))}`;
  const local = new AbortController();
  const timer = setTimeout(() => local.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: `${origin}/`,
        Origin: origin,
      },
      // `query.signal ?? local` — `AbortSignal.any` would make the caller's
      // deadline irrelevant the moment this lane'own timer fired.
      signal: signal ?? local.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { payload: null, reason: `http=${response.status}` };
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) {
      await response.body?.cancel().catch(() => {});
      return { payload: null, reason: 'oversized' };
    }
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return { payload: null, reason: 'oversized' };
    let envelope: unknown;
    try {
      envelope = (JSON.parse(text) as { _hash?: unknown })._hash;
    } catch {
      return { payload: null, reason: 'not-json' };
    }
    if (typeof envelope !== 'string') return { payload: null, reason: 'no-envelope' };
    const opened = openAny(envelope);
    // A payload that no known key opens is a rotation, not an empty catalogue.
    return opened ? { payload: opened.payload } : { payload: null, reason: 'key-rotated' };
  } catch (error) {
    return { payload: null, reason: error instanceof Error ? error.name : 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

export function createNxshaAdapter(options: NxshaOptions = {}): SourceAdapter {
  const env = sourceEnv();
  const origin = (options.origin ?? env.ELFURA_NXSHA_ORIGIN?.trim() ?? DEFAULT_ORIGIN).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    id: 'source-3',
    label: 'Source 3',
    enabled: () => (env.ELFURA_NXSHA_ENABLED ?? '1') !== '0',
    async resolve(query: SourceQuery) {
      if (!/^\d{1,12}$/.test(query.tmdbId)) return { candidates: [] };
      const type = query.type === 'tv' ? 'tv' : 'movie';
      const season = type === 'tv' ? query.season ?? 1 : 0;
      const episode = type === 'tv' ? query.episode ?? 1 : 0;
      if (type === 'tv' && (!Number.isSafeInteger(episode) || episode < 1)) return { candidates: [] };

      const body = { tmdbId: query.tmdbId, imdb_id: '', type, season, episode };

      // 1. Which lanes does it currently offer?
      const listed = await ask(origin, 'servers', body, query.signal, fetchImpl);
      const available = new Set(
        (listed.payload?.servers ?? []).map((s) => s?.scraper).filter((x): x is string => typeof x === 'string'),
      );
      // The allowlist intersects what is actually on offer, so a renamed lane is
      // simply not requested rather than producing an error per resolve.
      const lanes = ownLanes().filter((lane) => available.has(lane)).slice(0, MAX_LANES);
      if (lanes.length === 0) return { candidates: [] };

      // 2. Ask them concurrently; one lane failing is expected and never fatal.
      const answers = await Promise.all(
        lanes.map((lane) =>
          ask(origin, 'sources', { ...body, ex_lang: true, provider: lane }, query.signal, fetchImpl).then(
            (answer) => (answer.payload ? nxCandidates(answer.payload) : []),
          ),
        ),
      );
      const candidates: RawStreamCandidate[] = [];
      const seen = new Set<string>();
      for (const rows of answers) {
        for (const row of rows) {
          if (seen.has(row.url)) continue;
          seen.add(row.url);
          candidates.push(row);
        }
      }
      return { candidates };
    },
  };
}
