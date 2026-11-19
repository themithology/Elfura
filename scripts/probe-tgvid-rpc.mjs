#!/usr/bin/env node
/**
 * Dig TGVID's real API out of its server functions.
 *
 * The first probe concluded "TGVID is a vidsync front-end" from seeing only two
 * vidsync calls. That was too fast: TGVID is a TanStack Start app whose bundle
 * contains `createServerFn` and `routes-DAuqbz4c.js`, and the player said
 * "TG FINDER / Source 01" — a numbered source list. The vidsync calls were one
 * entry in that list, not the whole thing.
 *
 * So this probe:
 *   1. captures EVERY non-static request during playback, including POSTs and
 *      their bodies (server functions are POSTs),
 *   2. extracts server-function ids and RPC paths straight out of the bundle,
 *   3. probes TG FINDER directly, since it is named in the UI,
 *   4. reports every distinct source name it can find.
 *
 * Reports hosts, paths, statuses, shapes, counts and short body previews of the
 * RPC envelope only — never a stream URL or a long-lived token.
 */
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const BASE = (process.env.TGVID_BASE || 'https://tgvid.lovable.app').replace(/\/+$/, '');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[tgv2] ${t} :: ${v}`);

const STATIC = /\.(?:js|css|png|jpe?g|svg|woff2?|ico|webp|gif|map)(?:\?|$)/i;
const NOISE = /lovable\.(?:app|dev)|\.r2\.dev|discord|googleapis|gstatic|fonts\.|profitableratecpm|jsdelivr|unpkg|cloudflareinsights|doubleclick|googlesyndication/i;

async function get(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    return { status: res.status, text: await res.text(), ct: res.headers.get('content-type') || '' };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

// ------------------------------------------------- 1. mine the bundles ------
const root = await get(`${BASE}/`);
const refs = [...new Set([
  ...[...root.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]),
  ...[...root.text.matchAll(/["'](\/?assets\/[^"']+\.(?:js|mjs))["']/g)].map((m) => m[1]),
])];
const blobs = [];
for (const ref of refs.slice(0, 12)) {
  const url = ref.startsWith('http') ? ref : `${BASE}${ref.startsWith('/') ? '' : '/'}${ref}`;
  const r = await get(url);
  if (r.text) blobs.push({ ref, text: r.text });
  log('bundle', `${ref} HTTP ${r.status} bytes=${r.text.length}`);
}
const all = blobs.map((b) => b.text).join('\n');
log('js bytes', all.length);

// Server-function ids: TanStack encodes them as `createServerFn({...}).handler`
// with an id, or as `"/_serverFn/<hash>"` strings.
const fnIds = new Set();
for (const m of all.matchAll(/_serverFn\/([A-Za-z0-9_-]{4,40})/g)) fnIds.add(m[1]);
for (const m of all.matchAll(/createServerFn\s*\(\s*\{[^}]*?id\s*:\s*["']([^"']{2,60})["']/g)) fnIds.add(m[1]);
for (const m of all.matchAll(/["']([a-f0-9]{8,24})["']\s*,\s*(?:function|\()/g)) fnIds.add(m[1]);
log('server-fn ids', fnIds.size ? [...fnIds].slice(0, 25).join(' ') : 'none');

// Source / server names — the thing we want: "all sources".
const srcNames = new Set();
for (const m of all.matchAll(/\b(?:TG[\s_-]?(?:FINDER|VID|FROST|OUT|HUB)|HDARK|vidsync|vidbolt|vidrock|hianime|animekai|moviebox|tmdb|finder)\b/gi)) {
  srcNames.add(m[0].toLowerCase().replace(/[\s_-]+/g, ''));
}
log('source-name tokens', [...srcNames].join(', ') || 'none');

// Any api-ish path, whatever host.
const paths = new Set();
for (const m of all.matchAll(/["'`](\/(?:api|rpc|_server|_serverFn|f|v\d)\/[a-zA-Z0-9/_.${}-]{0,70})["'`]/g)) paths.add(m[1]);
log('api paths', paths.size);
for (const p of [...paths].slice(0, 40)) log('  path', p);

// Hosts referenced in code (excluding noise).
const hosts = new Set();
for (const m of all.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
  const h = m[1];
  if (!NOISE.test(h) && !/github|supabase\.co$/.test(h)) hosts.add(h);
}
log('candidate hosts', [...hosts].slice(0, 25).join(' ') || 'none');

// ------------------------------------- 2. capture every RPC during playback ---
const rpc = new Map();
const posts = [];
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: await chromiumBinary.executablePath(),
    args: [...chromiumBinary.args, '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ userAgent: UA });

  page.on('request', (req) => {
    const url = req.url();
    if (STATIC.test(url) || NOISE.test(url)) return;
    const method = req.method();
    if (method === 'POST') {
      const body = req.postData() || '';
      posts.push({ url, body: body.slice(0, 240) });
    }
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (STATIC.test(url) || NOISE.test(url)) return;
    let u;
    try { u = new URL(url); } catch { return; }
    const key = `${u.hostname}${u.pathname}`;
    const row = rpc.get(key) || { n: 0, status: res.status(), ct: (res.headers()['content-type'] || '').split(';')[0] };
    row.n += 1;
    rpc.set(key, row);

    const ct = row.ct;
    if (/json|text\/plain|octet-stream/.test(ct)) {
      try {
        const text = await res.text();
        if (text.length > 4 && text.length < 200_000) {
          log('  BODY', `${key} ${text.length}B ${text.slice(0, 150).replace(/\s+/g, ' ')}`);
        }
      } catch { /* gone */ }
    }
  });

  for (const route of ['/embed/movie/550', '/embed/tv/1399/1/1']) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(14_000);
      const ui = await page.evaluate(() =>
        document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 160) || '',
      ).catch(() => '');
      log('page', `${route} ui="${ui}"`);
    } catch (e) {
      log('page', `${route} ERR ${e.name}`);
    }
  }
} catch (e) {
  log('browser', `ERR ${e.name}`);
} finally {
  await browser?.close().catch(() => {});
}

log('rpc endpoints', rpc.size);
for (const [k, v] of [...rpc].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) {
  log('  rpc', `${k} n=${v.n} status=${v.status} ct=${v.ct}`);
}
log('POSTs', posts.length);
for (const p of posts.slice(0, 15)) log('  post', `${p.url.slice(0, 110)} body=${p.body.slice(0, 90)}`);

// ------------------------------------------- 3. TG FINDER, directly ----------
for (const [label, url] of [
  ['finder:root', 'https://tgfinder.lovable.app/'],
  ['finder:api', 'https://tgfinder.lovable.app/api/broadcast'],
]) {
  const r = await get(url);
  log(label, r.error ? `ERR ${r.error}` : `HTTP ${r.status} bytes=${r.text.length} :: ${r.text.slice(0, 90).replace(/\s+/g, ' ')}`);
}

console.log('[tgv2:done]');
