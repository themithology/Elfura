/**
 * Elfura Backend — Uniform Stream Ingress / Egress Relay
 * ======================================================
 * Handles `GET /api/v1/stream?t=<encryptedTicket>`:
 *   - Decrypts upstream URL + required headers (Referer, Origin, UA, Cookie).
 *   - Enforces SSRF protection on both initial and post-redirect URLs.
 *   - Normalizes `#EXT-X-MEDIA` ISO 639-2 language codes (`hin`->`hi`, `jpn`->`ja`,
 *     `kan`->`kn`, etc.), strips upstream release-group watermarks (`MovieHubBD`),
 *     disambiguates duplicate subtitle labels (`English #2`), and ensures each
 *     audio group has a `DEFAULT=YES` track for `hls.js` + Safari native HLS.
 *   - Rewrites every URI inside HLS (.m3u8) and DASH (.mpd) manifests into
 *     fresh encrypted `/api/v1/stream?t=...` tickets so raw CDN hosts never leak.
 *   - Pipes binary media segments, MP4 byte-ranges, external audio, and
 *     subtitles directly through memory backpressure with zero disk writes.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { StreamTicketPayload } from './security.js';
import {
  applyCorsHeaders,
  isSafeUpstreamUrl,
  openStreamTicket,
  sealStreamTicket,
  setCloudflareCache,
} from './security.js';
import { normalizeLang } from './sources/lang.js';

const DEFAULT_RELAY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MiB safety ceiling for text manifests

const UPSTREAM_TRACK_WATERMARK_RE =
  /moviehub|tgflix|tgvid|tghub|tgkai|aetho|vidbolt|rousav|hakuna|hscow|fcxmb|orion|vidrift|vidsync|nxsha|nxstream|itsnitrox|vidbox|vidlink|vidrock|vercetti|vidstuck|hguider|sply|^(?:audio|track\s*\d*|sound|stream)$/i;

const HEVC_HINT_RE = /(?:^|[_/.-])(?:h265|hevc|x265)(?:[_/.-]|$)/i;

const WEBVTT_SPAM_CUE_RE =
  /(?:www\.|https?:\/\/|\b[a-z0-9-]+\.(?:com|net|org|world|xyz|pro|in|io|to|gg|cc|space|tech)\b|watch\s+movies|hollymovie|opensubtitles|subscene|yts\.|yify|aethoembed|aethoflix|vidbolt|vidrift|vidsync|vidlink|vidrock|vidstuck|nxsha|nxstream|tgflix|tgvid|moviehub|bottom\s+control\s+bar|press\s+space\s+or\s+k|multi-audio\s+stream\s+connected)/i;

/* ------------------------------------------------------------------ */
/* Hybrid Segment Offload — Anonymity & Browser-CORS Verifier          */
/* ------------------------------------------------------------------ */

const SOURCE_HOST_DENY_RE =
  /(?:tgvid|tgflix|tghub|tgkai|lovable\.app|vercel\.app|netlify\.app|pages\.dev|workers\.dev|vidrift|vidsync|vidzee|vidbolt|vidfast|vaplayer|vidsrc|vidstuck|vidlink|vidrock|vidbox|nxsha|nxstream|itsnitrox|vercetti|enc-dec|0vidads|zxc|freekz|aetho|rousav|moviehub|mhbdtv|hlowb|fastcloud|husvu|\bproxy\b|\brelay\b|\bbridge\b)/i;

const SOURCE_PATH_DENY_RE =
  /(?:^\/(?:api|backend|_serverFn)\b|\/(?:orion|tgkai|vidbolt|rousav|aetho|vidsync|vidrift|vidlink|vidrock|vidstuck|nxsha|proxy|relay)\b)/i;

const SOURCE_QUERY_DENY_RE =
  /(?:^|[?&])(?:api_?key|access_?token|auth_?token|secret|pltoken)=/i;

const IP_BOUND_TOKEN_RE = /:\d{1,3}(?:\.\d{1,3}){3}:/;

const CORS_PROBE_ORIGIN = 'https://player.elfura.invalid';
const MAX_CORS_CACHE_ENTRIES = 512;
const CORS_PASS_TTL_MS = 30 * 60_000;
const CORS_FAIL_TTL_MS = 10 * 60_000;

const segmentCorsCache = new Map<string, { allow: boolean; expiresAt: number }>();
const segmentCorsInFlight = new Map<string, Promise<boolean>>();

/**
 * Returns true ONLY if `rawUrl` points to a generic, provider-anonymous edge CDN
 * with zero aggregator/source/worker names, zero API keys, and safe protocol.
 */
export function isAnonymousSegmentUrl(rawUrl: string, requireHttps = true): boolean {
  if (!isSafeUpstreamUrl(rawUrl)) return false;
  if (IP_BOUND_TOKEN_RE.test(rawUrl)) return false;

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }

  const allowTestHttp =
    process.env.NODE_ENV === 'test' && process.env.ELFURA_ALLOW_HTTP_OFFLOAD_TEST === '1';
  if (requireHttps && !allowTestHttp && u.protocol !== 'https:') {
    return false;
  }
  if (u.username || u.password) return false;
  if (SOURCE_HOST_DENY_RE.test(u.hostname)) return false;
  if (SOURCE_PATH_DENY_RE.test(u.pathname)) return false;
  if (SOURCE_QUERY_DENY_RE.test(u.search)) return false;

  let decodedSearch = '';
  try {
    decodedSearch = decodeURIComponent(u.search);
  } catch {
    decodedSearch = u.search;
  }
  if (SOURCE_HOST_DENY_RE.test(decodedSearch)) return false;

  return true;
}

