/**
 * Live Re:Zero source acceptance audit (manual/CI only).
 *
 * Runs against real upstreams through the real uniform backend and relay.
 * Never prints upstream URLs, headers, signed tickets, or provider identifiers.
 * Every advertised Source 1 / Source 2 option must yield actual media bytes.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createBackendServer } from '../../dist/backend/index.js';

const TMDB_ID = '65942';
const SEASON = '1';
const EPISODE = '1';
const REQUEST_TIMEOUT_MS = 20_000;
const browserHeaders = {
  Origin: 'https://audit.elfura.invalid',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
};

const { server } = createBackendServer({
  host: '127.0.0.1',
  port: 0,
  isProd: true,
  secret: crypto.createHash('sha256').update('rezero-live-audit-only').digest(),
  allowedOrigins: ['https://audit.elfura.invalid'],
  requireToken: false,
  bindTokenIp: false,
  resolveTimeoutMs: 20_000,
  rateLimitPerMin: 1000,
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const apiBase = `http://127.0.0.1:${address.port}`;

function xmlUnescape(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { ...browserHeaders, ...(init.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function fetchManifest(url) {
  const res = await fetchWithTimeout(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) throw new Error('manifest returned HTML');
  return text;
}

async function fetchMediaBytes(url) {
  const res = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-1023' } });
  if (!(res.status === 200 || res.status === 206)) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`media HTTP ${res.status}`);
  }
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (
    contentType.includes('text/html') ||
    contentType.includes('application/json') ||
    contentType.includes('application/xml') ||
    contentType.includes('text/xml')
  ) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`media returned ${contentType || 'text'} instead of bytes`);
  }
  if (!res.body) throw new Error('media body was empty');
  const reader = res.body.getReader();
  const first = await reader.read();
  try { await reader.cancel(); } catch { /* ignore */ }
  if (first.done || !first.value?.byteLength) throw new Error('media body was empty');
  const prefix = Buffer.from(first.value).subarray(0, 256).toString('utf8');
  if (/NoSuchKey|AccessDenied|<!doctype\s+html|<html\b/i.test(prefix)) {
    throw new Error('media returned an upstream error document');
  }
  return { status: res.status, bytes: first.value.byteLength };
}

function hlsAudioRefs(text) {
  const refs = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^#EXT-X-MEDIA:/i.test(line.trim()) || !/TYPE=AUDIO\b/i.test(line)) continue;
    const uri = line.match(/\bURI="([^"]+)"/i)?.[1];
    if (uri) refs.push(uri);
  }
  return [...new Set(refs)];
}

function hlsFirstVariantRef(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF\b/i.test(lines[i].trim())) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (!candidate.startsWith('#')) return candidate;
      break;
    }
  }
  return null;
}

function hlsFirstSegmentRef(text) {
  const lines = text.split(/\r?\n/);
  let sawSegment = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#EXTINF\b/i.test(line)) {
      sawSegment = true;
      continue;
    }
    if (sawSegment && line && !line.startsWith('#')) return line;
  }
  return null;
}

