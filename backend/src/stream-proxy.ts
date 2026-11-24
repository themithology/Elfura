/**
 * Elfura Backend — Raw Stream Proxy (tgvidx style)
 * =================================================
 * One stateless endpoint replaces the old sealed-ticket relay:
 *
 *   GET/HEAD /api/proxy?u=<upstream-url>[&h=<base64url headers>][&ro=<origin>]
 *
 * The player only ever sees `/api/proxy?u=...` URLs. Every manifest, key,
 * subtitle and media segment is streamed through this one path with
 * backpressure and zero disk writes. Manifests are rewritten so every child
 * reference points back at the same proxy, which is how tgvidx-style players
 * keep provider URLs and required headers out of the browser.
 *
 * There are no tickets, no per-session encryption, no offload decisions and no
 * resolver/media load-balancing in this path. `u` is an opaque base64url of the
 * upstream URL (so a provider hostname never appears in a rewritten playlist or
 * MPD) and `h` is a base64url JSON of the small header hint the source adapter
 * needs (Referer, Origin, Cookie, ...). SSRF protection stays: every hop is
 * checked with `isSafeUpstreamUrl`, and a restricted source can pin every hop to
 * one origin. The endpoint is stateless and CORS-`*`, so any number of servers
 * can serve it and nothing has to be remembered between requests.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  applyCorsHeaders,
  isSafeUpstreamUrl,
  matchesRestrictedOrigin,
  setCloudflareCache,
} from './security.js';
import { restrictedFetchWithRedirects } from './restricted-fetch.js';
import { sniffMediaBytes, unwrapPngTransportStream } from './sources/media-sniff.js';
import { normalizeLang } from './sources/lang.js';
import { PolicyCache } from './memory-policy.js';
import { bypassEgressProfile } from './egress.js';

export const DEFAULT_STREAM_PROXY_PATH = '/api/proxy';

const DEFAULT_PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_WRAPPED_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * The proxy's own upstream fetches are media serving, not discovery: they must
 * not be routed through the optional Cloudflare Worker or a metered proxy, and
 * they already carry the exact headers this module chose.
 */
const mediaFetch: typeof fetch = (input, init) => bypassEgressProfile(() => fetch(input, init));
const MANIFEST_TIMEOUT_MS = 12_000;
const MEDIA_TIMEOUT_MS = 30_000;

/** Header hints a source adapter may attach to a proxied URL. */
const PROXY_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-language',
  'referer',
  'origin',
  'user-agent',
  'cookie',
  'authorization',
  'x-api-key',
  'x-playback-token',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
]);

/** Credentials must not follow a playlist to another origin. */
const SENSITIVE_PROXY_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-playback-token',
]);

const UPSTREAM_TRACK_WATERMARK_RE =
  /moviehub|tgflix|tgvid|tghub|tgkai|aetho|vidbolt|rousav|hakuna|hscow|fcxmb|orion|vidrift|vidsync|nxsha|nxstream|itsnitrox|vidbox|vidlink|vidrock|vercetti|vidstuck|hguider|sply|greybox|greyboxtv|^(?:audio|track\s*\d*|sound|stream)$/i;

const WEBVTT_SPAM_CUE_RE =
  /(?:www\.|https?:\/\/|\b[a-z0-9-]+\.(?:com|net|org|world|xyz|pro|in|io|to|gg|cc|space|tech)\b|watch\s+movies|hollymovie|opensubtitles|subscene|yts\.|yify|aethoembed|aethoflix|vidbolt|vidrift|vidsync|vidlink|vidrock|vidstuck|nxsha|nxstream|tgflix|tgvid|moviehub|greybox|greyboxtv|bottom\s+control\s+bar|press\s+space\s+or\s+k|multi-audio\s+stream\s+connected)/i;

const HLS_CONTENT_TYPE_RE = /(?:mpegurl|m3u8|x-mpegurl)/i;
const DASH_CONTENT_TYPE_RE = /(?:dash\+xml|application\/xml|text\/xml)/i;
const SUBTITLE_CONTENT_TYPE_RE = /(?:text\/vtt|webvtt|subrip|srt|ssa|ass)/i;

