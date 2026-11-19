#!/usr/bin/env node
/**
 * Dissect tgvid.lovable.app.
 *
 * The operator reports it exposes several sources of its own. The question that
 * decides everything is whether it has a JSON API we can call, or only a player
 * we would have to render:
 *
 *   a JSON API   -> a real adapter, cheap, deterministic, no browser.
 *   a player     -> either render it (fragile, as TG FROST proved when it
 *                   started serving a block page mid-session) or skip it.
 *
 * So this does both: mine the shell/bundles for endpoints the way the TG FROST
 * dissection did, AND watch a real browser's network for the JSON calls the
 * player itself makes. A player must call something to get a stream list; that
 * call is the API, whether or not it is documented.
 *
 * Reports hosts, query-less paths, statuses, shapes and counts. Never stream
 * URLs or tokens.
 *
 * Runs on a GitHub runner via diagnose-compare.yml:
 *   npm install --no-save --no-package-lock playwright-core @sparticuz/chromium
 */
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const BASE = (process.env.TGVID_BASE || 'https://tgvid.lovable.app').replace(/\/+$/, '');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[tgvid] ${t} :: ${v}`);

async function get(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    return { status: res.status, text, url: res.url };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

// ------------------------------------------------------------- 1. the shell ---
const root = await get(`${BASE}/`);
log('root', root.error ? `ERR ${root.error}` : `HTTP ${root.status} bytes=${root.text.length}`);
if (root.text) log('root head', root.text.slice(0, 160).replace(/\s+/g, ' '));

const refs = [...new Set([
  ...[...root.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]),
  ...[...root.text.matchAll(/["'](\/?assets\/[^"']+\.(?:js|mjs))["']/g)].map((m) => m[1]),
])];
log('script refs', refs.length ? refs.slice(0, 10).join(' ') : 'none');

const blobs = [];
for (const ref of refs.slice(0, 10)) {
  const url = ref.startsWith('http') ? ref : `${BASE}${ref.startsWith('/') ? '' : '/'}${ref}`;
  const r = await get(url);
  log('bundle', `${ref} HTTP ${r.status} bytes=${r.text.length}`);
  if (r.text) blobs.push(r.text);
}
const blob = blobs.join('\n');
log('total js bytes', blob.length);

// ------------------------------------------------ 2. endpoints and providers --
const hosts = new Map();
for (const m of blob.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?[^\s"'`<>)\\]{0,90}/gi)) {
  const u = m[0];
  if (/lovable\.|discord|googleapis|gstatic|fonts\.|w3\.org|schema\.org|tmdb\.org|image\.tmdb|jsdelivr|unpkg|cloudflareinsights|sentry|react\.dev|npmjs/i.test(u)) continue;
  try {
    const parsed = new URL(u);
    if (!hosts.has(parsed.hostname)) hosts.set(parsed.hostname, new Set());
    if (parsed.pathname !== '/') hosts.get(parsed.hostname).add(parsed.pathname.slice(0, 50));
  } catch { /* ignore */ }
}
log('upstream hosts', hosts.size);
for (const [h, paths] of [...hosts].slice(0, 20)) log('  host', `${h} ${[...paths].slice(0, 3).join(' ')}`);

const eps = new Set();
for (const m of blob.matchAll(/["'`](\/(?:api|v\d|embed|source|stream|resolve|extract|search|servers?|sources?)[a-zA-Z0-9/_${}.-]{0,60})["'`]/g)) eps.add(m[1]);
log('endpoint paths', eps.size);
for (const e of [...eps].slice(0, 30)) log('  path', e);

const names = new Set();
for (const m of blob.matchAll(/\b([A-Z][A-Za-z0-9]{2,18})\b(?=\s*[:=])/g)) {
  const n = m[1];
  if (/^(React|Object|Array|String|Number|Boolean|Promise|Error|JSON|Math|Date|Map|Set|Window|Document|Node|URL|Request|Response|Headers|Event|CustomEvent|Intl|Symbol|Buffer|Uint|Int|Float)$/.test(n)) continue;
  names.add(n);
}
log('identifiers seen (sample)', [...names].slice(0, 40).join(', ') || 'none');

// ------------------------------------- 3. what does the player actually call? --
const watched = new Map();
const jsonCalls = [];
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: await chromiumBinary.executablePath(),
    args: [...chromiumBinary.args, '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ userAgent: UA });

  page.on('response', async (res) => {
    const url = res.url();
    let u;
    try { u = new URL(url); } catch { return; }
    if (/lovable\.app|lovable\.dev|\.r2\.dev|discord|googleapis|gstatic|fonts\.|jsdelivr|unpkg|cloudflareinsights|profitableratecpm|\.js$|\.css$|\.png$|\.jpg$|\.svg$|\.woff/i.test(url)) return;
    const ct = (res.headers()['content-type'] || '').split(';')[0];
    const key = `${u.hostname}${u.pathname}`;
    if (!watched.has(key)) watched.set(key, { host: u.hostname, path: u.pathname, status: res.status(), ct, n: 0 });
    watched.get(key).n += 1;
    // A JSON payload is the thing we want: it is a source list.
    if (/json/.test(ct)) {
      try {
        const text = await res.text();
        let shape = '';
        try {
          const j = JSON.parse(text);
          const keys = Object.keys(j).slice(0, 10).join(',');
          const arrs = Object.entries(j).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}[${v.length}]`);
          shape = `keys=${keys} arrays=${arrs.join(' ')}`;
          const first = (Array.isArray(j) ? j[0] : j.sources?.[0] || j.data?.[0] || j.stream?.sources?.[0]) || null;
          if (first && typeof first === 'object') shape += ` firstKeys=${Object.keys(first).slice(0, 10).join(',')}`;
        } catch {
          shape = `not-json:${text.slice(0, 40)}`;
        }
        jsonCalls.push({ key, status: res.status(), bytes: text.length, shape });
      } catch { /* body gone */ }
    }
  });

  // Try the likely routes; a wrong one just yields no traffic.
  for (const route of ['/', '/movie/550', '/tv/1399/1/1', '/embed/movie/550']) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(9_000);
      const ui = await page.evaluate(() => document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 100) || '').catch(() => '');
      log('page', `${route} ui="${ui.slice(0, 70)}"`);
    } catch (e) {
      log('page', `${route} ERR ${e.name}`);
    }
  }
} catch (e) {
  log('browser', `ERR ${e.name}`);
} finally {
  await browser?.close().catch(() => {});
}

log('watched endpoints', watched.size);
for (const w of [...watched.values()].sort((a, b) => b.n - a.n).slice(0, 30)) {
  log('  hit', `${w.host}${w.path} n=${w.n} status=${w.status} ct=${w.ct}`);
}
log('json responses', jsonCalls.length);
for (const j of jsonCalls.slice(0, 20)) log('  json', `${j.key} status=${j.status} bytes=${j.bytes} ${j.shape}`);

console.log('[tgvid:done]');
