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
  /moviehub|tgflix|tgvid|tghub|tgkai|aetho|vidbolt|rousav|hakuna|hscow|fcxmb|orion|vidrift|vidsync|^(?:audio|track\s*\d*|sound|stream)$/i;

const WEBVTT_SPAM_CUE_RE =
  /(?:www\.|https?:\/\/|\b[a-z0-9-]+\.(?:com|net|org|world|xyz|pro|in|io|to|gg)\b|watch\s+movies|hollymovie|opensubtitles|subscene|yts\.|yify|aethoembed|aethoflix|vidbolt|vidrift|vidsync|tgflix|tgvid|moviehub|bottom\s+control\s+bar|press\s+space\s+or\s+k|multi-audio\s+stream\s+connected)/i;

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

function inferChildKind(tagLine: string, resolvedUrl: string, expectVariantPlaylist: boolean): 'm' | 's' | 'a' {
  if (expectVariantPlaylist) return 'm';
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

function sanitizeExtXMediaLines(lines: string[]): string[] {
  // First pass: check which AUDIO GROUP-IDs already have a DEFAULT=YES track
  const audioGroupHasDefault = new Map<string, boolean>();
  for (const rawLine of lines) {
    const t = rawLine.trim();
    if (!/^#EXT-X-MEDIA:/i.test(t) || !/TYPE=AUDIO\b/i.test(t)) continue;
    const gMatch = t.match(/GROUP-ID="([^"]+)"/i);
    const gid = gMatch?.[1] ?? 'default';
    if (!audioGroupHasDefault.has(gid)) audioGroupHasDefault.set(gid, false);
    if (/DEFAULT=YES\b/i.test(t)) audioGroupHasDefault.set(gid, true);
  }

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

    const norm = normalizeLang(rawLang || unnumberedName, unnumberedName);

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

export function rewriteHlsManifest(
  manifestText: string,
  baseUrl: string,
  headers: Record<string, string> | undefined,
  secret: Buffer,
  streamPath = '/api/v1/stream',
): string {
  const wrapUrl = (rawRef: string, kind: 'm' | 's' | 'a'): string => {
    const trimmed = rawRef.trim();
    if (!trimmed || trimmed.startsWith('data:')) return rawRef;
    let abs: string;
    try {
      abs = new URL(trimmed, baseUrl).toString();
    } catch {
      return rawRef;
    }
    if (!isSafeUpstreamUrl(abs)) return '';
    const ticket = sealStreamTicket(secret, {
      u: abs,
      ...(headers && Object.keys(headers).length ? { h: headers } : {}),
      k: kind,
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

  const lines = sanitizeExtXMediaLines(dedupedHeaderLines);
  let expectVariantUri = false;

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      const isStreamInf = /^#EXT-X-STREAM-INF\b/i.test(trimmed);
      if (isStreamInf) expectVariantUri = true;

      if (!trimmed.includes('URI="')) return line;
      return line.replace(/URI="([^"]+)"/gi, (_full, uriVal: string) => {
        let abs = uriVal;
        try {
          abs = new URL(uriVal, baseUrl).toString();
        } catch {
          /* keep raw */
        }
        const kind = inferChildKind(trimmed, abs, false);
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

function rewriteDashManifest(
  mpdText: string,
  baseUrl: string,
  headers: Record<string, string> | undefined,
  secret: Buffer,
  streamPath = '/api/v1/stream',
): string {
  return mpdText.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (full, inner: string) => {
    const raw = inner.trim();
    if (!raw) return full;
    let abs: string;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch {
      return full;
    }
    if (!isSafeUpstreamUrl(abs)) return full;
    const ticket = sealStreamTicket(secret, {
      u: abs,
      ...(headers && Object.keys(headers).length ? { h: headers } : {}),
      k: 'a',
    });
    return `<BaseURL>${streamPath}?t=${encodeURIComponent(ticket)}</BaseURL>`;
  });
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

const MAX_MANIFEST_RAM_ENTRIES = 128;
const MAX_CACHEABLE_MANIFEST_BYTES = 262_144;
const MANIFEST_RAM_TTL_MS = 45_000;

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

function sendRewrittenManifest(
  res: ServerResponse,
  kind: 'hls' | 'dash',
  bodyText: string,
  finalUrl: string,
  ticketHeaders: Record<string, string> | undefined,
  secret: Buffer,
  streamPath: string,
): void {
  const rewritten =
    kind === 'hls'
      ? rewriteHlsManifest(bodyText, finalUrl, ticketHeaders, secret, streamPath)
      : rewriteDashManifest(bodyText, finalUrl, ticketHeaders, secret, streamPath);
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
  },
): Promise<void> {
  applyCorsHeaders(res, opts.allowOrigin);

  const ticket = openStreamTicket(opts.secret, opts.ticketParam);
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
  const manifestCacheKey =
    req.method === 'GET' && ticket.k === 'm' && !req.headers.range
      ? `${ticket.u}|${JSON.stringify(ticket.h ?? {})}`
      : '';

  if (manifestCacheKey) {
    const cached = getCachedManifest(manifestCacheKey);
    if (cached) {
      sendRewrittenManifest(
        res,
        cached.kind,
        cached.bodyText,
        cached.finalUrl,
        ticket.h,
        opts.secret,
        streamPath,
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
      signal: AbortSignal.any([abortController.signal, AbortSignal.timeout(25_000)]),
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
        sendRewrittenManifest(res, 'hls', bodyText, finalUrl, ticket.h, opts.secret, streamPath);
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
        sendRewrittenManifest(res, 'dash', bodyText, finalUrl, ticket.h, opts.secret, streamPath);
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

    const looksLikeWebVtt =
      req.method !== 'HEAD' &&
      !isBinaryMediaCt &&
      (ticket.k === 's' || ct.includes('text/vtt') || /\.vtt(?:[?#]|$)/i.test(finalUrl));

    if (looksLikeWebVtt) {
      const subText = await readBoundedText(upstreamRes, MAX_MANIFEST_BYTES);
      const isVtt = /^WEBVTT\b/i.test(subText.replace(/^\uFEFF/, '').trimStart());
      const cleaned = isVtt ? sanitizeWebVtt(subText) : subText;
      const buf = Buffer.from(cleaned, 'utf8');
      const subCt =
        isVtt || /\.vtt(?:[?#]|$)/i.test(finalUrl)
          ? 'text/vtt; charset=utf-8'
          : /\.(?:srt|ass|ssa)(?:[?#]|$)/i.test(finalUrl)
            ? 'text/plain; charset=utf-8'
            : upstreamRes.headers.get('content-type') || 'text/plain; charset=utf-8';
      setCloudflareCache(res, 'subtitle');
      res.writeHead(200, {
        'Content-Type': subCt,
        'Content-Length': String(buf.byteLength),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(buf);
      return;
    }

    let outContentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
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

    const nodeStream = Readable.fromWeb(upstreamRes.body as unknown as WebReadableStream);
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
