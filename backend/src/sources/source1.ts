/**
 * Elfura Backend — Source 1 Adapter
 * =================================
 * Multi-pipeline server-side stream resolver hardened against real-world
 * payloads verified across Hollywood blockbusters, K-dramas, TV anime, and
 * theatrical anime films:
 *   - Pipeline A: Scrambled `_serverFn` RPC (Seroval AST + 9-byte framed stream + XOR)
 *   - Pipeline B: Public JSON hub (`TG HUB v2`, `TG OUT`, `TGKAI` multi-audio HLS)
 *   - Pipeline C: Rift/Orion boot (`orionStreams` HLS + `mb.vidrift.net` MP4 + VTT subs)
 *   - Pipeline D: Sync multi-CDN (`Castle` & `VidZee` direct + `/api/core/proxy` dubs)
 *   - Pipeline E: Intro / Recap / Outro skip timestamp RPC
 */

import crypto from 'node:crypto';
import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import { normalizeLang } from './lang.js';
import type {
  RawSourceResult,
  RawStreamCandidate,
  RawTrackRef,
  SkipSegments,
  SourceAdapter,
  SourceQuery,
} from './types.js';

export { normalizeLang } from './lang.js';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const SECURE_SOURCES_FN_ID = 'ff183e1ad6d02c4c08e8e73151c60e5dcc23f8f4c9db53eac9d271b87a56e121';
const SKIP_SEGMENTS_FN_ID = '6b4f5d109b0ac5ecf27e114e441f6d776f5dc04af5eae9828d98adf707782e7c';
const SCRAMBLE_KEY = 'tGfL1x#9vQ';
const VROCK_KEY = Buffer.from(
  '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f',
  'hex',
);

const SUB_ORIGIN_COOLDOWN_MS = 5 * 60_000;
const deadSubOriginUntil = new Map<string, number>();

function isLoopbackOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

function isSubOriginCoolingDown(origin?: string): boolean {
  if (!origin) return true;
  if (isLoopbackOrigin(origin)) return false;
  const until = deadSubOriginUntil.get(origin);
  if (!until) return false;
  if (Date.now() < until) return true;
  deadSubOriginUntil.delete(origin);
  return false;
}

function tripSubOriginCooldown(origin?: string): void {
  if (!origin || isLoopbackOrigin(origin)) return;
  if (deadSubOriginUntil.size >= 64) {
    const oldest = deadSubOriginUntil.keys().next().value;
    if (oldest !== undefined) deadSubOriginUntil.delete(oldest);
  }
  deadSubOriginUntil.set(origin, Date.now() + SUB_ORIGIN_COOLDOWN_MS);
}

function pickBestQualityLabel(primary?: string, list?: string[]): string {
  const candidates = [primary, ...(Array.isArray(list) ? list : [])].filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  let bestHeight = 0;
  for (const q of candidates) {
    if (/4k|2160/i.test(q)) bestHeight = Math.max(bestHeight, 2160);
    else {
      const m = q.match(/(\d{3,4})p/i);
      if (m) bestHeight = Math.max(bestHeight, Number(m[1]));
    }
  }
  if (bestHeight >= 2160) return '2160p';
  if (bestHeight > 0) return `${bestHeight}p`;
  return (primary || 'auto').toLowerCase();
}

/* ------------------------------------------------------------------ */
/* XOR payload unscrambler (`tGfL1x#9vQ`)                              */
/* ------------------------------------------------------------------ */

export function unscramblePayload(scrambled: string): string {
  const reversed = scrambled.split('').reverse().join('');
  const raw = Buffer.from(reversed, 'base64');
  const out = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] ^ SCRAMBLE_KEY.charCodeAt(i % 10) ^ (i & 0xff);
  }
  return out.toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Minimal zero-dependency Seroval + TanStack Start framed RPC client  */
/* ------------------------------------------------------------------ */

interface SerovalNode {
  t: number;
  i?: number;
  s?: unknown;
  a?: SerovalNode[];
  p?: { k: string[]; v: SerovalNode[] };
  o?: number;
}

function escapeSerovalString(str: string): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\b': out += '\\b'; break;
      case '\t': out += '\\t'; break;
      case '\f': out += '\\f'; break;
      case '<': out += '\\x3C'; break;
      case '\u2028': out += '\\u2028'; break;
      case '\u2029': out += '\\u2029'; break;
      default: out += ch;
    }
  }
  return out;
}

function unescapeSerovalString(str: string): string {
  if (!str.includes('\\')) return str;
  return str.replace(/(\\\\|\\"|\\n|\\r|\\b|\\t|\\f|\\u2028|\\u2029|\\x3C)/g, (m) => {
    switch (m) {
      case '\\\\': return '\\';
      case '\\"': return '"';
      case '\\n': return '\n';
      case '\\r': return '\r';
      case '\\b': return '\b';
      case '\\t': return '\t';
      case '\\f': return '\f';
      case '\\x3C': return '<';
      case '\\u2028': return '\u2028';
      case '\\u2029': return '\u2029';
      default: return m;
    }
  });
}

export function serializeSerovalEnvelope(input: unknown): string {
  let nextRef = 0;
  const encode = (val: unknown): SerovalNode => {
    if (val === null) return { t: 2, s: 0 };
    if (val === undefined) return { t: 2, s: 1 };
    if (val === true) return { t: 2, s: 2 };
    if (val === false) return { t: 2, s: 3 };
    if (typeof val === 'number') return { t: 0, s: val };
    if (typeof val === 'string') return { t: 1, s: escapeSerovalString(val) };
    if (Array.isArray(val)) {
      const id = nextRef++;
      return { t: 9, i: id, a: val.map(encode), o: 0 };
    }
    if (typeof val === 'object') {
      const id = nextRef++;
      const entries = Object.entries(val as Record<string, unknown>);
      return {
        t: 10,
        i: id,
        p: {
          k: entries.map(([k]) => escapeSerovalString(k)),
          v: entries.map(([, v]) => encode(v)),
        },
        o: 0,
      };
    }
    return { t: 2, s: 1 };
  };

  return JSON.stringify({ t: encode(input), f: 127, m: [] });
}