async function auditHls(url, checks, depth = 0) {
  if (depth > 3) throw new Error('HLS playlist nesting exceeded safe depth');
  const text = await fetchManifest(url);
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('invalid HLS manifest');

  const variant = hlsFirstVariantRef(text);
  const audioRefs = hlsAudioRefs(text);
  if (variant || audioRefs.length) {
    const childRefs = [...new Set([variant, ...audioRefs].filter(Boolean))];
    for (const ref of childRefs) {
      const childUrl = new URL(ref, url).toString();
      const isAudio = depth === 0 && audioRefs.includes(ref);
      try {
        await auditHls(childUrl, checks, depth + 1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${isAudio ? 'audio playlist' : 'variant playlist'}: ${message}`);
      }
      checks.push(isAudio ? 'audio-playlist+segment' : 'variant+segment');
    }
    return;
  }

  if (!/#EXTINF\b|#EXT-X-MAP\b/i.test(text)) throw new Error('HLS leaf has no media');
  const map = text.match(/^#EXT-X-MAP:[^\n]*URI="([^"]+)"/im)?.[1];
  if (map) {
    await fetchMediaBytes(new URL(map, url).toString());
    checks.push('init-segment');
  }
  const segment = hlsFirstSegmentRef(text);
  if (!segment) throw new Error('HLS leaf has no segment URI');
  await fetchMediaBytes(new URL(segment, url).toString());
  checks.push('media-segment');
}

function firstDashRepresentationId(mpd) {
  return mpd.match(/<Representation\b[^>]*\bid="([^"]+)"/i)?.[1] || '';
}

function expandDashTemplate(template, mpd) {
  const representationId = firstDashRepresentationId(mpd);
  const bandwidth = mpd.match(/<Representation\b[^>]*\bbandwidth="(\d+)"/i)?.[1] || '0';
  const startNumber = Number(
    mpd.match(/<SegmentTemplate\b[^>]*\bstartNumber="(\d+)"/i)?.[1] || 1,
  );
  return xmlUnescape(template)
    .replace(/\$\$/g, '\u0000')
    .replace(/\$RepresentationID\$/g, representationId)
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (_m, width) =>
      width ? String(startNumber).padStart(Number(width), '0') : String(startNumber),
    )
    .replace(/\$Time\$/g, '0')
    .replace(/\$Bandwidth\$/g, bandwidth)
    .replace(/\u0000/g, '$');
}

async function auditDash(url, checks) {
  const mpd = await fetchManifest(url);
  if (!mpd.trimStart().includes('<MPD')) throw new Error('invalid DASH manifest');

  const template = mpd.match(/<SegmentTemplate\b[^>]*\bmedia="([^"]+)"/i)?.[1];
  if (template) {
    const expanded = expandDashTemplate(template, mpd);
    if (expanded.includes('$')) throw new Error('unsupported DASH template placeholder');
    await fetchMediaBytes(new URL(expanded, url).toString());
    checks.push('dash-template-segment');
    return;
  }

  const segmentUrl = mpd.match(/<SegmentURL\b[^>]*\bmedia="([^"]+)"/i)?.[1];
  if (segmentUrl) {
    await fetchMediaBytes(new URL(xmlUnescape(segmentUrl), url).toString());
    checks.push('dash-segment-list');
    return;
  }

  // A BaseURL is only a base directory when templates/lists are present. Fetch it
  // directly only for single-file DASH representations.
  const baseUrl = mpd.match(/<BaseURL>([^<]+)<\/BaseURL>/i)?.[1];
  if (baseUrl?.trim()) {
    await fetchMediaBytes(new URL(xmlUnescape(baseUrl.trim()), url).toString());
    checks.push('dash-base-url');
    return;
  }

  throw new Error('DASH manifest has no testable media reference');
}

async function auditOption(option) {
  const checks = [];
  if (option.type === 'hls') {
    await auditHls(new URL(option.url, apiBase).toString(), checks);
  } else if (option.type === 'dash') {
    await auditDash(new URL(option.url, apiBase).toString(), checks);
  } else {
    await fetchMediaBytes(new URL(option.url, apiBase).toString());
    checks.push('mp4-bytes');
  }
  return checks;
}

async function resolveSource(sourceId) {
  const playbackUrl = `${apiBase}/api/v1/playback?type=tv&tmdb=${TMDB_ID}&s=${SEASON}&e=${EPISODE}&source=${sourceId}`;
  const res = await fetchWithTimeout(playbackUrl);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.ok || !Array.isArray(payload.sources) || !payload.sources.length) {
    throw new Error(`${sourceId} resolution failed (${res.status})`);
  }
  return payload.sources;
}

const report = [];
let failed = 0;
try {
  for (const sourceId of ['source-1', 'source-2']) {
    try {
      const options = await resolveSource(sourceId);
      console.log(`[audit] ${sourceId}: ${options.length} advertised option(s)`);
      for (const option of options) {
        try {
          const checks = await auditOption(option);
          report.push({ id: option.id, label: option.label, type: option.type, ok: true, checks });
          console.log(`[pass] ${option.id} ${option.label}: ${checks.join(', ')}`);
        } catch (error) {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          report.push({ id: option.id, label: option.label, type: option.type, ok: false, error: message });
          console.error(`[fail] ${option.id} ${option.label}: ${message}`);
        }
      }
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      report.push({ id: sourceId, ok: false, error: message });
      console.error(`[fail] ${message}`);
    }
  }
} finally {
  server.close();
}

console.log('[audit-summary] ' + JSON.stringify({
  title: 'Re:Zero S1E1',
  tmdb: TMDB_ID,
  passed: report.filter((row) => row.ok).length,
  failed,
  report,
}));

if (failed > 0 || !report.some((row) => row.ok)) process.exitCode = 1;
