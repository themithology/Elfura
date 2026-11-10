/**
 * Live Re:Zero source acceptance audit (manual/CI only).
 *
 * Runs against real upstreams through the real uniform backend and relay.
 * Never prints upstream URLs, headers, signed tickets, or provider identifiers.
 * Every advertised option must yield recognizable media bytes. Language metadata is not audible-language verification.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createBackendServer } from '../../dist/backend/index.js';

const AUDIT_LANG = process.env.AUDIT_LANG || '';
const EXPECT_LANG = process.env.AUDIT_EXPECT_LANG || '';
const TMDB_ID = process.env.AUDIT_TMDB || '65942';
const TYPE = (process.env.AUDIT_TYPE || 'tv').trim().toLowerCase() === 'movie' ? 'movie' : 'tv';
const SEASON = process.env.AUDIT_SEASON || '1';
const EPISODE = process.env.AUDIT_EPISODE || '1';
const TITLE_LABEL = process.env.AUDIT_TITLE || 'Re:Zero S1E1';
const AUDIT_SOURCES = (process.env.AUDIT_SOURCES || 'source-1,source-2,source-3')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
/** Hard speed budget for one /api/v1/playback resolution (0 = disabled). */
const MAX_RESOLVE_MS = Math.max(0, Number(process.env.AUDIT_MAX_RESOLVE_MS || 0));
/** Fail unless at least one advertised option carries real multi-language evidence. */
const REQUIRE_MULTI_LANG = process.env.AUDIT_REQUIRE_MULTI_LANG === '1';
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