export function deserializeSerovalNode(raw: unknown): unknown {
  const refs = new Map<number, unknown>();
  const CONSTS: Record<number, unknown> = {
    0: null,
    1: undefined,
    2: true,
    3: false,
    4: -0,
    5: Infinity,
    6: -Infinity,
    7: NaN,
  };

  const decode = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    const n = node as SerovalNode & { t?: unknown };
    if (typeof n.t === 'object' && n.t !== null && !('i' in n)) {
      return decode(n.t);
    }
    if (typeof n.t !== 'number') return node;
    switch (n.t) {
      case 0:
        return Number(n.s);
      case 1:
        return unescapeSerovalString(String(n.s ?? ''));
      case 2:
        return CONSTS[Number(n.s)];
      case 4:
        return n.i !== undefined ? refs.get(n.i) : undefined;
      case 9: {
        const arr: unknown[] = [];
        if (n.i !== undefined) refs.set(n.i, arr);
        for (const item of n.a ?? []) arr.push(decode(item));
        return arr;
      }
      case 10:
      case 11: {
        const obj: Record<string, unknown> = n.t === 11 ? Object.create(null) : {};
        if (n.i !== undefined) refs.set(n.i, obj);
        const keys = n.p?.k ?? [];
        const vals = n.p?.v ?? [];
        for (let idx = 0; idx < keys.length; idx++) {
          const key = unescapeSerovalString(String(keys[idx]));
          if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
            obj[key] = decode(vals[idx]);
          }
        }
        return obj;
      }
      default:
        return undefined;
    }
  };

  return decode(raw);
}

function decodeTssFramedBuffer(buf: Buffer): unknown {
  let offset = 0;
  while (offset + 9 <= buf.length) {
    const frameType = buf[offset];
    const streamId = buf.readUInt32BE(offset + 1);
    const frameLen = buf.readUInt32BE(offset + 5);
    offset += 9;
    if (offset + frameLen > buf.length) break;
    const slice = buf.subarray(offset, offset + frameLen);
    offset += frameLen;
    if (frameType === 0 && streamId === 0) {
      const parsed = JSON.parse(slice.toString('utf8'));
      return deserializeSerovalNode(parsed);
    }
  }
  return null;
}

