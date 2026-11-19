#!/usr/bin/env node
/**
 * Direct probe for the two upstreams whose API shapes we could not verify from
 * the build sandbox: vidbolt (`/api/resolve`) and vidsync (`/api/core/*`).
 *
 * Why this exists: the sandbox has no egress to either provider, and `fetch_page`
 * cannot set request headers — and both providers gate on headers. VidBolt's own
 * docs say the player only runs inside an iframe ("opening the same URL in a new
 * tab won't play"), so a header-less probe 404s even for their own featured
 * example. That makes "404" worthless as evidence, which is exactly how a
 * working lane gets written off as dead.
 *
 * This runs on a GitHub runner (real IP, real fetch) via diagnose-compare.yml and
 * prints only status codes, shapes and counts. Never tokens, never stream URLs.
 *
 *   node scripts/probe-vidbolt-vidsync.mjs
 */
import dns from 'node:dns';

try {
  if (process.env.ELFURA_DNS_ORDER !== 'verbatim') dns.setDefaultResultOrder('ipv4first');
} catch {
  /* older runtimes */
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const log = (title, value) => console.log(`[probe] ${title} :: ${value}`);

/** Parse just enough to report a shape without leaking a URL. */
function shape(text) {
  const out = { bytes: text.length, head: text.slice(0, 40).replace(/\s+/g, ' ') };
  try {
    const json = JSON.parse(text);
    out.json = true;
    out.keys = Object.keys(json).join(',');
    const srcs = json?.stream?.sources;
    if (Array.isArray(srcs)) {
      out.streamSources = srcs.length;
      out.sourceKeys = srcs[0] && typeof srcs[0] === 'object' ? Object.keys(srcs[0]).join(',') : '';
      // A manifest-shaped string is proof the lane can produce a candidate.
      out.sourceHasUrl = typeof srcs[0]?.url === 'string';
      out.sourceHost = (() => {
        try {
          return new URL(srcs[0].url).hostname;
        } catch {
          return '';
        }
      })();
    }
    if (Array.isArray(json?.sources)) {
      out.topSources = json.sources.length;
      out.rowKeys = json.sources[0] && typeof json.sources[0] === 'object' ? Object.keys(json.sources[0]).join(',') : '';
      out.rowHasUrl = typeof json.sources[0]?.url === 'string';
      out.rowHost = (() => {
        try {
          return new URL(json.sources[0].url).hostname;
        } catch {
          return '';
        }
      })();
      out.langs = [...new Set(json.sources.map((s) => s?.audioLanguage || s?.language).filter(Boolean))].slice(0, 8);
    }
    if (Array.isArray(json?.seasons)) out.seasons = json.seasons.length;
    if (Array.isArray(json?.episodes)) out.episodes = json.episodes.length;
  } catch {
    out.json = false;
    out.extm3u = text.trimStart().startsWith('#EXTM3U');
  }
  return JSON.stringify(out);
}

async function get(label, url, headers) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    log(label, `HTTP ${res.status} ${Date.now() - started}ms ${shape(text)}`);
    return { status: res.status, text };
  } catch (error) {
    log(label, `ERR ${error.name} ${Date.now() - started}ms`);
    return { status: 0, text: '' };
  }
}

// ---------------------------------------------------------------- vidbolt ----
// TV id that exists on TMDB: Game of Thrones (1399) S1E1 — also VidBolt's own
// documented TV example. Movie: 1007757, the id their landing page embeds.
const vb = 'https://vidbolt.xyz';
const vbMovieRef = `${vb}/movie/1007757`;
const vbTvRef = `${vb}/tv/1399/1/1`;

for (const [label, url, referer] of [
  ['vidbolt:title-page(movie)', vbMovieRef, `${vb}/`],
  ['vidbolt:title-page(tv)', vbTvRef, `${vb}/`],
  [
    'vidbolt:resolve(movie,proof-params)',
    `${vb}/api/resolve?type=movie&id=1007757`,
    vbMovieRef,
  ],
  [
    'vidbolt:resolve(movie,our-old-params)',
    `${vb}/api/resolve?type=movie&id=1007757&only=orion&hevc=0`,
    vbMovieRef,
  ],
  [
    'vidbolt:resolve(tv,proof-params)',
    `${vb}/api/resolve?type=tv&id=1399&season=1&episode=1`,
    vbTvRef,
  ],
  ['vidbolt:episodes', `${vb}/api/episodes?id=1399&season=1`, vbTvRef],
]) {
  await get(label, url, {
    'User-Agent': UA,
    Accept: 'application/json, */*',
    Referer: referer,
    Origin: vb,
  });
}

// ---------------------------------------------------------------- vidsync ----
// vidsync documents only /embed/*. The two JSON routes below are what other
// players call; both were 404 from a header-less probe.
const vs = 'https://vidsync.pro';
const vsRef = `${vs}/embed/movie/550`;
for (const [label, url] of [
  ['vidsync:embed(movie)', `${vs}/embed/movie/550`],
  ['vidsync:core/streams', `${vs}/api/core/streams?type=movie&id=550`],
  ['vidsync:core/streams(tv)', `${vs}/api/core/streams?type=tv&id=1399&season=1&episode=1`],
  ['vidsync:stream(legacy)', `${vs}/api/stream?type=movie&id=550`],
  // The documented proxy wrapper: `data` is URL-encoded JSON naming a raw file.
  [
    'vidsync:core/proxy(shape)',
    `${vs}/api/core/proxy?data=${encodeURIComponent(JSON.stringify({ url: `${vs}/`, headers: {} }))}`,
  ],
]) {
  await get(label, url, {
    'User-Agent': UA,
    Accept: 'application/json, */*',
    Referer: vsRef,
    Origin: vs,
  });
}

console.log('[probe:done]');