const TRANSIENT_HTTP = new Set([429, 502, 503, 504]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchManifest(url, attempt = 0) {
  const res = await fetchWithTimeout(url);
  const text = await res.text();
  if (!res.ok && TRANSIENT_HTTP.has(res.status) && attempt < 1) {
    await delay(1500);
    return fetchManifest(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) throw new Error('manifest returned HTML');
  return text;
}

async function fetchMediaBytes(url, attempt = 0) {
  const res = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-1023' } });
  if (!(res.status === 200 || res.status === 206) && TRANSIENT_HTTP.has(res.status) && attempt < 1) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    await delay(1500);
    return fetchMediaBytes(url, attempt + 1);
  }
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
  const bytes = Buffer.from(first.value);
  const box = bytes.subarray(4, 8).toString('ascii');
  const recognizable = bytes[0] === 0x47 || ['ftyp', 'styp', 'moof', 'mdat', 'sidx'].includes(box) || bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!recognizable) throw new Error('unrecognized media bytes');
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

async function auditHls(url, checks, depth = 0, stats = { audioTracks: 0 }) {
  if (depth > 3) throw new Error('HLS playlist nesting exceeded safe depth');
  const text = await fetchManifest(url);
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('invalid HLS manifest');

  const variant = hlsFirstVariantRef(text);
  const audioRefs = hlsAudioRefs(text);
  if (depth === 0) stats.audioTracks = Math.max(stats.audioTracks, audioRefs.length);
  if (variant || audioRefs.length) {
    const childRefs = [...new Set([variant, ...audioRefs].filter(Boolean))];
    for (const ref of childRefs) {
      const childUrl = new URL(ref, url).toString();
      const isAudio = depth === 0 && audioRefs.includes(ref);
      try {
        await auditHls(childUrl, checks, depth + 1, stats);
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

async function auditDash(url, checks, stats = { audioTracks: 0 }) {
  const mpd = await fetchManifest(url);
  if (!mpd.trimStart().includes('<MPD')) throw new Error('invalid DASH manifest');
  const audioSets = mpd.match(/<AdaptationSet\b[^>]*?(?:contentType|mimeType)="[^"]*audio[^"]*"[^>]*>/gi) || [];
  stats.audioTracks = Math.max(stats.audioTracks, audioSets.length);

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
  const stats = { audioTracks: 0 };
  if (option.type === 'hls') {
    await auditHls(new URL(option.url, apiBase).toString(), checks, 0, stats);
  } else if (option.type === 'dash') {
    await auditDash(new URL(option.url, apiBase).toString(), checks, stats);
  } else {
    await fetchMediaBytes(new URL(option.url, apiBase).toString());
    checks.push('mp4-bytes');
  }
  return { checks, audioTracks: stats.audioTracks };
}

/** Emit a GitHub Actions annotation so CI failure reasons are visible via API. */
function annotate(level, title, message) {
  const clean = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${level} title=${title}::${clean}`);
}

async function resolveSource(sourceId) {
  const seasonQuery = TYPE === 'tv' ? `&s=${SEASON}&e=${EPISODE}` : '';
  // 'combined' = the real user path: no source filter, both adapters race.
  const sourceQuery = sourceId === 'combined' ? '' : `&source=${sourceId}`;
  const playbackUrl = `${apiBase}/api/v1/playback?type=${TYPE}&tmdb=${TMDB_ID}${seasonQuery}${sourceQuery}${AUDIT_LANG ? `&lang=${encodeURIComponent(AUDIT_LANG)}` : ''}`;
  const t0 = performance.now();
  const res = await fetchWithTimeout(playbackUrl);
  const resolveMs = Math.round(performance.now() - t0);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.ok || !Array.isArray(payload.sources) || !payload.sources.length) {
    throw new Error(`${sourceId} resolution failed (${res.status})`);
  }
  console.log(`[resolve] ${sourceId}: ${payload.sources.length} option(s) in ${resolveMs}ms`);
  annotate('notice', 'ElfuraResolve', `${TITLE_LABEL} ${sourceId}: ${resolveMs}ms, ${payload.sources.length} option(s), multiLang=${hasMultiLangEvidence(payload.sources)}`);
  if (MAX_RESOLVE_MS > 0 && resolveMs > MAX_RESOLVE_MS) {
    throw new Error(`${sourceId} resolution too slow: ${resolveMs}ms > ${MAX_RESOLVE_MS}ms budget`);
  }
  return payload.sources;
}

function hasMultiLangEvidence(options) {
  const distinctSingle = new Set();
  for (const o of options) {
    if (Array.isArray(o.availableAudioLangs) && o.availableAudioLangs.length > 1) return true;
    if (o.multiAudio && Array.isArray(o.availableAudioLangs) && o.availableAudioLangs.length) return true;
    if (o.audioLang && o.audioLang !== 'und') distinctSingle.add(o.audioLang.split('-')[0]);
    if (Array.isArray(o.audioTracks) && o.audioTracks.length > 1) return true;
  }
  return distinctSingle.size > 1;
}

const report = [];
let failed = 0;
/** Same physical stream reappears in per-source and combined responses; audit once. */
const auditCache = new Map();
function auditOptionCached(option) {
  const key = `${option.fingerprint || option.id}:${option.type}`;
  if (!auditCache.has(key)) auditCache.set(key, auditOption(option));
  return auditCache.get(key);
}
try {
  for (const sourceId of AUDIT_SOURCES) {
    try {
      const options = await resolveSource(sourceId);
      console.log(`[audit] ${sourceId}: ${options.length} advertised option(s)`);
      if (EXPECT_LANG && !options.some(o => o.audioLang === EXPECT_LANG || o.availableAudioLangs?.includes(EXPECT_LANG))) throw new Error(`expected ${EXPECT_LANG} option missing`);
      let manifestAudioTracks = 0;
      for (const option of options) {
        try {
          const { checks, audioTracks } = await auditOptionCached(option);
          manifestAudioTracks = Math.max(manifestAudioTracks, audioTracks);
          report.push({ id: option.id, label: option.label, type: option.type, ok: true, checks, audioTracks });
          console.log(`[pass] ${option.id} ${option.label}: ${checks.join(', ')}`);
          annotate('notice', 'ElfuraOption', `${TITLE_LABEL} ${option.id} "${option.label}" type=${option.type} quality=${option.quality || 'auto'} audioLang=${option.audioLang || '-'} langs=[${(option.availableAudioLangs || []).join(',')}] multi=${!!option.multiAudio} manifestAudio=${audioTracks} checks=${checks.join('+')}`);
        } catch (error) {
          failed++;
          const message = error instanceof Error ? error.message : String(error);
          report.push({ id: option.id, label: option.label, type: option.type, ok: false, error: message });
          console.error(`[fail] ${option.id} ${option.label}: ${message}`);
          annotate('error', 'ElfuraVerify', `${TITLE_LABEL} ${option.id} ${option.label}: ${message}`);
        }
      }
      // Multi-language gate accepts manifest-proven evidence (real audio
      // tracks fetched above), not only provider-claimed metadata fields.
      // It is enforced on the combined (real user) response when present:
      // multi-language is a catalogue-level property of the full option set,
      // not a claim every individual adapter must satisfy for every title.
      const multiLangVerified = manifestAudioTracks > 1;
      annotate('notice', 'ElfuraMultiLang', `${TITLE_LABEL} ${sourceId}: manifestAudioTracks=${manifestAudioTracks}, metadataEvidence=${hasMultiLangEvidence(options)}`);
      const gateApplies = sourceId === 'combined' || !AUDIT_SOURCES.includes('combined');
      if (REQUIRE_MULTI_LANG && gateApplies && !multiLangVerified) {
        failed++;
        report.push({ id: sourceId, ok: false, error: 'no manifest evidence of multiple audio tracks' });
        console.error(`[fail] ${sourceId}: no manifest evidence of multiple audio tracks`);
      }
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      report.push({ id: sourceId, ok: false, error: message });
      console.error(`[fail] ${message}`);
      annotate('error', 'ElfuraVerify', `${TITLE_LABEL} ${sourceId}: ${message}`);
    }
  }
} finally {
  server.close();
}

console.log('[audit-summary] ' + JSON.stringify({
  title: TITLE_LABEL,
  type: TYPE,
  tmdb: TMDB_ID,
  passed: report.filter((row) => row.ok).length,
  failed,
  report,
}));

if (failed > 0 || !report.some((row) => row.ok)) process.exitCode = 1;
