#!/usr/bin/env node
/**
 * Measure every candidate lane from a machine that can actually reach them.
 *
 * This answers three questions per lane, in the only order that matters:
 *
 *   1. reachable?     does the origin answer at all (DNS/TLS/HTTP status/time)
 *   2. discovery?     does a plain HTTP request yield media, or is the page JS-only
 *   3. playable?      do the media bytes actually come back, HLS manifest and a
 *                     real segment, with the headers an adapter would send
 *
 * The output is JSON (and a compact table), meant to be committed as evidence
 * next to the adapters it justifies. A lane that is not measured here does not
 * go on the board — that rule is the whole reason the last board was retired.
 *
 * Usage:
 *   node scripts/research/measure.mjs                 # all lanes, all titles
 *   node scripts/research/measure.mjs --lane=vixsrc   # one lane
 *   node scripts/research/measure.mjs --browser       # also drive Chromium
 *   node scripts/research/measure.mjs --headed        # watch it (local only)
 *
 * Browser mode needs playwright-core + @sparticuz/chromium, which the research
 * workflow installs on the runner. Without them the HTTP results still print,
 * and lanes that need a page are reported as `needs-browser` rather than
 * silently failing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LANES, TITLES, lanesFor, base } from './lanes.mjs';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const LANE_FILTER = arg('lane');
const WITH_BROWSER = flag('browser') || flag('headed');
const HEADED = flag('headed');
const OUT = arg('out', 'research/measurements.json');
const TIMEOUT_MS = Number(arg('timeout', '15000'));

const MEDIA_RE = /\.(m3u8|mpd|mp4)(?:[?#]|$)/i;
const HLS_RE = /\.m3u8(?:[?#]|$)/i;
const DASH_RE = /\.mpd(?:[?#]|$)/i;
const HTML_START = /^\s*<(?:!doctype|html|head|body)/i;

const now = () => Date.now();
const short = (v, n = 120) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);

/** One request with a hard timeout, never following a redirect to a new host blindly. */
async function request(url, headers, { redirect = 'follow', range } = {}) {
  const started = now();
  try {
    const response = await fetch(url, {
      headers: { ...headers, ...(range ? { Range: range } : {}) },
      redirect,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const contentType = response.headers.get('content-type') ?? '';
    return { ok: response.ok, status: response.status, contentType, ms: now() - started, response };
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || error?.name || 'error';
    return { ok: false, status: 0, contentType: '', ms: now() - started, error: String(error?.message ?? error), cause };
  }
}

async function bodyText(response, max = 4_000_000) {
  if (!response?.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) break;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Pull anything that looks like a media URL out of JSON or HTML. */
function findMedia(text) {
  const out = new Set();
  // Absolute URLs first.
  for (const m of text.matchAll(/https?:\\?\/\\?\/[^"'\s<>()\\]+?\.(?:m3u8|mpd|mp4)(?:\?[^"'\s<>()\\]*)?/gi)) {
    out.add(m[0].replace(/\\\//g, '/'));
  }
  // Root-relative playlists, which every one of these players uses.
  for (const m of text.matchAll(/["'](\/(?!\/)[^"'\s<>]{2,300}?\.(?:m3u8|mpd|mp4)(?:\?[^"']*)?)["']/gi)) {
    out.add(m[1].replace(/\\\//g, '/'));
  }
  return [...out].slice(0, 8);
}

/** Follow a playlist one hop: master → variant, variant → first segment. */
async function provePlayable(mediaUrl, headers, origin) {
  const absolute = mediaUrl.startsWith('http') ? mediaUrl : new URL(mediaUrl, origin).href;
  const result = { url: short(absolute, 200), steps: [] };

  if (/\.mp4(?:[?#]|$)/i.test(absolute)) {
    const head = await request(absolute, headers, { range: 'bytes=0-131071' });
    result.steps.push({ kind: 'mp4', status: head.status, contentType: head.contentType, ms: head.ms, error: head.error });
    if (head.response) {
      const buf = Buffer.from(await head.response.arrayBuffer());
      await head.response.body?.cancel().catch(() => {});
      result.bytes = buf.length;
      result.contentType = head.contentType;
      result.ok = buf.length > 0 && (head.status === 200 || head.status === 206);
    }
    return result;
  }

  const manifest = await request(absolute, headers);
  const text = await bodyText(manifest.response, 1_000_000);
  result.steps.push({
    kind: 'manifest',
    status: manifest.status,
    contentType: manifest.contentType,
    ms: manifest.ms,
    bytes: text.length,
    error: manifest.error,
  });
  result.contentType = manifest.contentType;
  if (!manifest.ok || text.length === 0) return result;

  if (DASH_RE.test(absolute) || /<MPD/i.test(text)) {
    result.kind = 'dash';
    result.ok = /<MPD/i.test(text);
    return result;
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  result.kind = 'hls';
  result.encrypted = /#EXT-X-KEY:.*METHOD=(?!NONE)/i.test(text);
  const firstMedia = lines.find((l) => !l.startsWith('#'));
  if (!firstMedia) {
    result.ok = false;
    result.reason = 'manifest has no media or child playlists';
    return result;
  }

  const next = new URL(firstMedia, absolute).href;
  const childHeaders = { ...headers, Referer: absolute };
  if (HLS_RE.test(next)) {
    const child = await request(next, childHeaders);
    const childText = await bodyText(child.response, 1_000_000);
    result.steps.push({ kind: 'variant', status: child.status, ms: child.ms, bytes: childText.length, error: child.error });
    const segment = childText.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (!segment) {
      result.ok = child.ok && childText.length > 0;
      result.reason = child.ok ? 'variant had no segment line' : `variant ${child.status}`;
      return result;
    }
    const segUrl = new URL(segment, next).href;
    const seg = await request(segUrl, { ...childHeaders, Referer: next }, { range: 'bytes=0-262143' });
    const buf = seg.response ? Buffer.from(await seg.response.arrayBuffer()) : Buffer.alloc(0);
    await seg.response?.body?.cancel().catch(() => {});
    result.steps.push({ kind: 'segment', status: seg.status, ms: seg.ms, bytes: buf.length, contentType: seg.contentType, error: seg.error });
    result.bytes = buf.length;
    result.segmentContentType = seg.contentType;
    // A provider that answers 200 with an HTML page is not serving video.
    result.ok = buf.length > 0 && (seg.status === 200 || seg.status === 206) && !/text\/html/i.test(seg.contentType);
    return result;
  }

  const seg = await request(next, childHeaders, { range: 'bytes=0-262143' });
  const buf = seg.response ? Buffer.from(await seg.response.arrayBuffer()) : Buffer.alloc(0);
  await seg.response?.body?.cancel().catch(() => {});
  result.steps.push({ kind: 'segment', status: seg.status, ms: seg.ms, bytes: buf.length, contentType: seg.contentType, error: seg.error });
  result.bytes = buf.length;
  result.ok = buf.length > 0 && (seg.status === 200 || seg.status === 206);
  return result;
}

/* ── plain HTTP measurement ───────────────────────────────────────────────── */

async function measureHttp(lane, title) {
  const row = { lane: lane.id, title: title.key, method: 'http', kind: lane.kind, need: lane.need, requests: [] };
  const attempts = lane.attempts(title);
  if (attempts.length === 0) {
    row.result = 'needs-browser';
    row.why = 'no HTTP discovery path recorded for this lane';
    return row;
  }

  for (const attempt of attempts) {
    const r = await request(attempt.url, attempt.headers);
    const text = r.response ? await bodyText(r.response) : '';
    const media = text ? findMedia(text) : [];
    const entry = {
      url: short(attempt.url, 220),
      status: r.status,
      ms: r.ms,
      contentType: r.contentType,
      bytes: text.length,
      media: media.slice(0, 3),
      error: r.error,
      cause: r.cause,
    };
    row.requests.push(entry);
    if (!r.ok) continue;

    if (media.length > 0) {
      row.result = 'media-found';
      row.proof = await provePlayable(media[0], attempt.headers, base(attempt.url) || attempt.url);
      row.headersSeen = Object.fromEntries(
        ['server', 'cf-ray', 'content-type', 'access-control-allow-origin'].map((k) => [k, r.response.headers.get(k)]),
      );
      return row;
    }
    if (!HTML_START.test(text)) {
      row.result = 'json-no-media';
      row.preview = short(text.replace(/\s+/g, ' '), 300);
      return row;
    }
    row.result = 'html-no-media';
    row.preview = short(text.replace(/\s+/g, ' '), 300);
  }
  if (!row.result) row.result = row.requests.some((r) => r.status === 0) ? 'unreachable' : 'no-media-in-html';
  return row;
}

/* ── browser measurement ──────────────────────────────────────────────────── */

async function loadBrowser() {
  try {
    const { chromium } = await import('playwright-core');
    let executablePath;
    try {
      const mod = await import('@sparticuz/chromium');
      const chromiumBinary = mod.default ?? mod;
      executablePath = await chromiumBinary.executablePath();
      var args = chromiumBinary.args;
    } catch {
      /* a locally installed playwright with its own browser */
    }
    return { chromium, executablePath, args };
  } catch {
    return null;
  }
}

async function measureBrowser(browserKit, lane, title) {
  const url = lane.browser?.(title);
  const row = { lane: lane.id, title: title.key, method: 'browser', kind: lane.kind, requests: [] };
  if (!url) {
    row.result = 'not-applicable';
    return row;
  }

  const browser = await browserKit.chromium.launch({
    executablePath: browserKit.executablePath,
    args: [...(browserKit.args ?? []), '--autoplay-policy=no-user-gesture-required'],
    headless: !HEADED,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const started = now();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    row.requests.push({ url: short(url, 220), status: response?.status() ?? 0, ms: now() - started });
    row.finalUrl = short(page.url(), 200);

    // Media is usually requested shortly after the page's own JS runs.
    const found = [];
    const onResponse = (res) => {
      const u = res.url();
      if (MEDIA_RE.test(u)) found.push(u);
    };
    page.on('response', onResponse);

    // Nudge playback: many embeds only load the playlist after a click.
    await page
      .evaluate(() => {
        const btn = document.querySelector('button, .play, [class*=play], video') ?? null;
        if (btn && btn.click) btn.click();
      })
      .catch(() => {});
    await page.waitForTimeout(12_000);
    page.off('response', onResponse);

    // The page's own JS state is often the only place the URL lives.
    const inPage = await page
      .evaluate(() => {
        const hits = [];
        const push = (v) => {
          if (typeof v === 'string' && /\.(m3u8|mpd|mp4)(\?|$)/i.test(v)) hits.push(v);
        };
        try {
          const video = document.querySelector('video');
          if (video) push(video.currentSrc || video.src);
          for (const el of document.querySelectorAll('source')) push(el.src);
        } catch {}
        try {
          for (const k of Object.keys(window)) {
            try {
              push(window[k]);
            } catch {}
          }
        } catch {}
        return hits;
      })
      .catch(() => []);

    const mediaUrls = [...new Set([...found, ...inPage])];
    row.pageMedia = mediaUrls.slice(0, 6).map((u) => short(u, 200));

    if (mediaUrls.length === 0) {
      // Say what the page actually is, so a false negative is recognisable.
      const title_ = await page.title().catch(() => '');
      const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      row.result = 'no-media-in-page';
      row.pageTitle = short(title_, 120);
      row.pageText = short(text.replace(/\s+/g, ' '), 220);
      return row;
    }

    // Measure the media with the page's own cookies (some are session-bound).
    const cookies = await context.cookies(mediaUrls[0]).catch(() => []);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    row.proof = await provePlayable(mediaUrls[0], {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      Referer: page.url(),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    });
    row.result = row.proof?.ok ? 'playable' : 'media-found-not-playable';
    return row;
  } catch (error) {
    row.result = 'browser-error';
    row.error = String(error?.message ?? error).slice(0, 200);
    return row;
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ── main ─────────────────────────────────────────────────────────────────── */

const lanes = LANE_FILTER ? LANES.filter((l) => l.id === LANE_FILTER) : LANES;
if (lanes.length === 0) {
  console.error(`no lane named "${LANE_FILTER}"`);
  process.exit(2);
}

let browserKit = null;
if (WITH_BROWSER) {
  browserKit = await loadBrowser();
  if (!browserKit) {
    console.warn('[measure] playwright-core/@sparticuz/chromium not installed — browser rows will be skipped');
    console.warn('[measure] npm install --no-save --no-package-lock playwright-core @sparticuz/chromium');
  }
}

const results = [];
const pad = (v, n) => String(v ?? '').padEnd(n);
console.log(`\n${pad('lane', 18)}${pad('title', 18)}${pad('method', 9)}${pad('result', 24)}detail`);

for (const lane of lanes) {
  for (const title of TITLES) {
    if (lane.animeOnly && !title.anilistId) continue;
    if (!lanesFor(title).includes(lane)) continue;

    const http = await measureHttp(lane, title);
    results.push({ ...http, laneLabel: lane.label, origin: lane.origin, note: lane.note });
    const p = http.proof;
    console.log(
      `${pad(lane.id, 18)}${pad(title.key, 18)}${pad('http', 9)}${pad(http.result, 24)}${
        p ? `${p.ok ? 'playable' : 'not-playable'} ${p.contentType ?? ''} ${p.bytes ?? ''}B ${p.reason ?? ''}` : http.why ?? http.cause ?? ''
      }`,
    );

    // Only pay for a browser when the HTTP path could not answer.
    const needsBrowser = browserKit && lane.browser && http.result !== 'media-found';
    if (needsBrowser) {
      const b = await measureBrowser(browserKit, lane, title);
      results.push({ ...b, laneLabel: lane.label, origin: lane.origin, note: lane.note });
      console.log(
        `${pad(lane.id, 18)}${pad(title.key, 18)}${pad('browser', 9)}${pad(b.result, 24)}${
          b.proof ? `${b.proof.ok ? 'playable' : 'not-playable'} ${b.bytes ?? b.proof.bytes ?? ''}B` : b.error ?? b.pageText ?? ''
        }`,
      );
    } else if (!browserKit && lane.browser && http.result !== 'media-found') {
      results.push({ lane: lane.id, laneLabel: lane.label, title: title.key, method: 'browser', result: 'skipped', why: 'browser not installed' });
      console.log(`${pad(lane.id, 18)}${pad(title.key, 18)}${pad('browser', 9)}${pad('skipped', 24)}browser not installed`);
    }
  }
}

/* ── summary ──────────────────────────────────────────────────────────────── */

const byLane = new Map();
for (const row of results) {
  const entry = byLane.get(row.lane) ?? { lane: row.lane, label: row.laneLabel, attempts: 0, playable: 0, media: 0, results: new Set() };
  entry.attempts += 1;
  entry.results.add(row.result);
  if (row.proof?.ok) entry.playable += 1;
  if (row.result === 'media-found' || row.result === 'playable') entry.media += 1;
  byLane.set(row.lane, entry);
}

console.log('\n── summary ─────────────────────────────────────────────────────────────');
console.log(`${pad('lane', 18)}${pad('playable', 10)}${pad('media', 8)}outcomes`);
const summary = [];
for (const e of byLane.values()) {
  summary.push({
    lane: e.lane,
    label: e.label,
    attempts: e.attempts,
    playable: e.playable,
    media: e.media,
    outcomes: [...e.results].sort(),
  });
  console.log(`${pad(e.lane, 18)}${pad(`${e.playable}/${e.attempts}`, 10)}${pad(`${e.media}/${e.attempts}`, 8)}${[...e.results].sort().join(', ')}`);
}

/**
 * A machine-readable block printed to the log.
 *
 * Results have to survive a host that cannot fetch workflow artifacts or logs
 * (this sandbox downloads both as EOF). A marker line in the transcript is
 * readable from the run itself, so the numbers are never trapped on the runner.
 */
const MARKER = 'ELFURA-MEASURE-JSON:';
console.log(`\n${MARKER}${JSON.stringify({ measuredAt: new Date().toISOString(), summary, rows: results.length })}`);

const payload = {
  measuredAt: new Date().toISOString(),
  node: process.version,
  undici: process.versions.undici,
  browser: browserKit ? 'playwright-core + @sparticuz/chromium' : 'none',
  titles: TITLES,
  summary,
  results,
};

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\n[measure] wrote ${OUT} (${results.length} rows)`);

const anyPlayable = summary.some((s) => s.playable > 0);
if (!anyPlayable) {
  console.error(
    '\n[measure] NO lane produced playable bytes. Before blaming the providers, check whether this machine can reach ' +
      'them at all: a sandbox that resets provider TLS will make every lane look dead (see research/measurements.md).',
  );
  process.exit(1);
}