function hasSessionBoundAuthHeaders(headers?: Record<string, string>): boolean {
  if (!headers) return false;
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'cookie' || lower === 'authorization' || lower === 'x-playback-token') {
      return true;
    }
  }
  return false;
}

function segmentOriginBucketKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const firstSeg = u.pathname.split('/').filter(Boolean)[0] || '';
    return `${u.origin.toLowerCase()}/${firstSeg}`;
  } catch {
    return rawUrl;
  }
}

/**
 * Simulates a real browser MSE simple-GET (with `Origin`, zero `Referer`, zero
 * custom headers) once per CDN bucket and caches the verdict in bounded RAM.
 */
export async function verifyDirectSegmentOffload(
  sampleUrl: string,
  requireHttps = true,
): Promise<boolean> {
  if (!isAnonymousSegmentUrl(sampleUrl, requireHttps)) return false;

  const key = `${requireHttps ? 's' : 'i'}:${segmentOriginBucketKey(sampleUrl)}`;
  const cached = segmentCorsCache.get(key);
  if (cached) {
    if (Date.now() <= cached.expiresAt) {
      segmentCorsCache.delete(key);
      segmentCorsCache.set(key, cached);
      return cached.allow;
    }
    segmentCorsCache.delete(key);
  }

  const inflight = segmentCorsInFlight.get(key);
  if (inflight) return inflight;

  const probePromise = (async (): Promise<boolean> => {
    try {
      const res = await fetch(sampleUrl, {
        method: 'GET',
        headers: {
          Origin: CORS_PROBE_ORIGIN,
          'User-Agent': DEFAULT_RELAY_UA,
          Accept: '*/*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(1500),
      });
      const finalUrl = res.url || sampleUrl;
      const acao = (res.headers.get('access-control-allow-origin') || '').trim();
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }

      const statusOk = res.status === 200 || res.status === 206;
      // A CDN that merely echoes CORS_PROBE_ORIGIN has only authorized our fake
      // probe, not the viewer's real embed origin. Offload exclusively on a
      // wildcard; reflected/specific origins must remain on the backend relay.
      const corsOk = acao === '*';
      const bodyOk =
        !ct.includes('text/html') &&
        !ct.includes('application/xhtml') &&
        !ct.includes('application/json');
      const anonOk = isAnonymousSegmentUrl(finalUrl, requireHttps);

      const allow = statusOk && corsOk && bodyOk && anonOk;
      if (segmentCorsCache.has(key)) segmentCorsCache.delete(key);
      while (segmentCorsCache.size >= MAX_CORS_CACHE_ENTRIES) {
        const oldest = segmentCorsCache.keys().next().value;
        if (oldest === undefined) break;
        segmentCorsCache.delete(oldest);
      }
      segmentCorsCache.set(key, {
        allow,
        expiresAt: Date.now() + (allow ? CORS_PASS_TTL_MS : CORS_FAIL_TTL_MS),
      });
      return allow;
    } catch {
      return false;
    }
  })();

  segmentCorsInFlight.set(key, probePromise);
  try {
    return await probePromise;
  } finally {
    segmentCorsInFlight.delete(key);
  }
}

export function sanitizeWebVtt(vttText: string): string {
  const withoutBom = vttText.replace(/^\uFEFF/, '');
  if (!/^WEBVTT\b/i.test(withoutBom.trimStart())) return vttText;

  const blocks = withoutBom.split(/\r?\n\r?\n+/);
  const kept: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (i === 0) {
      kept.push(block);
      continue;
    }
    const lines = block.split(/\r?\n/);
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) {
      kept.push(block);
      continue;
    }
    const cuePayload = lines.slice(timingIdx + 1).join(' ');
    if (WEBVTT_SPAM_CUE_RE.test(cuePayload)) {
      continue;
    }
    kept.push(block);
  }

  return `${kept.join('\n\n')}\n`;
}

export function sanitizeSubRip(srtText: string): string {
  const withoutBom = srtText.replace(/^\uFEFF/, '');
  if (!withoutBom.includes('-->')) return srtText;

  const blocks = withoutBom.split(/\r?\n\r?\n+/);
  const kept: string[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) {
      if (block.trim()) kept.push(block);
      continue;
    }
    const cuePayload = lines.slice(timingIdx + 1).join(' ');
    if (WEBVTT_SPAM_CUE_RE.test(cuePayload)) {
      continue;
    }
    kept.push(block);
  }

  return `${kept.join('\n\n')}\n`;
}

/**
 * Some live HLS producers escape underscores and slashes in playlist URIs
 * (for example `hls\_mps`). WHATWG URL parsing treats a backslash in an HTTP
 * path as a slash, producing a different, nonexistent CDN key. Normalize the
 * producer's escapes before resolving or sealing every child reference.
 */
export function normalizeManifestUriReference(rawRef: string): string {
  return rawRef.trim().replace(/\\([/_])/g, '$1');
}