async function callServerFn<T = unknown>(opts: {
  appOrigin: string;
  fnId: string;
  method: 'GET' | 'POST';
  data: unknown;
  refererPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<T | null> {
  const serialized = serializeSerovalEnvelope({ data: opts.data });
  let url = `${opts.appOrigin}/_serverFn/${opts.fnId}`;
  if (opts.method === 'GET') {
    url += `?payload=${encodeURIComponent(serialized)}`;
  }

  const headers: Record<string, string> = {
    'x-tsr-serverFn': 'true',
    accept: 'application/x-tss-framed, application/x-ndjson, application/json',
    origin: opts.appOrigin,
    referer: `${opts.appOrigin}${opts.refererPath}`,
    'user-agent': BROWSER_UA,
  };
  if (opts.method === 'POST') headers['content-type'] = 'application/json';

  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
    : AbortSignal.timeout(opts.timeoutMs);

  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.method === 'POST' ? serialized : undefined,
    signal,
  });
  if (!res.ok) return null;

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const isSerialized = !!res.headers.get('x-tss-serialized');

  if (ct.includes('application/x-tss-framed')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return (decodeTssFramedBuffer(buf) as T) ?? null;
  }

  if (ct.includes('application/json')) {
    const json = await res.json();
    if (isSerialized) return deserializeSerovalNode(json) as T;
    if (json && typeof json === 'object' && 'result' in (json as Record<string, unknown>)) {
      return (json as { result: T }).result;
    }
    return json as T;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Helpers to normalize upstream payloads                              */
/* ------------------------------------------------------------------ */

interface UpstreamLink {
  server?: string;
  label?: string;
  quality?: string;
  qualities?: string[];
  type?: string;
  url?: string;
  mirrors?: string[];
  subtitles?: { label?: string; lang?: string; url?: string }[];
  audios?: string[];
  audioLang?: string;
  audio_tracks?: { label?: string; lang?: string; url?: string }[];
  audioFiles?: { label?: string; lang?: string; url?: string; kind?: string }[];
  multi_audio?: boolean;
  headers?: Record<string, string>;
}

interface UpstreamApiPayload {
  ok?: boolean;
  imdb_id?: string | null;
  title?: string | null;
  year?: string | number | null;
  links?: UpstreamLink[];
}

function inferStreamType(rawType?: string, url = ''): 'hls' | 'dash' | 'mp4' {
  const t = (rawType || '').toLowerCase();
  if (t === 'dash' || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  if (t === 'mp4' || t === 'mkv' || t === 'webm' || /\.(?:mp4|webm|mkv)(?:[?#]|$)/i.test(url)) return 'mp4';
  return 'hls';
}

function mapSubtitles(
  subs: { label?: string; lang?: string; url?: string }[] | undefined,
  baseHeaders?: Record<string, string>,
): RawTrackRef[] {
  if (!Array.isArray(subs)) return [];
  const seen = new Set<string>();
  const out: RawTrackRef[] = [];
  for (const s of subs) {
    if (!s?.url || !isSafeUpstreamUrl(s.url)) continue;
    const cleanLabel = String(s.label ?? '').replace(/\s*·\s*Orion\s*$/i, '').trim();
    const norm = normalizeLang(s.lang || cleanLabel, cleanLabel);
    const dedupKey = `${norm.code}:${s.url}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      lang: norm.code,
      label: norm.label,
      url: s.url,
      ...(baseHeaders ? { headers: baseHeaders } : {}),
    });
  }
  return out;
}

function mapDirectAudioFiles(
  files: { label?: string; lang?: string; url?: string; kind?: string }[] | undefined,
  baseHeaders?: Record<string, string>,
): RawTrackRef[] {
  if (!Array.isArray(files)) return [];
  const out: RawTrackRef[] = [];
  for (const f of files) {
    if (!f?.url || !isSafeUpstreamUrl(f.url)) continue;
    if (/\.m3u8(?:[?#]|$)/i.test(f.url)) continue;
    if (f.kind && f.kind !== 'file') continue;
    const norm = normalizeLang(f.lang || f.label, f.label);
    out.push({
      lang: norm.code,
      label: norm.label,
      url: f.url,
      ...(baseHeaders ? { headers: baseHeaders } : {}),
    });
  }
  return out;
}

function detectLinkLanguage(link: UpstreamLink): {
  code?: string;
  label?: string;
  availableAudioLangs?: string[];
  multiAudio: boolean;
} {
  const discovered = new Set<string>();
  if (Array.isArray(link.audios)) {
    for (const raw of link.audios) {
      const n = normalizeLang(raw, raw);
      if (n.code && n.code !== 'und') discovered.add(n.code);
    }
  }
  if (Array.isArray(link.audio_tracks)) {
    for (const t of link.audio_tracks) {
      const n = normalizeLang(t?.lang || t?.label, t?.label);
      if (n.code && n.code !== 'und') discovered.add(n.code);
    }
  }

  const multi =
    !!link.multi_audio ||
    (Array.isArray(link.audios) && link.audios.length > 1) ||
    (Array.isArray(link.audio_tracks) && link.audio_tracks.length > 1) ||
    discovered.size > 1;

  const availableAudioLangs = discovered.size > 0 ? [...discovered] : undefined;

  if (link.audioLang) {
    const n = normalizeLang(link.audioLang, link.audioLang);
    return { code: n.code, label: n.label, availableAudioLangs, multiAudio: multi };
  }
  if (!multi && discovered.size === 1) {
    const only = [...discovered][0];
    const n = normalizeLang(only, only);
    return { code: n.code, label: n.label, availableAudioLangs, multiAudio: false };
  }
  return { availableAudioLangs, multiAudio: multi };
}

function mapApiLinksToCandidates(
  links: UpstreamLink[],
  defaultReferer: string,
  baseRank: number,
): RawStreamCandidate[] {
  const out: RawStreamCandidate[] = [];
  for (let idx = 0; idx < links.length; idx++) {
    const link = links[idx];
    if (!link?.url || !isSafeUpstreamUrl(link.url)) continue;

    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      Referer: defaultReferer,
      ...(link.headers ?? {}),
    };

    const langInfo = detectLinkLanguage(link);
    const streamType = inferStreamType(link.type, link.url);
    const quality = pickBestQualityLabel(link.quality, link.qualities);
    const mirrorUrl = (link.mirrors ?? []).find((m) => typeof m === 'string' && isSafeUpstreamUrl(m));

    out.push({
      key: link.url,
      type: streamType,
      url: link.url,
      headers,
      quality,
      audioLang: langInfo.code,
      audioLabel: langInfo.label,
      ...(langInfo.availableAudioLangs ? { availableAudioLangs: langInfo.availableAudioLangs } : {}),
      multiAudio: langInfo.multiAudio,
      audioTracks: mapDirectAudioFiles(link.audioFiles, headers),
      subtitles: mapSubtitles(link.subtitles),
      ...(mirrorUrl ? { standbyUrl: mirrorUrl, standbyHeaders: headers } : {}),
      rank: baseRank + idx,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sub-Pipelines                                                       */
/* ------------------------------------------------------------------ */

async function fetchFromSecureFn(
  cfg: BackendConfig['source1'],
  apiPath: string,
  refererPath: string,
  signal?: AbortSignal,
): Promise<UpstreamApiPayload | null> {
  if (isSubOriginCoolingDown(cfg.appOrigin)) return null;
  try {
    const res = await callServerFn<{ p?: string }>({
      appOrigin: cfg.appOrigin,
      fnId: SECURE_SOURCES_FN_ID,
      method: 'POST',
      data: { path: apiPath },
      refererPath,
      timeoutMs: 3800,
      signal,
    });
    if (!res?.p || typeof res.p !== 'string') {
      if (!res) tripSubOriginCooldown(cfg.appOrigin);
      return null;
    }
    const jsonText = unscramblePayload(res.p);
    return JSON.parse(jsonText) as UpstreamApiPayload;
  } catch {
    tripSubOriginCooldown(cfg.appOrigin);
    return null;
  }
}

async function fetchFromPublicApi(
  cfg: BackendConfig['source1'],
  apiPath: string,
  signal?: AbortSignal,
): Promise<UpstreamApiPayload | null> {
  if (isSubOriginCoolingDown(cfg.apiOrigin)) return null;
  try {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(3800)]) : AbortSignal.timeout(3800);
    const res = await fetch(`${cfg.apiOrigin}${apiPath}`, {
      headers: {
        Accept: 'application/json',
        Origin: cfg.appOrigin || cfg.apiOrigin,
        Referer: `${cfg.appOrigin || cfg.apiOrigin}/`,
        'User-Agent': BROWSER_UA,
      },
      signal: sig,
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !ct.includes('application/json')) {
      if (res.status >= 500 || res.url.includes('/blocked') || ct.includes('text/html')) {
        tripSubOriginCooldown(cfg.apiOrigin);
      }
      return null;
    }
    const data = (await res.json()) as UpstreamApiPayload;
    return data?.ok ? data : null;
  } catch {
    tripSubOriginCooldown(cfg.apiOrigin);
    return null;
  }
}

async function fetchFromRiftBoot(
  cfg: BackendConfig['source1'],
  query: SourceQuery,
): Promise<RawStreamCandidate[]> {
  if (isSubOriginCoolingDown(cfg.riftOrigin)) return [];
  const bootPath =
    query.type === 'movie'
      ? `/api/boot/movie/${encodeURIComponent(query.tmdbId)}`
      : `/api/boot/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;
  const bootUrl = `${cfg.riftOrigin}${bootPath}`;
  const wrapRelay = (target: string, manifest = false) =>
    cfg.riftRelay
      ? `${cfg.riftRelay}/api/relay?u=${Buffer.from(target, 'utf8').toString('base64url')}${manifest ? '&m=1' : ''}`
      : target;

  try {
    const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3800)]) : AbortSignal.timeout(3800);
    let res = await fetch(bootUrl, {
      headers: {
        Accept: 'application/json',
        Referer: `${cfg.riftOrigin}/`,
        'User-Agent': BROWSER_UA,
      },
      signal: sig,
    });
    if (!res.ok && cfg.riftRelay && !isSubOriginCoolingDown(cfg.riftRelay)) {
      res = await fetch(wrapRelay(bootUrl, false), {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(3500),
      });
      if (!res.ok) tripSubOriginCooldown(cfg.riftRelay);
    }
    if (!res.ok) {
      if (res.status === 404 || res.status >= 500) tripSubOriginCooldown(cfg.riftOrigin);
      return [];
    }

    const payload = (await res.json()) as {
      meta?: {
        evionUrl?: string;
        playbackToken?: string;
        orionStreams?: {
          url?: string;
          type?: string;
          name?: string;
          rungs?: { height?: number }[];
          subtitleListUrl?: string;
        }[];
      };
    };
    const meta = payload?.meta;
    if (!meta) return [];
    const riftPlaybackToken = typeof meta.playbackToken === 'string' ? meta.playbackToken.trim() : '';

    const orion = (meta.orionStreams ?? []).filter(
      (s) => typeof s?.url === 'string' && s.url.includes('/api/orion/'),
    );

    // Fetch subtitles with a fast 950ms cap (direct Orion when playbackToken is present, else relay)
    let sharedSubs: RawTrackRef[] = [];
    const firstHash = orion[0]?.url?.split('/api/orion/')[1]?.split('/')[0];
    if (firstHash) {
      try {
        const directSubUrl = `${cfg.riftOrigin}/api/orion/${firstHash}/subtitles.json`;
        const relaySubUrl = wrapRelay(directSubUrl, false);
        const subRes = riftPlaybackToken
          ? await fetch(directSubUrl, {
              headers: {
                Referer: `${cfg.riftOrigin}/`,
                Origin: cfg.riftOrigin,
                'User-Agent': BROWSER_UA,
                'X-Playback-Token': riftPlaybackToken,
              },
              signal: AbortSignal.timeout(950),
            }).catch(() => null)
          : await fetch(relaySubUrl, {
              headers: { 'User-Agent': BROWSER_UA },
              signal: AbortSignal.timeout(950),
            }).catch(() => null);
        if (subRes?.ok) {
          const subBody = (await subRes.json()) as { tracks?: { label?: string; lang?: string; url?: string }[] };
          if (Array.isArray(subBody?.tracks) && subBody.tracks.length > 0) {
            const directHeaders = riftPlaybackToken
              ? {
                  Referer: `${cfg.riftOrigin}/`,
                  Origin: cfg.riftOrigin,
                  'User-Agent': BROWSER_UA,
                  'X-Playback-Token': riftPlaybackToken,
                }
              : undefined;
            sharedSubs = mapSubtitles(
              subBody.tracks.map((t) => ({
                label: t.label,
                lang: t.lang,
                url: t.url
                  ? riftPlaybackToken
                    ? `${cfg.riftOrigin}${t.url}`
                    : wrapRelay(`${cfg.riftOrigin}${t.url}`, false)
                  : undefined,
              })),
              directHeaders,
            );
          }
        }
      } catch {
        /* ignore subtitle timeout */
      }
    }

    const out: RawStreamCandidate[] = [];
    for (let i = 0; i < orion.length; i++) {
      const s = orion[i];
      if (!s.url) continue;
      const hash = s.url.split('/api/orion/')[1]?.split('/')[0];
      if (!hash) continue;

      const rawLangName = String(s.name ?? 'Original').split('·').pop()?.trim() || 'Original';
      const norm = normalizeLang(rawLangName, rawLangName);
      const maxHeight = Math.max(0, ...(s.rungs ?? []).map((r) => Number(r.height || 0)));
      const streamType = inferStreamType(s.type, s.url);

      let finalUrl: string;
      let headers: Record<string, string> = { 'User-Agent': BROWSER_UA };
      let standbyUrl: string | undefined;
      let standbyHeaders: Record<string, string> | undefined;

      if (streamType === 'mp4' && /^https?:\/\//i.test(s.url)) {
        // Direct progressive MP4 dub (e.g. mb.vidrift.net/.../video.mp4)
        finalUrl = s.url;
        headers = { Referer: `${cfg.riftOrigin}/`, 'User-Agent': BROWSER_UA };
      } else {
        const absTarget = /^https?:\/\//i.test(s.url)
          ? s.url
          : `${cfg.riftOrigin}/api/orion/${hash}/master.m3u8`;
        const relayedTarget = wrapRelay(absTarget, streamType === 'hls');
        const directOrionHeaders: Record<string, string> = {
          Referer: `${cfg.riftOrigin}/`,
          Origin: cfg.riftOrigin,
          'User-Agent': BROWSER_UA,
          ...(riftPlaybackToken ? { 'X-Playback-Token': riftPlaybackToken } : {}),
        };
        if (riftPlaybackToken && isSafeUpstreamUrl(absTarget)) {
          // Prefer direct Orion HLS when boot provided a live playbackToken (avoids paused external relays)
          finalUrl = absTarget;
          headers = directOrionHeaders;
          if (relayedTarget !== absTarget && isSafeUpstreamUrl(relayedTarget)) {
            standbyUrl = relayedTarget;
            standbyHeaders = { 'User-Agent': BROWSER_UA };
          }
        } else {
          finalUrl = relayedTarget;
          if (absTarget !== finalUrl && isSafeUpstreamUrl(absTarget)) {
            standbyUrl = absTarget;
            standbyHeaders = directOrionHeaders;
          }
        }
      }

      if (!isSafeUpstreamUrl(finalUrl)) continue;

      out.push({
        key: `orion:${hash}:${streamType}`,
        type: streamType,
        url: finalUrl,
        headers,
        quality: maxHeight ? `${maxHeight}p` : 'auto',
        audioLang: norm.code,
        audioLabel: norm.label,
        multiAudio: false,
        subtitles: sharedSubs,
        ...(standbyUrl ? { standbyUrl, standbyHeaders } : {}),
        rank: (streamType === 'hls' ? 15 : 35) + i,
      });
    }

    if (typeof meta.evionUrl === 'string' && isSafeUpstreamUrl(meta.evionUrl)) {
      out.push({
        key: meta.evionUrl,
        type: inferStreamType('hls', meta.evionUrl),
        url: meta.evionUrl,
        headers: {
          Referer: `${cfg.riftOrigin}/`,
          'User-Agent': BROWSER_UA,
        },
        quality: 'auto',
        subtitles: sharedSubs,
        rank: 45,
      });
    }

    return out;
  } catch {
    return [];
  }
}

const IP_LOCKED_RE = /(?::\d{1,3}(?:\.\d{1,3}){3}:|[?&]KeyName=Signature\b)/i;

async function fetchFromVidSync(
  cfg: BackendConfig['source1'],
  query: SourceQuery,
): Promise<RawStreamCandidate[]> {
  if (isSubOriginCoolingDown(cfg.syncOrigin)) return [];
  const qs =
    query.type === 'movie'
      ? `type=movie&id=${encodeURIComponent(query.tmdbId)}&season=1&episode=1`
      : `type=tv&id=${encodeURIComponent(query.tmdbId)}&season=${query.season ?? 1}&episode=${query.episode ?? 1}`;

  const grab = async (endpoint: string) => {
    try {
      const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(6500)]) : AbortSignal.timeout(6500);
      const res = await fetch(endpoint, {
        headers: {
          Accept: 'application/json',
          Referer: `${cfg.syncOrigin}/`,
          'User-Agent': BROWSER_UA,
        },
        signal: sig,
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  interface SyncSourceRow {
    id?: string;
    provider?: { id?: string; name?: string };
    url?: string;
    directUrl?: string;
    rawUrl?: string;
    type?: string;
    quality?: string;
    availableQualities?: string[];
    audioLanguage?: string;
    language?: string;
    audioLabel?: string;
    audioTracks?: { language?: string; label?: string }[];
    subtitles?: { label?: string; lang?: string; url?: string }[];
    headers?: Record<string, string>;
    standbyUrl?: string;
    standbyHeaders?: Record<string, string>;
  }

  interface SyncResponse {
    sources?: SyncSourceRow[];
    subtitles?: { label?: string; lang?: string; url?: string }[];
  }

  const [coreJson, streamJson] = (await Promise.all([
    grab(`${cfg.syncOrigin}/api/core/streams?${qs}`),
    grab(`${cfg.syncOrigin}/api/stream?${qs}`),
  ])) as [SyncResponse | null, SyncResponse | null];

  const rows: SyncSourceRow[] = [...(coreJson?.sources ?? []), ...(streamJson?.sources ?? [])];
  const topLevelSubs = [...(coreJson?.subtitles ?? []), ...(streamJson?.subtitles ?? [])];

  // Detect if multiple distinct audio languages share an identical directUrl
  // (e.g. Castle returning the English rawUrl on Hindi/Japanese rows while
  // row.url `/api/core/proxy?...&defaultAudio=hi` serves the real dub).
  const langsByDirectUrl = new Map<string, Set<string>>();
  for (const r of rows) {
    const dUrl = r?.directUrl || r?.rawUrl;
    if (!dUrl) continue;
    const lang = normalizeLang(r.audioLanguage || r.language || 'en', r.audioLabel).code;
    if (!langsByDirectUrl.has(dUrl)) langsByDirectUrl.set(dUrl, new Set());
    langsByDirectUrl.get(dUrl)!.add(lang);
  }

  rows.sort((a, b) => {
    const aCastle = a?.provider?.id === 'castle' ? 0 : 1;
    const bCastle = b?.provider?.id === 'castle' ? 0 : 1;
    if (aCastle !== bCastle) return aCastle - bCastle;
    // Prefer Auto or 1080p rows first when collapsing duplicate quality rows
    const scoreQ = (q?: string) => (/1080/i.test(q || '') ? 0 : /auto/i.test(q || '') ? 1 : /720/i.test(q || '') ? 2 : 3);
    return scoreQ(a?.quality) - scoreQ(b?.quality);
  });

  const seenGroup = new Set<string>();
  const seenPrimaryUrl = new Set<string>();
  const out: RawStreamCandidate[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const directCandidate = row?.directUrl || row?.rawUrl || '';
    const proxyCandidate =
      typeof row?.url === 'string' && row.url.startsWith('/')
        ? `${cfg.syncOrigin}${row.url}`
        : typeof row?.url === 'string' && /^https?:\/\//i.test(row.url)
          ? row.url
          : '';

    const norm = normalizeLang(row.audioLanguage || row.language || 'en', row.audioLabel);
    const providerKey = (row.provider?.id || 'sync').toLowerCase();

    // Collapse Castle's 5 quality clones (`1080p`, `720p`, `480p`, `360p`, `Auto`) per language
    const groupKey = `${providerKey}:${norm.code}:${(directCandidate || proxyCandidate).split('?')[0]}`;
    if (seenGroup.has(groupKey)) continue;
    seenGroup.add(groupKey);

    const sharedDirectAcrossLangs =
      directCandidate && (langsByDirectUrl.get(directCandidate)?.size ?? 0) > 1 && norm.code !== 'en';

    // Always prefer vidsync's `/api/core/proxy` whenever provided (prevents 403 rejections
    // on IP-signed `hscow.com` / `fcxmb.com` / `fastcloud.live` URLs and preserves multi-dub routing).
    const preferProxy = !!proxyCandidate;
    const primaryUrl = preferProxy ? proxyCandidate : directCandidate || proxyCandidate;
    if (!primaryUrl || !isSafeUpstreamUrl(primaryUrl) || seenPrimaryUrl.has(primaryUrl)) continue;
    seenPrimaryUrl.add(primaryUrl);

    const primaryHeaders: Record<string, string> = preferProxy
      ? { Referer: `${cfg.syncOrigin}/`, 'User-Agent': BROWSER_UA }
      : { 'User-Agent': BROWSER_UA, ...(row.headers ?? {}) };

    let standbyUrl: string | undefined;
    let standbyHeaders: Record<string, string> | undefined;
    if (preferProxy) {
      // Keep the direct CDN lane as a real failover even when its signature
      // looks IP-bound. Server liveness will prune it if this host cannot use
      // it; dropping it here strands working titles when the proxy rewrites
      // malformed child URIs or starts rejecting segment requests.
      if (directCandidate && !sharedDirectAcrossLangs && isSafeUpstreamUrl(directCandidate)) {
        standbyUrl = directCandidate;
        standbyHeaders = { 'User-Agent': BROWSER_UA, ...(row.headers ?? {}) };
      }
    } else if (row.standbyUrl && isSafeUpstreamUrl(row.standbyUrl) && !IP_LOCKED_RE.test(row.standbyUrl)) {
      standbyUrl = row.standbyUrl;
      standbyHeaders = { 'User-Agent': BROWSER_UA, ...(row.standbyHeaders ?? row.headers ?? {}) };
    } else if (proxyCandidate && isSafeUpstreamUrl(proxyCandidate)) {
      standbyUrl = proxyCandidate;
      standbyHeaders = { Referer: `${cfg.syncOrigin}/`, 'User-Agent': BROWSER_UA };
    }

    const discoveredRowLangs = Array.isArray(row.audioTracks)
      ? [
          ...new Set(
            row.audioTracks
              .map((t) => normalizeLang(t?.language || t?.label, t?.label).code)
              .filter((c) => c && c !== 'und'),
          ),
        ]
      : [];

    out.push({
      key: primaryUrl,
      type: inferStreamType(row.type, primaryUrl),
      url: primaryUrl,
      headers: primaryHeaders,
      quality: pickBestQualityLabel(row.quality, row.availableQualities),
      audioLang: norm.code,
      audioLabel: norm.label,
      ...(discoveredRowLangs.length ? { availableAudioLangs: discoveredRowLangs } : {}),
      multiAudio: Array.isArray(row.audioTracks) && row.audioTracks.length > 1,
      subtitles: mapSubtitles([...(row.subtitles ?? []), ...topLevelSubs]),
      ...(standbyUrl ? { standbyUrl, standbyHeaders } : {}),
      rank: 2 + i,
    });
  }

  return out;
}

const GENERIC_VROCK_SERVER_RE =
  /^(?:nova|atlas|orion|astra|luna|lyra|vega|hydra|alpha|beta|delta|omega|server\s*\d*|auto|main|backup|vip\s*\d*)$/i;

function decryptVidRockToken(token: string): string | null {
  try {
    const clean = token.trim();
    if (!clean || clean.length < 40) return null;
    const raw = Buffer.from(clean, 'base64url');
    if (raw.length <= 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', VROCK_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8').trim();
  } catch {
    return null;
  }
}

async function fetchFromVidRock(
  cfg: BackendConfig['source1'],
  query: SourceQuery,
): Promise<RawStreamCandidate[]> {
  const origin = cfg.vidrockOrigin;
  if (!origin || isSubOriginCoolingDown(origin)) return [];

  const apiPath =
    query.type === 'movie'
      ? `/api/movie/${encodeURIComponent(query.tmdbId)}`
      : `/api/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;

  try {
    const sig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(4800)]) : AbortSignal.timeout(4800);
    const res = await fetch(`${origin}${apiPath}`, {
      headers: {
        Accept: 'application/json',
        Referer: `${origin}/`,
        Origin: origin,
        'User-Agent': BROWSER_UA,
      },
      signal: sig,
    });
    if (!res.ok) {
      if (res.status >= 500) tripSubOriginCooldown(origin);
      return [];
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object') return [];

    // VidRock's ngcorp media hosts reject real browser user agents and any
    // vidrock.net Referer. Their accepted stream contract is a single-space
    // UA with no Origin/Referer; the API request above intentionally uses
    // different headers from the media requests.
    const mediaHeaders: Record<string, string> = { 'User-Agent': ' ' };

    const out: RawStreamCandidate[] = [];
    const seen = new Set<string>();
    let idx = 0;

    for (const [srvName, rawVal] of Object.entries(body)) {
      let streamUrl = '';
      let subs: RawTrackRef[] = [];

      if (typeof rawVal === 'string') {
        const dec = /^https?:\/\//i.test(rawVal) ? rawVal : decryptVidRockToken(rawVal);
        if (!dec) continue;
        if (dec.startsWith('{')) {
          try {
            const parsed = JSON.parse(dec) as {
              url?: string;
              file?: string;
              subtitles?: { label?: string; lang?: string; url?: string }[];
            };
            streamUrl = String(parsed.url || parsed.file || '').trim();
            subs = mapSubtitles(parsed.subtitles, mediaHeaders);
          } catch {
            continue;
          }
        } else {
          streamUrl = dec;
        }
      } else if (rawVal && typeof rawVal === 'object') {
        const obj = rawVal as {
          url?: string;
          token?: string;
          hash?: string;
          subtitles?: { label?: string; lang?: string; url?: string }[];
        };
        const candidateStr = String(obj.url || obj.token || obj.hash || '').trim();
        const dec = /^https?:\/\//i.test(candidateStr) ? candidateStr : decryptVidRockToken(candidateStr);
        if (dec) streamUrl = dec;
        subs = mapSubtitles(obj.subtitles, mediaHeaders);
      }

      if (!streamUrl || !isSafeUpstreamUrl(streamUrl) || seen.has(streamUrl)) continue;
      try {
        const mediaHost = new URL(streamUrl).hostname.toLowerCase();
        // Workers lanes are TLS/browser-gated and return a placeholder rather
        // than an HLS manifest to the backend. Never advertise them as playable.
        if (mediaHost === 'workers.dev' || mediaHost.endsWith('.workers.dev')) continue;
      } catch {
        continue;
      }
      seen.add(streamUrl);

      let audioLang: string | undefined;
      let audioLabel: string | undefined;
      if (!GENERIC_VROCK_SERVER_RE.test(srvName.trim())) {
        const norm = normalizeLang(srvName, srvName);
        if (norm.code && norm.code !== 'und') {
          audioLang = norm.code;
          audioLabel = norm.label;
        }
      }

      out.push({
        key: `vrock:${srvName}:${streamUrl}`,
        type: inferStreamType('hls', streamUrl),
        url: streamUrl,
        headers: mediaHeaders,
        quality: 'auto',
        ...(audioLang ? { audioLang, audioLabel } : {}),
        multiAudio: false,
        subtitles: subs,
        rank: 8 + idx++,
      });
    }

    return out;
  } catch {
    return [];
  }
}

async function fetchFromVidLink(
  cfg: BackendConfig['source1'],
  query: SourceQuery,
): Promise<RawStreamCandidate[]> {
  const linkOrigin = cfg.vidlinkOrigin;
  const encOrigin = cfg.encDecOrigin;
  if (!linkOrigin || !encOrigin || isSubOriginCoolingDown(linkOrigin) || isSubOriginCoolingDown(encOrigin)) {
    return [];
  }

  try {
    const encSig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
    const encRes = await fetch(
      `${encOrigin}/api/enc-vidlink?text=${encodeURIComponent(query.tmdbId)}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
        signal: encSig,
      },
    );
    if (!encRes.ok) {
      if (encRes.status >= 500) tripSubOriginCooldown(encOrigin);
      return [];
    }
    const encJson = (await encRes.json()) as { result?: string };
    const encId = typeof encJson?.result === 'string' ? encJson.result.trim() : '';
    if (!encId) return [];

    const apiPath =
      query.type === 'movie'
        ? `/api/b/movie/${encodeURIComponent(encId)}?multiLang=0`
        : `/api/b/tv/${encodeURIComponent(encId)}/${query.season ?? 1}/${query.episode ?? 1}?multiLang=0`;

    const apiSig = query.signal ? AbortSignal.any([query.signal, AbortSignal.timeout(4800)]) : AbortSignal.timeout(4800);
    const res = await fetch(`${linkOrigin}${apiPath}`, {
        headers: {
          Accept: 'application/json',
          Referer: `${linkOrigin}/`,
          Origin: linkOrigin,
          'User-Agent': BROWSER_UA,
          // Request the browser DASH delivery lane. Without this, VidLink
          // returns requiresProxy MP4s that rate-limit non-browser relays.
          'X-Playback-Environment': 'webkit',
        },
        signal: apiSig,
    });
    if (!res.ok) {
      if (res.status >= 500) tripSubOriginCooldown(linkOrigin);
      return [];
    }

    const data = (await res.json()) as {
      stream?: {
        type?: 'hls' | 'file' | 'dash';
        playlist?: string;
        playlistHeaders?: Record<string, string>;
        headers?: Record<string, string>;
        qualities?: Record<string, { type?: string; url?: string; requiresProxy?: boolean }>;
        captions?: { url?: string; language?: string; label?: string }[];
      };
    };
    const stream = data?.stream;
    if (!stream) return [];

    const mediaHeaders: Record<string, string> = {
      Referer: `${linkOrigin}/`,
      Origin: linkOrigin,
      'User-Agent': BROWSER_UA,
      // DASH delivery uses CloudFront signed cookies. Preserve them on the
      // manifest and every rewritten child segment, exactly as provided.
      ...(stream.playlistHeaders ?? {}),
      ...(stream.headers ?? {}),
    };

    const subs = mapSubtitles(
      (stream.captions ?? []).map((c) => ({
        url: c.url,
        lang: c.language || c.label,
        label: c.label || c.language,
      })),
      mediaHeaders,
    );

    const out: RawStreamCandidate[] = [];
    if (typeof stream.playlist === 'string' && isSafeUpstreamUrl(stream.playlist)) {
      const playlistType = inferStreamType(stream.type, stream.playlist);
      out.push({
        key: `vlink:${playlistType}:${stream.playlist}`,
        type: playlistType,
        url: stream.playlist,
        headers: mediaHeaders,
        quality: 'auto',
        multiAudio: false,
        subtitles: subs,
        rank: 12,
      });
    }

    if (stream.qualities && typeof stream.qualities === 'object') {
      const rungs = Object.entries(stream.qualities)
        .map(([qKey, qObj]) => ({
          height: parseInt(qKey.replace(/\D+/g, ''), 10) || 0,
          url: String(qObj?.url ?? '').trim(),
          type: qObj?.type,
          requiresProxy: qObj?.requiresProxy === true,
        }))
        .filter((r) => r.url && !r.requiresProxy && isSafeUpstreamUrl(r.url))
        .sort((a, b) => b.height - a.height);

      if (rungs.length > 0) {
        const best = rungs[0];
        const fallbackRung = rungs[1];
        out.push({
          key: `vlink:mp4:${best.url}`,
          type: inferStreamType(best.type || 'mp4', best.url),
          url: best.url,
          headers: mediaHeaders,
          quality: best.height ? `${best.height}p` : 'auto',
          multiAudio: false,
          subtitles: subs,
          ...(fallbackRung ? { standbyUrl: fallbackRung.url, standbyHeaders: mediaHeaders } : {}),
          rank: 18,
        });
      }
    }

    return out;
  } catch {
    return [];
  }
}

async function fetchSkipSegments(
  cfg: BackendConfig['source1'],
  query: SourceQuery,
  refererPath: string,
): Promise<SkipSegments | undefined> {
  if (isSubOriginCoolingDown(cfg.appOrigin)) return undefined;
  try {
    // TMDB supplies the canonical IMDb id used by the metadata endpoint. It is
    // already resolving concurrently for the playback response, so await that
    // shared promise instead of issuing a duplicate metadata request.
    let imdbId = query.imdbId;
    if (!imdbId && query.resolveMetaFallback) {
      try {
        imdbId = (await query.resolveMetaFallback()).imdbId ?? undefined;
      } catch {
        // TMDB metadata is optional; the endpoint can still resolve by TMDB id.
      }
    }
    const res = await callServerFn<{
      intro?: { start?: number; end?: number } | null;
      outro?: { start?: number; end?: number } | null;
      recap?: { start?: number; end?: number } | null;
    }>({
      appOrigin: cfg.appOrigin,
      fnId: SKIP_SEGMENTS_FN_ID,
      method: 'GET',
      data: {
        type: query.type,
        tmdbId: String(query.tmdbId),
        imdbId: imdbId ?? null,
        ...(query.type === 'tv' ? { season: query.season ?? 1, episode: query.episode ?? 1 } : {}),
      },
      refererPath,
      timeoutMs: 2500,
      signal: query.signal,
    });
    if (!res) return undefined;

    const range = (r?: { start?: number; end?: number } | null): [number, number] | undefined => {
      const s = Number(r?.start);
      const e = Number(r?.end);
      return Number.isFinite(s) && Number.isFinite(e) && e > s && s >= 0 ? [s, e] : undefined;
    };

    const intro = range(res.intro);
    const outro = range(res.outro);
    const recap = range(res.recap);
    if (!intro && !outro && !recap) return undefined;
    return {
      ...(intro ? { intro } : {}),
      ...(outro ? { outro } : {}),
      ...(recap ? { recap } : {}),
    };
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Source 1 Adapter Factory                                            */
/* ------------------------------------------------------------------ */

export function createSource1Adapter(cfg: BackendConfig['source1']): SourceAdapter {
  return {
    id: 'source-1',
    label: 'Source 1',
    enabled: () => cfg.enabled,

    async resolveSegments(query: SourceQuery): Promise<SkipSegments | undefined> {
      const refererPath =
        query.type === 'movie'
          ? `/embed/movie/${encodeURIComponent(query.tmdbId)}`
          : `/embed/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;
      return fetchSkipSegments(cfg, query, refererPath);
    },

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      const apiPath =
        query.type === 'movie'
          ? `/api/m/${encodeURIComponent(query.tmdbId)}`
          : `/api/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;
      const refererPath =
        query.type === 'movie'
          ? `/embed/movie/${encodeURIComponent(query.tmdbId)}`
          : `/embed/tv/${encodeURIComponent(query.tmdbId)}/${query.season ?? 1}/${query.episode ?? 1}`;

      const t0 = performance.now();
      const timed = <T>(p: Promise<T>): Promise<{ val: T; ms: number }> =>
        p.then((val) => ({ val, ms: Math.max(1, Math.round(performance.now() - t0)) }));

      const slots: {
        secure: { val: Awaited<ReturnType<typeof fetchFromSecureFn>>; ms: number } | null;
        public: { val: Awaited<ReturnType<typeof fetchFromPublicApi>>; ms: number } | null;
        rift: { val: RawStreamCandidate[]; ms: number } | null;
        sync: { val: RawStreamCandidate[]; ms: number } | null;
        rock: { val: RawStreamCandidate[]; ms: number } | null;
        link: { val: RawStreamCandidate[]; ms: number } | null;
      } = {
        secure: null,
        public: null,
        rift: null,
        sync: null,
        rock: null,
        link: null,
      };

      const totalPipelines = 6;
      let settledCount = 0;
      let liveSourcePipelines = 0;
      let releaseEarly: (() => void) | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;

      const checkFastSettle = () => {
        if (settledCount >= totalPipelines) {
          releaseEarly?.();
          return;
        }
        // Wait until VidSync (24-dub multi-language engine) + at least one companion
        // live pipeline have produced candidates before starting the fast grace window.
        if (liveSourcePipelines >= 2 && slots.sync && !graceTimer) {
          graceTimer = setTimeout(() => releaseEarly?.(), 360);
        }
      };

      const pSecure = timed(fetchFromSecureFn(cfg, apiPath, refererPath, query.signal)).then((r) => {
        slots.secure = r;
        settledCount++;
        if (r.val?.links?.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const pPublic = timed(fetchFromPublicApi(cfg, apiPath, query.signal)).then((r) => {
        slots.public = r;
        settledCount++;
        if (r.val?.links?.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const pRift = timed(fetchFromRiftBoot(cfg, query)).then((r) => {
        slots.rift = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const pSync = timed(fetchFromVidSync(cfg, query)).then((r) => {
        slots.sync = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const pRock = timed(fetchFromVidRock(cfg, query)).then((r) => {
        slots.rock = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      });
      const pLink = timed(fetchFromVidLink(cfg, query)).then((r) => {
        slots.link = r;
        settledCount++;
        if (r.val.length) liveSourcePipelines++;
        checkFastSettle();
      });
      await Promise.race([
        Promise.allSettled([pSecure, pPublic, pRift, pSync, pRock, pLink]),
        new Promise<void>((r) => {
          releaseEarly = r;
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);

      // Do NOT stamp upstream JSON-scraper RPC duration onto `latencyMs`: leave `latencyMs`
      // unset unless known so `liveness.ts` populates the true measured CDN manifest RTT!
      const withTiming = (list: RawStreamCandidate[], ms: number): RawStreamCandidate[] =>
        list.map((c) => ({
          ...c,
          fingerprint: c.fingerprint || c.key,
          ...(c.latencyMs !== undefined ? { latencyMs: c.latencyMs } : {}),
          rank: c.rank + Math.min(ms, 5000) / 1000,
        }));

      const secureCandidates = slots.secure?.val?.links
        ? withTiming(mapApiLinksToCandidates(slots.secure.val.links, `${cfg.appOrigin}/`, 1), slots.secure.ms)
        : [];
      const publicCandidates = slots.public?.val?.links
        ? withTiming(mapApiLinksToCandidates(slots.public.val.links, `${cfg.apiOrigin}/`, 10), slots.public.ms)
        : [];
      const riftCandidates = slots.rift ? withTiming(slots.rift.val, slots.rift.ms) : [];
      const syncCandidates = slots.sync ? withTiming(slots.sync.val, slots.sync.ms) : [];
      const rockCandidates = slots.rock ? withTiming(slots.rock.val, slots.rock.ms) : [];
      const linkCandidates = slots.link ? withTiming(slots.link.val, slots.link.ms) : [];

      const byUrl = new Map<string, RawStreamCandidate>();
      for (const c of [
        ...secureCandidates,
        ...syncCandidates,
        ...rockCandidates,
        ...linkCandidates,
        ...riftCandidates,
        ...publicCandidates,
      ]) {
        const existing = byUrl.get(c.key);
        if (!existing) {
          byUrl.set(c.key, c);
        } else {
          if (c.latencyMs !== undefined && (existing.latencyMs === undefined || c.latencyMs < existing.latencyMs)) {
            existing.latencyMs = c.latencyMs;
          }
          if (c.subtitles?.length) {
            const mergedSubs = [...(existing.subtitles ?? [])];
            for (const sub of c.subtitles) {
              if (!mergedSubs.some((x) => x.lang === sub.lang && x.url === sub.url)) mergedSubs.push(sub);
            }
            existing.subtitles = mergedSubs;
          }
        }
      }

      const pooledSubs: RawTrackRef[] = [];
      const seenSubKey = new Set<string>();
      for (const c of byUrl.values()) {
        for (const sub of c.subtitles ?? []) {
          const sk = `${sub.lang}:${sub.url}`;
          if (!seenSubKey.has(sk)) {
            seenSubKey.add(sk);
            pooledSubs.push(sub);
          }
        }
      }
      if (pooledSubs.length) {
        for (const c of byUrl.values()) {
          if (!c.subtitles || c.subtitles.length === 0) {
            c.subtitles = pooledSubs;
          }
        }
      }

      const prefCode = query.preferredLang ? normalizeLang(query.preferredLang).code : '';
      const prefPrimary = prefCode && prefCode !== 'und' ? prefCode.split('-')[0] : '';
      const candidates = [...byUrl.values()].sort((a, b) => {
        if (prefPrimary) {
          const score = (c: RawStreamCandidate) => {
            if (c.audioLang === prefCode || c.availableAudioLangs?.includes(prefCode)) return 0;
            if (
              c.audioLang?.split('-')[0] === prefPrimary ||
              c.availableAudioLangs?.some((l) => l.split('-')[0] === prefPrimary)
            ) {
              return 1;
            }
            if (c.multiAudio && !c.availableAudioLangs?.length) return 2;
            return 3;
          };
          const diff = score(a) - score(b);
          if (diff !== 0) return diff;
        } else {
          if (!!a.multiAudio !== !!b.multiAudio) return a.multiAudio ? -1 : 1;
        }
        return a.rank - b.rank;
      });

      const metaSource = slots.secure?.val ?? slots.public?.val;
      const metaHint = metaSource
        ? {
            title: metaSource.title ? String(metaSource.title) : undefined,
            year: metaSource.year ? String(metaSource.year) : undefined,
            imdbId: metaSource.imdb_id ?? null,
          }
        : undefined;

      return {
        candidates,
        ...(metaHint ? { metaHint } : {}),
      };
    },
  };
}