/* ------------------------------------------------------------------ */
/* Proxy URL helpers                                                    */
/* ------------------------------------------------------------------ */

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBase64UrlJson(raw: string): unknown {
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Keep only safe, explicitly allowed header hints. */
export function sanitizeProxyHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (typeof rawValue !== 'string') continue;
    const name = rawName.toLowerCase();
    if (!PROXY_HEADER_ALLOWLIST.has(name)) continue;
    if (!rawValue || rawValue.length > 16_384) continue;
    out[name] = rawValue;
  }
  return out;
}

export function encodeProxyHeaders(headers?: Record<string, string>): string | undefined {
  const clean = sanitizeProxyHeaders(headers);
  return Object.keys(clean).length ? encodeBase64UrlJson(clean) : undefined;
}

export function decodeProxyHeaders(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw || raw.length > 65_536) return undefined;
  const decoded = decodeBase64UrlJson(raw);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return undefined;
  const clean = sanitizeProxyHeaders(decoded as Record<string, string>);
  return Object.keys(clean).length ? clean : undefined;
}

/** Opaque, stateless target encoding. No server state, no key, no ticket. */
export function encodeProxyTarget(rawUrl: string): string {
  return Buffer.from(rawUrl, 'utf8').toString('base64url');
}

export function decodeProxyTarget(raw: string): string | null {
  if (!raw || raw.length > 65_536) return null;
  // Accept a raw absolute URL too, so the endpoint remains easy to debug.
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export interface BuildProxyUrlOptions {
  /** Append DASH template placeholders so dash.js can substitute them. */
  dashTemplate?: boolean;
  /** Pin every hop (including redirects) to this HTTPS origin. */
  restrictedOrigin?: string;
  /** Single-dub language hint used when rewriting this stream's playlists. */
  audioLang?: string;
}

/**
 * Build the public proxy URL for one upstream resource.
 *
 * `dashTemplate` is only for DASH `SegmentTemplate` attributes. The literal
 * `$Number$` / `$Time$` placeholders stay in `u`; dash.js substitutes them in
 * the query string, and {@link materializeProxyTemplate} applies the same
 * substitution to `u` when the request arrives.
 */
export function buildStreamProxyUrl(
  rawUrl: string,
  headers?: Record<string, string>,
  proxyPath = DEFAULT_STREAM_PROXY_PATH,
  options?: BuildProxyUrlOptions,
): string {
  const params = new URLSearchParams();
  params.set('u', encodeProxyTarget(rawUrl));
  const encodedHeaders = encodeProxyHeaders(headers);
  if (encodedHeaders) params.set('h', encodedHeaders);
  if (options?.restrictedOrigin) params.set('ro', options.restrictedOrigin);
  if (options?.audioLang) params.set('l', options.audioLang);
  let query = params.toString();
  if (options?.dashTemplate) {
    // dash.js substitutes these placeholders in the URL string itself, so they
    // must stay literal (`$Number%05d$`), not percent-encoded by URLSearchParams.
    const extras: string[] = [];
    for (const token of DASH_TEMPLATE_PARAMS) {
      token.pattern.lastIndex = 0;
      if (!token.pattern.test(rawUrl)) continue;
      token.pattern.lastIndex = 0;
      const match = rawUrl.match(token.pattern)?.[0] || `$${token.name}$`;
      extras.push(`${token.param}=${match}`);
    }
    if (extras.length) query += (query ? '&' : '') + extras.join('&');
  }
  return `${proxyPath}?${query}`;
}

/* ------------------------------------------------------------------ */
/* DASH template materialization                                        */
/* ------------------------------------------------------------------ */

const DASH_TEMPLATE_PARAMS = [
  { name: 'RepresentationID', param: '_dr', pattern: /\$RepresentationID\$/g, placeholder: /\$RepresentationID\$/ },
  { name: 'Number', param: '_dn', pattern: /\$Number(?:%0\d+d)?\$/g, placeholder: /\$Number(?:%0\d+d)?\$/ },
  { name: 'Time', param: '_dt', pattern: /\$Time\$/g, placeholder: /\$Time\$/ },
  { name: 'Bandwidth', param: '_db', pattern: /\$Bandwidth\$/g, placeholder: /\$Bandwidth\$/ },
] as const;

/** Apply dash.js's template substitutions to the raw upstream URL. */
export function materializeProxyTemplate(rawUrl: string, params: URLSearchParams): string | null {
  let resolved = rawUrl;
  for (const token of DASH_TEMPLATE_PARAMS) {
    token.pattern.lastIndex = 0;
    if (!token.pattern.test(resolved)) continue;
    const value = params.get(token.param);
    if (value === null || value.length > 160) return null;
    const valid = token.name === 'RepresentationID' ? /^[A-Za-z0-9_.-]+$/ : /^\d+$/;
    if (!valid.test(value)) return null;
    token.pattern.lastIndex = 0;
    resolved = resolved.replace(token.pattern, () => value);
  }
  if (/\$(?:RepresentationID|Number(?:%0\d+d)?|Time|Bandwidth)\$/.test(resolved)) return null;
  return resolved;
}

/* ------------------------------------------------------------------ */
/* Manifest helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Some live HLS producers escape underscores and slashes in playlist URIs
 * (for example `hls\_mps`). WHATWG URL parsing treats a backslash in an HTTP
 * path as a slash, producing a different, nonexistent CDN key.
 */
export function normalizeManifestUriReference(rawRef: string): string {
  return rawRef.trim().replace(/\\([/_])/g, '$1');
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

/** Do not forward signed CDN credentials to a different manifest origin. */
function headersForManifestChild(
  headers: Record<string, string> | undefined,
  manifestUrl: string,
  childUrl: string,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  let sameOrigin = false;
  try {
    sameOrigin = new URL(manifestUrl).origin === new URL(childUrl).origin;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return headers;
  const safe = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !SENSITIVE_PROXY_HEADERS.has(name.toLowerCase())),
  );
  return Object.keys(safe).length ? safe : undefined;
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

    if (norm.code && norm.code !== 'und') {
      if (langMatch) {
        updated = updated.replace(/LANGUAGE=(?:"[^"]*"|[^,\s]+)/i, `LANGUAGE="${norm.code}"`);
      } else {
        updated += `,LANGUAGE="${norm.code}"`;
      }
    }

    const safeName = finalName.replace(/"/g, '');
    if (nameMatch) {
      updated = updated.replace(/NAME="[^"]*"/i, `NAME="${safeName}"`);
    } else {
      updated += `,NAME="${safeName}"`;
    }

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

/* ------------------------------------------------------------------ */
/* HLS rewriting                                                        */
/* ------------------------------------------------------------------ */

/**
 * Rewrite every URI in an HLS playlist into a fresh `/api/proxy?u=...` URL.
 *
 * Provider subtitle renditions are removed: OpenSubtitles is the only
 * subtitle catalogue, exactly as before.
 */
export function rewriteHlsManifest(
  manifestText: string,
  baseUrl: string,
  headers: Record<string, string> | undefined,
  proxyPath = DEFAULT_STREAM_PROXY_PATH,
  hintAudioLang?: string,
  restrictedOrigin?: string,
): string {
  const wrapUrl = (rawRef: string): string => {
    const trimmed = normalizeManifestUriReference(rawRef);
    if (!trimmed || trimmed.startsWith('data:')) return rawRef;
    let abs: string;
    try {
      abs = resolveHlsChildUrl(trimmed, baseUrl);
    } catch {
      return '';
    }
    if (!isSafeUpstreamUrl(abs)) return '';
    if (restrictedOrigin && !matchesRestrictedOrigin(abs, restrictedOrigin)) return '';
    const childHeaders = headersForManifestChild(headers, baseUrl, abs);
    return buildStreamProxyUrl(abs, childHeaders, proxyPath, { restrictedOrigin });
  };

  // Deduplicate repeated leading #EXTM3U lines (observed on TGKAI playlists).
  const rawLines = manifestText.split(/\r?\n/);
  const dedupedHeaderLines: string[] = [];
  let seenExtM3u = false;
  for (const line of rawLines) {
    if (line.trim().toUpperCase() === '#EXTM3U') {
      if (seenExtM3u) continue;
      seenExtM3u = true;
    }
    dedupedHeaderLines.push(line);
  }

  const noProviderSubs = dedupedHeaderLines
    .filter((line) => !/^\s*#EXT-X-MEDIA:.*\bTYPE=SUBTITLES\b/i.test(line))
    .map((line) => /^\s*#EXT-X-(?:I-FRAME-)?STREAM-INF:/i.test(line)
      ? line
          .replace(/,SUBTITLES=(?:"[^"]*"|[^,]*)/gi, '')
          .replace(/(:)SUBTITLES=(?:"[^"]*"|[^,]*),?/i, '$1')
      : line);

  const lines = sanitizeExtXMediaLines(noProviderSubs, hintAudioLang);

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        // Every tag attribute that carries a URI: EXT-X-KEY, EXT-X-MAP,
        // EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, EXT-X-PART,
        // EXT-X-PRELOAD-HINT, EXT-X-RENDITION-REPORT, EXT-X-SESSION-KEY, ...
        return line.replace(/\bURI=(["'])([\s\S]*?)\1/gi, (_full, quote: string, uriVal: string) => {
          const proxied = wrapUrl(uriVal);
          return proxied ? `URI=${quote}${proxied}${quote}` : `URI=${quote}${quote}`;
        });
      }

      return wrapUrl(trimmed);
    })
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* DASH rewriting                                                       */
/* ------------------------------------------------------------------ */

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

/** Rewrite every URL-bearing DASH construct into a proxy URL. */
export function rewriteDashManifest(
  mpdText: string,
  baseUrl: string,
  headers: Record<string, string> | undefined,
  proxyPath = DEFAULT_STREAM_PROXY_PATH,
  restrictedOrigin?: string,
): string {
  type Frame = { tag: string; base: string; hasBase: boolean };
  const frames: Frame[] = [{ tag: '', base: baseUrl, hasBase: false }];
  const scopedTags = new Set(['MPD', 'Period', 'AdaptationSet', 'Representation']);
  const tokenPattern = /<!--[\s\S]*?-->|<BaseURL\b[^>]*>[\s\S]*?<\/BaseURL\s*>|<\/?[A-Za-z_][^>]*>/g;

  const staticUrl = (raw: string, base: string): string => {
    const abs = new URL(xmlUnescape(raw), base).toString();
    if (!isSafeUpstreamUrl(abs)) throw new Error('unsafe DASH URL');
    if (restrictedOrigin && !matchesRestrictedOrigin(abs, restrictedOrigin)) throw new Error('unsafe DASH URL');
    return buildStreamProxyUrl(abs, headersForManifestChild(headers, baseUrl, abs), proxyPath, {
      restrictedOrigin,
    });
  };

  const templateUrl = (raw: string, base: string): string => {
    const abs = new URL(xmlUnescape(raw), base).toString();
    if (!isSafeUpstreamUrl(abs)) throw new Error('unsafe DASH URL');
    if (restrictedOrigin && !matchesRestrictedOrigin(abs, restrictedOrigin)) throw new Error('unsafe DASH URL');
    return buildStreamProxyUrl(abs, headersForManifestChild(headers, baseUrl, abs), proxyPath, {
      dashTemplate: true,
      restrictedOrigin,
    });
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
        // An unsafe or off-origin BaseURL must not survive: leaving it raw would
        // hand the browser the provider hostname (or a private address) and let
        // dash.js resolve every child against it. Dropping the element makes
        // dash.js fall back to the MPD's own URL, which is already ours.
        return '';
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
        rewritten = rewritten.replace(attrPattern, (_whole, prefix: string, quote: string, raw: string) => {
          try {
            const value = dynamic ? templateUrl(raw, frame.base) : staticUrl(raw, frame.base);
            return `${prefix}${quote}${xmlAttributeEscape(value)}${quote}`;
          } catch {
            // Same rule as BaseURL: a URL we refuse to proxy must disappear, not
            // stay in the document. An unresolvable SegmentTemplate/SegmentURL
            // makes dash.js skip that representation instead of sending the
            // viewer to a host we never approved.
            return '';
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

/* ------------------------------------------------------------------ */
/* Subtitle sanitization                                                */
/* ------------------------------------------------------------------ */

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
    if (WEBVTT_SPAM_CUE_RE.test(cuePayload)) continue;
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
    if (WEBVTT_SPAM_CUE_RE.test(cuePayload)) continue;
    kept.push(block);
  }

  return `${kept.join('\n\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Bounded manifest RAM cache (optional warm-up from liveness)          */
/* ------------------------------------------------------------------ */

const MAX_MANIFEST_RAM_ENTRIES = 1024;
const MAX_CACHEABLE_MANIFEST_BYTES = 262_144;
const MANIFEST_RAM_TTL_MS = 180_000;

interface CachedUpstreamManifest {
  expiresAt: number;
  finalUrl: string;
  kind: 'hls' | 'dash';
  bodyText: string;
}

const manifestRamCache = new PolicyCache<CachedUpstreamManifest>(MAX_MANIFEST_RAM_ENTRIES);

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
  manifestRamCache.set(key, { ...entry, expiresAt: Date.now() + MANIFEST_RAM_TTL_MS });
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

/* ------------------------------------------------------------------ */
/* Proxy request handling                                               */
/* ------------------------------------------------------------------ */

export interface StreamProxyOptions {
  allowOrigin?: string;
  proxyPath?: string;
}

function sendJsonError(res: ServerResponse, status: number, message: string, allowOrigin = '*'): void {
  applyCorsHeaders(res, allowOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range, If-None-Match, If-Modified-Since, Content-Type, X-Playback-Token, X-Elfura-Envelope, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified');
  setCloudflareCache(res, 'no-store');
  const body = Buffer.from(JSON.stringify({ ok: false, error: message }), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function isManifestUrl(url: URL): boolean {
  return /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(url.pathname + url.search);
}

function isSubtitleUrl(url: URL): boolean {
  return /\.(?:vtt|srt|ass|ssa)(?:[?#]|$)/i.test(url.pathname + url.search);
}

function looksLikeHls(text: string): boolean {
  return /^\uFEFF?#EXTM3U\b/i.test(text.trimStart());
}

function looksLikeDash(text: string): boolean {
  return /<MPD\b/i.test(text.slice(0, 4096));
}

function isTextContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    HLS_CONTENT_TYPE_RE.test(ct) ||
    DASH_CONTENT_TYPE_RE.test(ct) ||
    SUBTITLE_CONTENT_TYPE_RE.test(ct) ||
    ct.startsWith('text/') ||
    ct.includes('json')
  );
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
      await reader.cancel().catch(() => {});
      throw new Error('manifest exceeded safety limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read a bounded binary body for the PNG-wrapped / mislabelled media paths. */
async function readBoundedBinary(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function sendBufferedBinary(
  res: ServerResponse,
  req: IncomingMessage,
  status: number,
  contentType: string,
  body: Buffer,
  cache: 'segment' | 'subtitle',
  allowOrigin = '*',
): void {
  setCloudflareCache(res, cache);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.byteLength),
    'Access-Control-Allow-Origin': allowOrigin,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function forwardRequestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const pass = (name: string) => {
    const value = req.headers[name];
    if (typeof value === 'string' && value) out[name] = value;
  };
  pass('range');
  pass('if-range');
  pass('if-none-match');
  pass('if-modified-since');
  return out;
}

function responseHeadersFor(upstream: Response, contentType: string | null): Record<string, string> {
  const out: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  };
  const copy = (name: string) => {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  };
  copy('content-type');
  copy('content-length');
  copy('content-range');
  copy('accept-ranges');
  copy('etag');
  copy('last-modified');
  if (contentType && !out['content-type']) out['content-type'] = contentType;
  return out;
}

function selfProxyTarget(target: URL, req: IncomingMessage): boolean {
  const ownHost = String(req.headers.host || '').toLowerCase();
  if (ownHost && target.host.toLowerCase() === ownHost) return true;
  if (/\/api\/(?:proxy|public\/stream-proxy|v1\/stream)(?:[/?#]|$)/i.test(target.pathname + target.search)) return true;
  return false;
}

/**
 * Serve one raw upstream resource through the proxy.
 *
 * This is intentionally one function: no tickets, no routing tables, no
 * per-request load-balancing. The only decisions are SSRF safety, bounded
 * manifest rewriting, and streaming.
 */
export async function handleStreamProxy(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StreamProxyOptions = {},
): Promise<void> {
  const allowOrigin = opts.allowOrigin ?? '*';
  const proxyPath = opts.proxyPath ?? DEFAULT_STREAM_PROXY_PATH;
  applyCorsHeaders(res, allowOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range, If-None-Match, If-Modified-Since, Content-Type, X-Playback-Token, X-Elfura-Envelope, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJsonError(res, 405, 'method not allowed', allowOrigin);
    return;
  }

  const requestUrl = new URL(req.url || '/', 'http://proxy.invalid');
  const rawTarget = requestUrl.searchParams.get('u') || '';
  if (!rawTarget) {
    sendJsonError(res, 400, 'missing upstream url', allowOrigin);
    return;
  }
  const decodedTarget = decodeProxyTarget(rawTarget);
  if (!decodedTarget) {
    sendJsonError(res, 400, 'invalid upstream url', allowOrigin);
    return;
  }

  let target = decodedTarget;
  // A DASH template proxy URL carries the substitution values in query params.
  if (/\$(?:RepresentationID|Number(?:%0\d+d)?|Time|Bandwidth)\$/.test(target)) {
    target = materializeProxyTemplate(target, requestUrl.searchParams) || '';
    if (!target) {
      sendJsonError(res, 400, 'invalid dash template', allowOrigin);
      return;
    }
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(target);
  } catch {
    sendJsonError(res, 400, 'invalid upstream url', allowOrigin);
    return;
  }

  if (!isSafeUpstreamUrl(parsedTarget.href) || selfProxyTarget(parsedTarget, req)) {
    sendJsonError(res, 403, 'disallowed upstream target', allowOrigin);
    return;
  }

  const restrictedOrigin = requestUrl.searchParams.get('ro') || undefined;
  const hintAudioLang = requestUrl.searchParams.get('l') || undefined;
  if (restrictedOrigin && !matchesRestrictedOrigin(parsedTarget.href, restrictedOrigin)) {
    sendJsonError(res, 403, 'disallowed upstream target', allowOrigin);
    return;
  }

  const headers = decodeProxyHeaders(requestUrl.searchParams.get('h'));
  const manifestExpected = isManifestUrl(parsedTarget);
  const subtitleExpected = isSubtitleUrl(parsedTarget);

  const manifestCacheKey =
    req.method === 'GET' && manifestExpected && !req.headers.range
      ? buildManifestCacheKey(parsedTarget.href, headers)
      : '';
  if (manifestCacheKey) {
    const cached = getCachedManifest(manifestCacheKey);
    if (cached) {
      const rewritten =
        cached.kind === 'hls'
          ? rewriteHlsManifest(cached.bodyText, cached.finalUrl, headers, proxyPath, hintAudioLang, restrictedOrigin)
          : rewriteDashManifest(cached.bodyText, cached.finalUrl, headers, proxyPath, restrictedOrigin);
      const body = Buffer.from(rewritten, 'utf8');
      setCloudflareCache(res, 'manifest');
      res.writeHead(200, {
        'Content-Type':
          cached.kind === 'hls'
            ? 'application/vnd.apple.mpegurl; charset=utf-8'
            : 'application/dash+xml; charset=utf-8',
        'Content-Length': String(body.byteLength),
        'Access-Control-Allow-Origin': allowOrigin,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
  }

  const upstreamHeaders: Record<string, string> = {
    'User-Agent': DEFAULT_PROXY_UA,
    Accept: manifestExpected
      ? 'application/vnd.apple.mpegurl, application/x-mpegURL, application/dash+xml, */*;q=0.8'
      : '*/*',
    ...(headers ?? {}),
    ...forwardRequestHeaders(req),
  };

  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.on('close', onClientClose);

  try {
    const timeout = AbortSignal.timeout(manifestExpected ? MANIFEST_TIMEOUT_MS : MEDIA_TIMEOUT_MS);
    const signal = AbortSignal.any([abortController.signal, timeout]);
    const init: RequestInit = {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      redirect: 'manual',
      signal,
    };

    // A restricted source pins every redirect to its declared origin and keeps
    // DNS-rebinding protection in the guarded dispatcher.
    let upstream: Response;
    if (restrictedOrigin) {
      upstream = await restrictedFetchWithRedirects(parsedTarget.href, init, restrictedOrigin, mediaFetch);
    } else {
      let current = parsedTarget;
      let redirects = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const hopHeaders = { ...upstreamHeaders };
        const hop = await mediaFetch(current.href, { ...init, headers: hopHeaders });
        if (hop.status < 300 || hop.status >= 400) {
          upstream = hop;
          break;
        }
        const location = hop.headers.get('location');
        await hop.body?.cancel().catch(() => {});
        if (!location) {
          sendJsonError(res, 502, 'upstream redirect without location', allowOrigin);
          return;
        }
        if (redirects >= MAX_REDIRECTS) {
          sendJsonError(res, 502, 'too many upstream redirects', allowOrigin);
          return;
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          sendJsonError(res, 502, 'invalid upstream redirect', allowOrigin);
          return;
        }
        if (!isSafeUpstreamUrl(next.href) || selfProxyTarget(next, req)) {
          sendJsonError(res, 403, 'blocked unsafe redirect', allowOrigin);
          return;
        }
        if (next.origin !== current.origin) {
          for (const name of Object.keys(hopHeaders)) {
            if (SENSITIVE_PROXY_HEADERS.has(name.toLowerCase())) delete hopHeaders[name];
          }
        }
        current = next;
        redirects += 1;
      }
      // Attach the final URL for manifest rewriting.
      Object.defineProperty(upstream, 'url', { value: current.href, configurable: true });
    }

    const finalUrl = upstream.url || parsedTarget.href;
    if (!isSafeUpstreamUrl(finalUrl)) {
      sendJsonError(res, 403, 'blocked unsafe redirect', allowOrigin);
      return;
    }

    const contentType = upstream.headers.get('content-type') || '';
    const status = upstream.status;

    // Soft-403 HTML/JSON pages must never be cached at the edge or fed to
    // hls.js/dash.js. Some CDNs mislabel a real MPEG-TS segment as text/html,
    // so sniff a bounded prefix before rejecting. A genuine HTML page is 502.
    if (/^(?:text\/html|application\/xhtml)/i.test(contentType)) {
      if (manifestExpected) {
        await upstream.body?.cancel().catch(() => {});
        sendJsonError(res, 502, 'upstream returned html instead of a manifest', allowOrigin);
        return;
      }
      const bytes = await readBoundedBinary(upstream, MAX_WRAPPED_SEGMENT_BYTES).catch(() => null);
      if (bytes) {
        const sniff = sniffMediaBytes(bytes);
        if (sniff === 'mpeg-ts') {
          sendBufferedBinary(res, req, status, 'video/mp2t', bytes, 'segment', allowOrigin);
          return;
        }
        if (sniff === 'png-wrapped-ts') {
          const ts = unwrapPngTransportStream(bytes, MAX_WRAPPED_SEGMENT_BYTES);
          if (ts) {
            sendBufferedBinary(res, req, status, 'video/mp2t', Buffer.from(ts), 'segment', allowOrigin);
            return;
          }
        }
        if (sniff === 'mp4') {
          sendBufferedBinary(res, req, status, 'video/mp4', bytes, 'segment', allowOrigin);
          return;
        }
      }
      sendJsonError(res, 502, 'upstream returned a non-media body', allowOrigin);
      return;
    }
    if (!manifestExpected && !subtitleExpected && /application\/json/i.test(contentType)) {
      await upstream.body?.cancel().catch(() => {});
      sendJsonError(res, 502, 'upstream returned a non-media body', allowOrigin);
      return;
    }

    const shouldRewrite =
      req.method !== 'HEAD' &&
      upstream.body &&
      (manifestExpected || subtitleExpected || isTextContentType(contentType));

    if (shouldRewrite) {
      let text: string;
      try {
        text = await readBoundedText(upstream, MAX_MANIFEST_BYTES);
      } catch {
        sendJsonError(res, 502, 'upstream text body too large', allowOrigin);
        return;
      }

      if (looksLikeHls(text)) {
        const rewritten = rewriteHlsManifest(text, finalUrl, headers, proxyPath, hintAudioLang, restrictedOrigin);
        setCachedManifest(manifestCacheKey || buildManifestCacheKey(finalUrl, headers), {
          finalUrl,
          kind: 'hls',
          bodyText: text,
        });
        const body = Buffer.from(rewritten, 'utf8');
        setCloudflareCache(res, 'manifest');
        res.writeHead(status === 206 ? 200 : status, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Content-Length': String(body.byteLength),
          'Access-Control-Allow-Origin': allowOrigin,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      if (looksLikeDash(text)) {
        const rewritten = rewriteDashManifest(text, finalUrl, headers, proxyPath, restrictedOrigin);
        setCachedManifest(manifestCacheKey || buildManifestCacheKey(finalUrl, headers), {
          finalUrl,
          kind: 'dash',
          bodyText: text,
        });
        const body = Buffer.from(rewritten, 'utf8');
        setCloudflareCache(res, 'manifest');
        res.writeHead(status === 206 ? 200 : status, {
          'Content-Type': 'application/dash+xml; charset=utf-8',
          'Content-Length': String(body.byteLength),
          'Access-Control-Allow-Origin': allowOrigin,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      if (subtitleExpected || SUBTITLE_CONTENT_TYPE_RE.test(contentType)) {
        const isVtt = /^WEBVTT\b/i.test(text.trimStart());
        const sanitized = isVtt ? sanitizeWebVtt(text) : sanitizeSubRip(text);
        const body = Buffer.from(sanitized, 'utf8');
        setCloudflareCache(res, 'subtitle');
        res.writeHead(status === 206 ? 200 : status, {
          'Content-Type': isVtt ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8',
          'Content-Length': String(body.byteLength),
          'Access-Control-Allow-Origin': allowOrigin,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      // It looked textual but was not a manifest or subtitle. Send it as text
      // without pretending it is media.
      const body = Buffer.from(text, 'utf8');
      res.writeHead(status === 206 ? 200 : status, {
        'Content-Type': contentType || 'text/plain; charset=utf-8',
        'Content-Length': String(body.byteLength),
        'Access-Control-Allow-Origin': allowOrigin,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    // Some CDNs wrap MPEG-TS in a PNG container. Unwrap the bounded body so
    // the browser sees a real transport stream instead of a poster image.
    if (/^image\/png/i.test(contentType)) {
      const bytes = await readBoundedBinary(upstream, MAX_WRAPPED_SEGMENT_BYTES).catch(() => null);
      if (bytes) {
        const sniff = sniffMediaBytes(bytes);
        if (sniff === 'png-wrapped-ts') {
          const ts = unwrapPngTransportStream(bytes, MAX_WRAPPED_SEGMENT_BYTES);
          if (ts) {
            sendBufferedBinary(res, req, status, 'video/mp2t', Buffer.from(ts), 'segment', allowOrigin);
            return;
          }
        }
        sendBufferedBinary(res, req, status, contentType || 'image/png', bytes, subtitleExpected ? 'subtitle' : 'segment', allowOrigin);
        return;
      }
      sendJsonError(res, 502, 'upstream image body too large', allowOrigin);
      return;
    }

    // Binary media: stream with backpressure, never buffer the whole body.
    const outHeaders = responseHeadersFor(upstream, contentType || 'application/octet-stream');
    outHeaders['Access-Control-Allow-Origin'] = allowOrigin;
    if (status === 200 || status === 206) {
      setCloudflareCache(res, subtitleExpected ? 'subtitle' : 'segment');
    } else {
      setCloudflareCache(res, 'no-store');
    }
    res.writeHead(status, outHeaders);
    if (req.method === 'HEAD' || !upstream.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>), res);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const name = (error as Error)?.name || 'Error';
    const aborted = name === 'AbortError' || name === 'TimeoutError';
    sendJsonError(res, aborted ? 504 : 502, aborted ? 'upstream timed out' : 'upstream request failed', allowOrigin);
  }
}