function inferChildKind(tagLine: string, resolvedUrl: string, expectVariantPlaylist: boolean): 'm' | 's' | 'a' | 'k' {
  if (expectVariantPlaylist) return 'm';
  if (/^#EXT-X-KEY:/i.test(tagLine)) return 'k';
  if (/^#EXT-X-I-FRAME-STREAM-INF/i.test(tagLine)) return 'm';
  if (/^#EXT-X-MEDIA:/i.test(tagLine)) {
    if (/TYPE=SUBTITLES/i.test(tagLine) && /\.(?:vtt|srt|ass|ssa)(?:[?#]|$)/i.test(resolvedUrl)) return 's';
    return 'm';
  }
  if (/\.m3u8(?:[?#]|$)/i.test(resolvedUrl) || /[?&](?:m=1|p=)(?:&|$|[^&])/.test(resolvedUrl)) {
    // Note: TGKAI uses `?p=%2Fhls%2F...` for sub-playlists and `?s=...` for segments
    if (!/[?&]s=/.test(resolvedUrl)) return 'm';
  }
  if (/\.(?:vtt|srt|ass|ssa)(?:[?#]|$)/i.test(resolvedUrl)) return 's';
  return 'a';
}

export function extractManifestAudioLangs(manifestText: string): string[] {
  const out: string[] = [];
  for (const rawLine of manifestText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!/^#EXT-X-MEDIA:/i.test(trimmed) || !/TYPE=AUDIO\b/i.test(trimmed)) continue;
    const langMatch = trimmed.match(/LANGUAGE=(?:"([^"]+)"|([^,\s]+))/i);
    const rawLang = (langMatch?.[1] ?? langMatch?.[2] ?? '')
      .trim()
      .replace(/[.\-_]*\[[^\]]*\]/g, '');
    const nameMatch = trimmed.match(/NAME="([^"]*)"/i);
    const rawName = (nameMatch?.[1] ?? '').trim();
    const unnumberedName = rawName.replace(/^\d+\s*[.)\-:]\s*/, '').trim();
    const norm = normalizeLang(rawLang || unnumberedName, unnumberedName);
    if (norm.code && norm.code !== 'und' && !out.includes(norm.code)) {
      out.push(norm.code);
    }
  }
  return out;
}

function sanitizeExtXMediaLines(lines: string[], hintAudioLang?: string): string[] {
  // First pass: check which AUDIO GROUP-IDs already have a DEFAULT=YES track + count total AUDIO renditions
  const audioGroupHasDefault = new Map<string, boolean>();
  let totalAudioTracks = 0;
  for (const rawLine of lines) {
    const t = rawLine.trim();
    if (!/^#EXT-X-MEDIA:/i.test(t) || !/TYPE=AUDIO\b/i.test(t)) continue;
    totalAudioTracks++;
    const gMatch = t.match(/GROUP-ID="([^"]+)"/i);
    const gid = gMatch?.[1] ?? 'default';
    if (!audioGroupHasDefault.has(gid)) audioGroupHasDefault.set(gid, false);
    if (/DEFAULT=YES\b/i.test(t)) audioGroupHasDefault.set(gid, true);
  }

  const singleTrackHint =
    totalAudioTracks === 1 && hintAudioLang && hintAudioLang !== 'und'
      ? normalizeLang(hintAudioLang)
      : null;

  const labelCounts = new Map<string, number>();
  const promotedGroups = new Set<string>();

  return lines.map((line) => {
    const trimmed = line.trim();
    if (!/^#EXT-X-MEDIA:/i.test(trimmed)) return line;
    const isAudio = /TYPE=AUDIO\b/i.test(trimmed);
    const isSubs = /TYPE=SUBTITLES\b/i.test(trimmed);
    if (!isAudio && !isSubs) return line;

    const groupMatch = trimmed.match(/GROUP-ID="([^"]+)"/i);
    const groupId = groupMatch?.[1] ?? 'default';
    const langMatch = trimmed.match(/LANGUAGE=(?:"([^"]+)"|([^,\s]+))/i);
    const rawLang = (langMatch?.[1] ?? langMatch?.[2] ?? '')
      .trim()
      .replace(/[.\-_]*\[[^\]]*\]/g, '');
    const nameMatch = trimmed.match(/NAME="([^"]*)"/i);
    const rawName = (nameMatch?.[1] ?? '').trim();
    const unnumberedName = rawName.replace(/^\d+\s*[.)\-:]\s*/, '').trim();

    let norm = normalizeLang(rawLang || unnumberedName, unnumberedName);
    if (isAudio && norm.code === 'und' && singleTrackHint && singleTrackHint.code !== 'und') {
      norm = singleTrackHint;
    }

    // Preserve meaningful subtitle qualifiers like Forced / SDH / CC
    let qualifier = '';
    if (/\bforced\b/i.test(rawName) || /FORCED=YES\b/i.test(trimmed)) qualifier = ' (Forced)';
    else if (/\bsdh\b|\bcc\b|\[cc\]/i.test(rawName)) qualifier = ' (SDH)';

    const baseCleanName =
      norm.code !== 'und'
        ? `${norm.label}${qualifier}`
        : unnumberedName && !UPSTREAM_TRACK_WATERMARK_RE.test(unnumberedName)
          ? unnumberedName
          : isAudio
            ? 'Original'
            : 'Subtitles';

    const countKey = `${isAudio ? 'A' : 'S'}:${groupId}:${baseCleanName.toLowerCase()}`;
    const nextIdx = (labelCounts.get(countKey) ?? 0) + 1;
    labelCounts.set(countKey, nextIdx);
    const finalName = nextIdx > 1 ? `${baseCleanName} #${nextIdx}` : baseCleanName;

    let updated = trimmed;

    // Normalize LANGUAGE attribute to quoted canonical code (e.g. LANGUAGE=hin -> LANGUAGE="hi")
    if (norm.code && norm.code !== 'und') {
      if (langMatch) {
        updated = updated.replace(/LANGUAGE=(?:"[^"]*"|[^,\s]+)/i, `LANGUAGE="${norm.code}"`);
      } else {
        updated += `,LANGUAGE="${norm.code}"`;
      }
    }

    // Replace watermark / inconsistent NAME with clean standardized label
    const safeName = finalName.replace(/"/g, '');
    if (nameMatch) {
      updated = updated.replace(/NAME="[^"]*"/i, `NAME="${safeName}"`);
    } else {
      updated += `,NAME="${safeName}"`;
    }

    // Ensure every AUDIO group has at least one DEFAULT=YES track (fixes TGKAI all-DEFAULT=NO)
    if (isAudio && !audioGroupHasDefault.get(groupId) && !promotedGroups.has(groupId)) {
      promotedGroups.add(groupId);
      if (/DEFAULT=NO\b/i.test(updated)) {
        updated = updated.replace(/DEFAULT=NO\b/i, 'DEFAULT=YES');
      } else if (!/DEFAULT=/i.test(updated)) {
        updated += ',DEFAULT=YES';
      }
    }

    return updated;
  });
}

/** Preserve this CDN's manifest access parameter only on same-origin children. */
export function resolveHlsChildUrl(rawRef: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const child = new URL(normalizeManifestUriReference(rawRef), base);
  if (child.origin === base.origin && /(?:^|\.)(?:rousav\.tech|animecurx\.tech)$/i.test(base.hostname)) {
    const key = base.searchParams.get('api_key') || base.searchParams.get('apikey');
    if (key && !child.searchParams.has('api_key') && !child.searchParams.has('apikey')) child.searchParams.set('api_key', key);
  }
  return child.toString();
}

export interface RewriteManifestOptions {
  /** Force 100% backend segment relay and propagate `fp: 1` to child manifests. */
  forceProxy?: boolean;
  /** Optional predicate returning true when a binary segment (`kind === 'a'`) may be served direct. */
  canOffloadSegment?: (absUrl: string) => boolean;
}

export function rewriteHlsManifest(
  manifestText: string,
  baseUrl: string,
  headers: Record<string, string> | undefined,
  secret: Buffer,
  streamPath = '/api/v1/stream',
  hintAudioLang?: string,
  options?: RewriteManifestOptions,
): string {
  const isBaseHevc = (() => {
    if (HEVC_HINT_RE.test(baseUrl)) return true;
    try {
      const inner = new URL(baseUrl).searchParams.get('url') || '';
      return HEVC_HINT_RE.test(inner);
    } catch {
      return false;
    }
  })();

  const wrapUrl = (rawRef: string, kind: 'm' | 's' | 'a' | 'k'): string => {
    const trimmed = normalizeManifestUriReference(rawRef);
    if (!trimmed || trimmed.startsWith('data:')) return rawRef;
    let abs: string;
    try {
      abs = resolveHlsChildUrl(trimmed, baseUrl);
    } catch {
      return rawRef;
    }
    if (!isSafeUpstreamUrl(abs)) return '';
    if (kind === 'a' && !options?.forceProxy && options?.canOffloadSegment?.(abs)) {
      return abs;
    }
    const ticket = sealStreamTicket(secret, {
      u: abs,
      ...(headers && Object.keys(headers).length ? { h: headers } : {}),
      k: kind,
      ...(options?.forceProxy && kind === 'm' ? { fp: 1 } : {}),
    });
    return `${streamPath}?t=${encodeURIComponent(ticket)}`;
  };

  // Deduplicate repeated leading #EXTM3U lines (observed on TGKAI anime playlists)
  const rawLines = manifestText.split(/\r?\n/);
  const dedupedHeaderLines: string[] = [];
  let seenExtM3u = false;
  for (const l of rawLines) {
    if (l.trim().toUpperCase() === '#EXTM3U') {
      if (seenExtM3u) continue;
      seenExtM3u = true;
    }
    dedupedHeaderLines.push(l);
  }

  const lines = sanitizeExtXMediaLines(dedupedHeaderLines, hintAudioLang);
  let expectVariantUri = false;

  const rewritten = lines.map((line, lineIdx) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      const isStreamInf = /^#EXT-X-STREAM-INF\b/i.test(trimmed);
      let workingLine = line;
      if (isStreamInf) {
        expectVariantUri = true;
        if (!/\bCODECS=/i.test(trimmed)) {
          const nextNonEmpty = lines.slice(lineIdx + 1).find((n) => n.trim() && !n.trim().startsWith('#')) || '';
          let nextHevc = isBaseHevc || HEVC_HINT_RE.test(nextNonEmpty);
          if (!nextHevc && nextNonEmpty) {
            try {
              const nu = new URL(nextNonEmpty.trim(), baseUrl);
              nextHevc = HEVC_HINT_RE.test(nu.searchParams.get('url') || '');
            } catch {
              /* ignore */
            }
          }
          if (nextHevc) {
            workingLine = `${trimmed},CODECS="hvc1.1.6.L120.90,mp4a.40.2"`;
          }
        }
      }

      if (!workingLine.includes('URI="')) return workingLine;
      return workingLine.replace(/URI="([^"]+)"/gi, (_full, uriVal: string) => {
        let abs = uriVal;
        try {
          abs = new URL(uriVal, baseUrl).toString();
        } catch {
          /* keep raw */
        }
        const kind = inferChildKind(workingLine, abs, false);
        const proxied = wrapUrl(uriVal, kind);
        return proxied ? `URI="${proxied}"` : 'URI=""';
      });
    }

    let abs = trimmed;
    try {
      abs = new URL(trimmed, baseUrl).toString();
    } catch {
      /* ignore */
    }
    const kind = inferChildKind('', abs, expectVariantUri);
    expectVariantUri = false;
    return wrapUrl(trimmed, kind);
  });

  return rewritten.join('\n');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function xmlAttributeEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

const DASH_TEMPLATE_PARAMS = [
  { name: 'RepresentationID', param: '_dr', pattern: /\$RepresentationID\$/g, placeholder: /\$RepresentationID\$/ },
  { name: 'Number', param: '_dn', pattern: /\$Number(?:%0\d+d)?\$/g, placeholder: /\$Number(?:%0\d+d)?\$/ },
  { name: 'Time', param: '_dt', pattern: /\$Time\$/g, placeholder: /\$Time\$/ },
  { name: 'Bandwidth', param: '_db', pattern: /\$Bandwidth\$/g, placeholder: /\$Bandwidth\$/ },
] as const;

/** Keep DASH substitutions visible to dash.js while the upstream template stays encrypted. */
function sealDashTemplateUrl(
  rawTemplate: string,
  baseUrl: string,
  headers: Record<string, string> | undefined,
  secret: Buffer,
  streamPath: string,
): string {
  const abs = new URL(xmlUnescape(rawTemplate), baseUrl).toString();
  if (!isSafeUpstreamUrl(abs)) throw new Error('unsafe DASH template');
  const ticket = sealStreamTicket(secret, {
    u: abs,
    ...(headers && Object.keys(headers).length ? { h: headers } : {}),
    k: 'a',
  });
  const params = [`t=${encodeURIComponent(ticket)}`];
  for (const token of DASH_TEMPLATE_PARAMS) {
    token.placeholder.lastIndex = 0;
    if (token.placeholder.test(abs)) {
      token.pattern.lastIndex = 0;
      const match = abs.match(token.pattern)?.[0] || `$${token.name}$`;
      params.push(`${token.param}=${match}`);
    }
  }
  return `${streamPath}?${params.join('&')}`;
}

/** Apply dash.js substitutions to the sealed upstream template at request time. */
export function materializeDashTicket(
  ticket: StreamTicketPayload,
  params: URLSearchParams,
): StreamTicketPayload | null {
  let resolved = ticket.u;
  for (const token of DASH_TEMPLATE_PARAMS) {
    token.pattern.lastIndex = 0;
    if (!token.pattern.test(resolved)) continue;
    const value = params.get(token.param);
    if (value === null || value.length > 160) return null;
    const valid = token.name === 'RepresentationID' ? /^[A-Za-z0-9_.-]+$/ : /^\d+$/.test(value);
    if (!valid) return null;
    token.pattern.lastIndex = 0;
    resolved = resolved.replace(token.pattern, () => value);
  }
  if (/\$(?:RepresentationID|Number(?:%0\d+d)?|Time|Bandwidth)\$/.test(resolved)) return null;
  return resolved === ticket.u ? ticket : { ...ticket, u: resolved };
}

export function rewriteDashManifest(
  mpdText: string,
  baseUrl: string,
  headers: Record<string, string> | undefined,
  secret: Buffer,
  streamPath = '/api/v1/stream',
  options?: RewriteManifestOptions,
): string {
  type Frame = { tag: string; base: string; hasBase: boolean };
  const frames: Frame[] = [{ tag: '', base: baseUrl, hasBase: false }];
  const scopedTags = new Set(['MPD', 'Period', 'AdaptationSet', 'Representation']);
  const tokenPattern = /<!--[\s\S]*?-->|<BaseURL\b[^>]*>[\s\S]*?<\/BaseURL\s*>|<\/?[A-Za-z_][^>]*>/g;

  const staticUrl = (raw: string, base: string): string => {
    const abs = new URL(xmlUnescape(raw), base).toString();
    if (!isSafeUpstreamUrl(abs)) throw new Error('unsafe DASH URL');
    if (!options?.forceProxy && options?.canOffloadSegment?.(abs)) return abs;
    const ticket = sealStreamTicket(secret, {
      u: abs,
      ...(headers && Object.keys(headers).length ? { h: headers } : {}),
      k: 'a',
    });
    return `${streamPath}?t=${encodeURIComponent(ticket)}`;
  };

  return mpdText.replace(tokenPattern, (token) => {
    if (token.startsWith('<!--')) return token;
    const frame = frames[frames.length - 1];

    const baseMatch = token.match(/^<BaseURL\b[^>]*>([\s\S]*?)<\/BaseURL\s*>$/i);
    if (baseMatch) {
      const raw = baseMatch[1].trim();
      if (!raw) return token;
      const parentBase = frame.base;
      try {
        const abs = new URL(xmlUnescape(raw), parentBase).toString();
        const rewritten = token.replace(baseMatch[1], staticUrl(raw, parentBase));
        if (!frame.hasBase) {
          frame.base = abs;
          frame.hasBase = true;
        }
        return rewritten;
      } catch {
        return token;
      }
    }

    const closeMatch = token.match(/^<\/\s*([A-Za-z_][\w:.-]*)\s*>$/);
    if (closeMatch) {
      if (scopedTags.has(closeMatch[1]) && frames.length > 1 && frame.tag === closeMatch[1]) frames.pop();
      return token;
    }

    const openMatch = token.match(/^<\s*([A-Za-z_][\w:.-]*)\b[^>]*>$/);
    if (!openMatch) return token;
    const tag = openMatch[1];
    let rewritten = token;
    const rewriteAttributes = (attrs: string[], dynamic: boolean) => {
      for (const attr of attrs) {
        const attrPattern = new RegExp(`(\\s${attr}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`, 'i');
        rewritten = rewritten.replace(attrPattern, (whole, prefix: string, quote: string, raw: string) => {
          try {
            const value = dynamic
              ? sealDashTemplateUrl(raw, frame.base, headers, secret, streamPath)
              : staticUrl(raw, frame.base);
            return `${prefix}${quote}${xmlAttributeEscape(value)}${quote}`;
          } catch {
            return whole;
          }
        });
      }
    };

    if (tag === 'SegmentTemplate') rewriteAttributes(['media', 'initialization'], true);
    else if (tag === 'SegmentURL') rewriteAttributes(['media'], false);
    else if (tag === 'Initialization') rewriteAttributes(['source'], false);

    if (scopedTags.has(tag) && !/\/>$/.test(token)) {
      frames.push({ tag, base: frame.base, hasBase: false });
    }
    return rewritten;
  });
}

function collectSampleSegmentUrls(kind: 'hls' | 'dash', bodyText: string, baseUrl: string): Map<string, string> {
  const samplesByBucket = new Map<string, string>();
  const consider = (rawRef: string) => {
    const trimmed = normalizeManifestUriReference(rawRef);
    if (!trimmed || trimmed.startsWith('data:')) return;
    let abs: string;
    try {
      abs = new URL(trimmed, baseUrl).toString();
    } catch {
      return;
    }
    const bucket = segmentOriginBucketKey(abs);
    if (!samplesByBucket.has(bucket)) {
      samplesByBucket.set(bucket, abs);
    }
  };

  if (kind === 'dash') {
    const re = /<BaseURL>([^<]+)<\/BaseURL>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bodyText)) !== null) {
      consider(m[1]);
      if (samplesByBucket.size >= 4) break;
    }
    return samplesByBucket;
  }

  const lines = bodyText.split(/\r?\n/);
  let expectVariant = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF\b/i.test(t)) {
        expectVariant = true;
        continue;
      }
      if (/^#EXT-X-MAP:/i.test(t) && t.includes('URI="')) {
        const uriMatch = t.match(/URI="([^"]+)"/i)?.[1];
        if (uriMatch) consider(uriMatch);
      }
      continue;
    }
    let abs = t;
    try {
      abs = new URL(t, baseUrl).toString();
    } catch {
      /* ignore */
    }
    const childKind = inferChildKind('', abs, expectVariant);
    expectVariant = false;
    if (childKind === 'a') {
      consider(t);
      if (samplesByBucket.size >= 4) break;
    }
  }
  return samplesByBucket;
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('manifest exceeded safety limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const MAX_MANIFEST_RAM_ENTRIES = 256;
const MAX_CACHEABLE_MANIFEST_BYTES = 262_144;
const MANIFEST_RAM_TTL_MS = 180_000;

interface CachedUpstreamManifest {
  expiresAt: number;
  finalUrl: string;
  kind: 'hls' | 'dash';
  bodyText: string;
}

const manifestRamCache = new Map<string, CachedUpstreamManifest>();

function getCachedManifest(key: string): CachedUpstreamManifest | null {
  const hit = manifestRamCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    manifestRamCache.delete(key);
    return null;
  }
  manifestRamCache.delete(key);
  manifestRamCache.set(key, hit);
  return hit;
}

function setCachedManifest(key: string, entry: Omit<CachedUpstreamManifest, 'expiresAt'>): void {
  if (entry.bodyText.length > MAX_CACHEABLE_MANIFEST_BYTES) return;
  if (manifestRamCache.has(key)) manifestRamCache.delete(key);
  while (manifestRamCache.size >= MAX_MANIFEST_RAM_ENTRIES) {
    const oldest = manifestRamCache.keys().next().value;
    if (oldest === undefined) break;
    manifestRamCache.delete(oldest);
  }
  manifestRamCache.set(key, {
    ...entry,
    expiresAt: Date.now() + MANIFEST_RAM_TTL_MS,
  });
}

export function buildManifestCacheKey(url: string, headers?: Record<string, string>): string {
  return `${url}|${JSON.stringify(headers ?? {})}`;
}

export function seedManifestRamCache(
  url: string,
  headers: Record<string, string> | undefined,
  entry: Omit<CachedUpstreamManifest, 'expiresAt'>,
): void {
  setCachedManifest(buildManifestCacheKey(url, headers), entry);
}

async function sendRewrittenManifest(
  res: ServerResponse,
  kind: 'hls' | 'dash',
  bodyText: string,
  finalUrl: string,
  ticketHeaders: Record<string, string> | undefined,
  secret: Buffer,
  streamPath: string,
  hintAudioLang: string | undefined,
  relayOpts: {
    relayMode: 'hybrid' | 'full';
    forceProxy: boolean;
    requireHttpsOffload: boolean;
  },
): Promise<void> {
  const allowedBuckets = new Set<string>();
  if (
    relayOpts.relayMode === 'hybrid' &&
    !relayOpts.forceProxy &&
    !hasSessionBoundAuthHeaders(ticketHeaders)
  ) {
    const samples = collectSampleSegmentUrls(kind, bodyText, finalUrl);
    if (samples.size > 0) {
      await Promise.all(
        [...samples.entries()].map(async ([bucket, sampleUrl]) => {
          // Never stall initial manifest delivery waiting >260ms on a cold CORS preflight;
          // if the CDN takes longer, let the probe finish into RAM cache in the background!
          const ok = await Promise.race([
            verifyDirectSegmentOffload(sampleUrl, relayOpts.requireHttpsOffload),
            new Promise<boolean>((r) => setTimeout(() => r(false), 260)),
          ]);
          if (ok) allowedBuckets.add(bucket);
        }),
      );
    }
  }

  const rewriteOptions: RewriteManifestOptions = {
    forceProxy: relayOpts.forceProxy,
    ...(allowedBuckets.size > 0
      ? {
          canOffloadSegment: (absUrl: string) =>
            allowedBuckets.has(segmentOriginBucketKey(absUrl)) &&
            isAnonymousSegmentUrl(absUrl, relayOpts.requireHttpsOffload),
        }
      : {}),
  };

  const rewritten =
    kind === 'hls'
      ? rewriteHlsManifest(
          bodyText,
          finalUrl,
          ticketHeaders,
          secret,
          streamPath,
          hintAudioLang,
          rewriteOptions,
        )
      : rewriteDashManifest(bodyText, finalUrl, ticketHeaders, secret, streamPath, rewriteOptions);
  const buf = Buffer.from(rewritten, 'utf8');
  setCloudflareCache(res, 'manifest');
  res.writeHead(200, {
    'Content-Type':
      kind === 'hls'
        ? 'application/vnd.apple.mpegurl; charset=utf-8'
        : 'application/dash+xml; charset=utf-8',
    'Content-Length': String(buf.byteLength),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

export async function handleStreamRelay(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    secret: Buffer;
    allowOrigin: string;
    ticketParam: string;
    streamPath?: string;
    relayMode?: 'hybrid' | 'full';
    forceProxy?: boolean;
    requireHttpsOffload?: boolean;
  },
): Promise<void> {
  applyCorsHeaders(res, opts.allowOrigin);

  const openedTicket = openStreamTicket(opts.secret, opts.ticketParam);
  const requestParams = new URL(req.url || '/', 'http://relay.invalid').searchParams;
  const ticket = openedTicket ? materializeDashTicket(openedTicket, requestParams) : null;
  if (!ticket) {
    setCloudflareCache(res, 'no-store');
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'invalid or expired stream ticket' }));
    return;
  }

  if (!isSafeUpstreamUrl(ticket.u)) {
    setCloudflareCache(res, 'no-store');
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'disallowed upstream target' }));
    return;
  }

  const streamPath = opts.streamPath || '/api/v1/stream';
  const relayMode = opts.relayMode ?? 'hybrid';
  const forceProxy = relayMode === 'full' || !!opts.forceProxy || ticket.fp === 1;
  const requireHttpsOffload = opts.requireHttpsOffload ?? true;
  const manifestRelayOpts = { relayMode, forceProxy, requireHttpsOffload };

  const manifestCacheKey =
    req.method === 'GET' && ticket.k === 'm' && !req.headers.range
      ? buildManifestCacheKey(ticket.u, ticket.h)
      : '';

  if (manifestCacheKey) {
    const cached = getCachedManifest(manifestCacheKey);
    if (cached) {
      await sendRewrittenManifest(
        res,
        cached.kind,
        cached.bodyText,
        cached.finalUrl,
        ticket.h,
        opts.secret,
        streamPath,
        ticket.l,
        manifestRelayOpts,
      );
      return;
    }
  }

  const defaultAccept =
    ticket.k === 'm'
      ? 'application/vnd.apple.mpegurl, application/x-mpegURL, application/dash+xml, */*;q=0.8'
      : '*/*';

  const upstreamHeaders: Record<string, string> = {
    'User-Agent': DEFAULT_RELAY_UA,
    Accept: defaultAccept,
    ...(ticket.h ?? {}),
  };
  if (typeof req.headers.range === 'string' && ticket.k !== 'm') {
    upstreamHeaders.Range = req.headers.range;
  }

  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  req.on('close', onClientClose);

  try {
    const upstreamRes = await fetch(ticket.u, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
      signal: AbortSignal.any([
        abortController.signal,
        // Manifests must fail fast so the player can fail over to the next
        // source instead of spinning on a slow upstream; media segments get
        // a longer window because they are larger and range-driven.
        AbortSignal.timeout(ticket.k === 'm' ? 12_000 : 25_000),
      ]),
    });

    const finalUrl = upstreamRes.url || ticket.u;
    if (!isSafeUpstreamUrl(finalUrl)) {
      setCloudflareCache(res, 'no-store');
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'blocked unsafe redirect' }));
      return;
    }

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      setCloudflareCache(res, 'no-store');
      res.writeHead(upstreamRes.status >= 400 && upstreamRes.status < 600 ? upstreamRes.status : 502, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ ok: false, error: `upstream responded ${upstreamRes.status}` }));
      return;
    }

    const ct = (upstreamRes.headers.get('content-type') || '').toLowerCase();
    const isBinaryMediaCt = ct.startsWith('video/') || ct.startsWith('audio/');
    const looksLikeHls =
      !isBinaryMediaCt &&
      (ticket.k === 'm' ||
        ct.includes('mpegurl') ||
        /\.m3u8(?:[?#]|$)/i.test(finalUrl));
    const looksLikeDash = !isBinaryMediaCt && (ct.includes('dash+xml') || /\.mpd(?:[?#]|$)/i.test(finalUrl));

    if (req.method !== 'HEAD' && (looksLikeHls || looksLikeDash)) {
      const bodyText = await readBoundedText(upstreamRes, MAX_MANIFEST_BYTES);
      const trimmedLead = bodyText.trimStart();

      if (trimmedLead.startsWith('#EXTM3U')) {
        if (
          manifestCacheKey &&
          (/#EXT-X-STREAM-INF\b/i.test(bodyText) || /#EXT-X-ENDLIST\b/i.test(bodyText))
        ) {
          setCachedManifest(manifestCacheKey, {
            finalUrl,
            kind: 'hls',
            bodyText,
          });
        }
        await sendRewrittenManifest(
          res,
          'hls',
          bodyText,
          finalUrl,
          ticket.h,
          opts.secret,
          streamPath,
          ticket.l,
          manifestRelayOpts,
        );
        return;
      }

      if (looksLikeDash && trimmedLead.includes('<MPD')) {
        if (manifestCacheKey && !/\btype\s*=\s*["']dynamic["']/i.test(bodyText)) {
          setCachedManifest(manifestCacheKey, {
            finalUrl,
            kind: 'dash',
            bodyText,
          });
        }
        await sendRewrittenManifest(
          res,
          'dash',
          bodyText,
          finalUrl,
          ticket.h,
          opts.secret,
          streamPath,
          ticket.l,
          manifestRelayOpts,
        );
        return;
      }

      // Reject dead soft-403 / HTML / invalid bodies on manifest tickets so they are never cached or fed to hls.js
      if (ticket.k === 'm' || /^<!doctype\s+html\b|^<html\b/i.test(trimmedLead) || !trimmedLead) {
        setCloudflareCache(res, 'no-store');
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid upstream manifest payload' }));
        return;
      }

      const fallbackBuf = Buffer.from(bodyText, 'utf8');
      setCloudflareCache(res, ticket.k === 's' ? 'subtitle' : 'manifest');
      res.writeHead(upstreamRes.status, {
        'Content-Type': upstreamRes.headers.get('content-type') || 'application/octet-stream',
        'Content-Length': String(fallbackBuf.byteLength),
      });
      res.end(fallbackBuf);
      return;
    }

    // VixSrc serves AES-encrypted transport streams with a text/html MIME type.
    // Peek before forwarding, and still reject actual HTML challenge/error pages.
    let sniffedStream: Readable | undefined;
    const vixMedia = ticket.k === 'a' && /^https?:\/\/(?:[a-z0-9-]+\.)*vixsrc\.to(?::\d+)?(?:\/|$)/i.test(ticket.h?.Referer || ticket.h?.referer || '');
    if (vixMedia && ct.includes('text/html') && req.method !== 'HEAD' && upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      const first = await reader.read();
      const lead = Buffer.from(first.value || []).toString('utf8').trimStart();
      if (first.done || /^<!doctype\s+html\b|^<html\b/i.test(lead)) {
        await reader.cancel().catch(() => {});
        setCloudflareCache(res, 'no-store');
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'upstream returned HTML instead of media segment' }));
        return;
      }
      sniffedStream = Readable.from((async function* () {
        try {
          if (first.value) yield first.value;
          for (;;) { const part = await reader.read(); if (part.done) break; yield part.value; }
        } finally { await reader.cancel().catch(() => {}); }
      })());
    }

    // Never pipe HTML error/redirect pages as binary media segments, encryption keys, or MP4 byte ranges
    if (!sniffedStream && (ticket.k === 'a' || ticket.k === 'k') && (ct.includes('text/html') || ct.includes('application/xhtml'))) {
      try {
        await upstreamRes.body?.cancel();
      } catch {
        /* ignore */
      }
      setCloudflareCache(res, 'no-store');
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'upstream returned HTML instead of media segment' }));
      return;
    }

    const looksLikeWebVtt =
      req.method !== 'HEAD' &&
      !isBinaryMediaCt &&
      (ticket.k === 's' || ct.includes('text/vtt') || /\.vtt(?:[?#]|$)/i.test(finalUrl));

    if (looksLikeWebVtt) {
      const subText = await readBoundedText(upstreamRes, MAX_MANIFEST_BYTES);
      const trimmedSub = subText.replace(/^\uFEFF/, '').trimStart();
      if (/^<!doctype\s+html\b|^<html\b/i.test(trimmedSub) || !trimmedSub) {
        setCloudflareCache(res, 'no-store');
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'upstream returned HTML instead of subtitle track' }));
        return;
      }
      const isVtt = /^WEBVTT\b/i.test(trimmedSub);
      const cleaned = isVtt ? sanitizeWebVtt(subText) : sanitizeSubRip(subText);
      const buf = Buffer.from(cleaned, 'utf8');
      const subCt =
        isVtt || /\.vtt(?:[?#]|$)/i.test(finalUrl)
          ? 'text/vtt; charset=utf-8'
          : 'text/plain; charset=utf-8';
      setCloudflareCache(res, 'subtitle');
      res.writeHead(200, {
        'Content-Type': subCt,
        'Content-Length': String(buf.byteLength),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
      return;
    }

    let outContentType = sniffedStream ? 'application/octet-stream' : upstreamRes.headers.get('content-type') || 'application/octet-stream';
    if (ticket.k === 's') {
      if (/\.vtt(?:[?#]|$)/i.test(finalUrl)) outContentType = 'text/vtt; charset=utf-8';
      else if (/\.(?:srt|ass|ssa)(?:[?#]|$)/i.test(finalUrl)) outContentType = 'text/plain; charset=utf-8';
      setCloudflareCache(res, 'subtitle');
    } else {
      setCloudflareCache(res, 'segment');
    }

    const outHeaders: Record<string, string> = {
      'Content-Type': outContentType,
      'X-Content-Type-Options': 'nosniff',
    };
    for (const hName of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const val = upstreamRes.headers.get(hName);
      if (val) outHeaders[hName] = val;
    }

    res.writeHead(upstreamRes.status, outHeaders);
    if (req.method === 'HEAD' || !upstreamRes.body) {
      res.end();
      return;
    }

    const nodeStream = sniffedStream || Readable.fromWeb(upstreamRes.body as unknown as WebReadableStream);
    await pipeline(nodeStream, res);
  } catch (err) {
    if (!res.headersSent) {
      setCloudflareCache(res, 'no-store');
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'stream relay interrupted' }));
    } else if (!res.writableEnded) {
      res.destroy(err instanceof Error ? err : undefined);
    }
  } finally {
    req.off('close', onClientClose);
  }
}
