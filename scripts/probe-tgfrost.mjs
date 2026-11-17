#!/usr/bin/env node
/**
 * Dissect tgfrost.lovable.app.
 *
 * It is not a stream host — it is a thin player over other backends. The embed
 * page named one in the UI ("Switching to MovieBoxV2…"), which means the real
 * sources are behind it and/or named in its own JS. So the job is:
 *
 *   1. fetch the embed shell + every script it loads,
 *   2. mine those bundles for endpoints, provider names and per-server wiring,
 *   3. report what we find — never stream URLs or tokens.
 *
 * Runs on a GitHub runner (real egress) via diagnose-compare.yml.
 *
 *   node scripts/probe-tgfrost.mjs
 */

const BASE = 'https://tgfrost.lovable.app';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[tg] ${t} :: ${v}`);

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

// ------------------------------------------------------------ 1. the shell ---
const embed = await get(`${BASE}/embed/movie/550`);
log('embed/movie/550', `HTTP ${embed.status} bytes=${embed.text.length}`);
if (embed.error) log('embed error', embed.error);

// Vite/Lovable ships either real <script src> tags or an import map + module.
const scriptSrcs = [...embed.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
const moduleRefs = [...embed.text.matchAll(/["'](\/?assets\/[^"']+\.(?:js|mjs))["']/g)].map((m) => m[1]);
const allRefs = [...new Set([...scriptSrcs, ...moduleRefs])];
log('script refs', allRefs.length ? allRefs.slice(0, 10).join(' ') : 'none');

// Inline config is common in Lovable builds (import maps, supabase urls, etc).
for (const pat of [
  /<script[^>]*type=["']importmap["'][^>]*>([\s\S]{0,600})<\/script>/i,
  /window\.__[A-Z_]+__\s*=\s*(\{[\s\S]{0,400}?\});/g,
]) {
  const m = embed.text.match(pat);
  if (m) log('inline config', String(m[1]).replace(/\s+/g, ' ').slice(0, 300));
}

// ------------------------------------------------ 2. mine every bundle ------
const bundles = [];
for (const ref of allRefs.slice(0, 12)) {
  const url = ref.startsWith('http') ? ref : `${BASE}${ref.startsWith('/') ? '' : '/'}${ref}`;
  const r = await get(url);
  log('bundle', `${ref} HTTP ${r.status} bytes=${r.text.length}`);
  if (r.text) bundles.push(r.text);
}
// Also the docs page, which loads the generator UI and may differ.
const docs = await get(`${BASE}/docs`);
if (docs.text) {
  bundles.push(docs.text);
  const docsRefs = [...new Set([
    ...[...docs.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...docs.text.matchAll(/["'](\/?assets\/[^"']+\.(?:js|mjs))["']/g)].map((m) => m[1]),
  ])];
  log('docs script refs', docsRefs.length ? docsRefs.slice(0, 8).join(' ') : 'none');
  for (const ref of docsRefs.slice(0, 8)) {
    const url = ref.startsWith('http') ? ref : `${BASE}${ref.startsWith('/') ? '' : '/'}${ref}`;
    const r = await get(url);
    log('docs bundle', `${ref} HTTP ${r.status} bytes=${r.text.length}`);
    if (r.text) bundles.push(r.text);
  }
}

const blob = bundles.join('\n');
log('total js bytes', blob.length);

// ------------------------------------------- 3. what backends does it use ---
// Absolute URLs to anything that is not the player's own origin. These are the
// actual upstream APIs, which is the whole point of this probe.
const abs = [...blob.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?[^\s"'`<>)\\]{0,80}/gi)]
  .map((m) => m[0])
  .filter((u) => !/lovable\.app|lovable\.dev|discord|googleapis|gstatic|fonts\.|w3\.org|schema\.org|tmdb\.org|image\.tmdb|jsdelivr|unpkg|cloudflareinsights|sentry|github\.com|npmjs/i.test(u));
const hosts = new Map();
for (const u of abs) {
  try {
    const h = new URL(u).hostname;
    if (!hosts.has(h)) hosts.set(h, new Set());
    const p = new URL(u).pathname;
    if (p && p !== '/') hosts.get(h).add(p.split('?')[0].slice(0, 60));
  } catch { /* ignore */ }
}
log('upstream hosts', hosts.size);
for (const [h, paths] of [...hosts].slice(0, 25)) {
  log('  host', `${h}  ${[...paths].slice(0, 4).join(' ') || '(root)'}`);
}

// Provider / server names. These tell us what each of the five servers is.
const namePatterns = [
  /\b(TG ?FROST|TG ?OUT|TG ?HUB|HDARK|TGVID|MovieBox(?:V2)?|Vidsrc|VidLink|Nontongo|SmashyStream|VidFast|111movies|TwoEmbed|SuperEmbed|Videasy|VidPlus|MegaPlay|AniWatch|AnimeKai|HiAnime)\b/gi,
];
const names = new Set();
for (const p of namePatterns) for (const m of blob.matchAll(p)) names.add(m[1]);
log('provider names', [...names].join(', ') || 'none');

// Endpoint-shaped strings, whatever the host.
const eps = new Set();
for (const m of blob.matchAll(/["'`](\/(?:api|v\d|embed|source|stream|resolve|extract|search|info)[a-zA-Z0-9/_${}.-]{0,60})["'`]/g)) {
  eps.add(m[1]);
}
log('endpoint paths', eps.size);
for (const e of [...eps].slice(0, 30)) log('  path', e);

// Server wiring: look for the selector's list and what each entry points at.
for (const m of blob.matchAll(/(?:servers?|sources?|providers?)\s*[:=]\s*(\[[\s\S]{0,700}?\])/gi)) {
  const s = m[1];
  if (/tg ?frost|hdark|tgvid|tg ?out|tg ?hub/i.test(s)) {
    log('server list', s.replace(/\s+/g, ' ').slice(0, 500));
    break;
  }
}

// ---------------------------------- 4. is the CDN publicly constructible? ---
// TG FROST plays DASH straight off sacdn.hakunaymatata.com/dash/<dir>/ and
// bcdnt.hakunaymatata.com/<bucket>/<hash>.mp4. If those answer without a TG
// FROST session, the backend is directly reachable and we need no dependency on
// TG FROST at all - which is the actual goal. A directory observed in the
// browser probe is used verbatim; segments already returned 200 for it.
const OBSERVED_DIR = '379171015097733864_1_1_1080_h265';
const OBSERVED_MP4 = 'https://bcdnt.hakunaymatata.com/resource/a43e7f34e8358a922c8b181114bd4db6.mp4';
for (const [label, url] of [
  ...['master.m3u8', 'manifest.mpd', 'index.mpd', 'master.mpd'].map((f) => [
    `sacdn:${f}`,
    `https://sacdn.hakunaymatata.com/dash/${OBSERVED_DIR}/${f}`,
  ]),
  ['bcdnt:mp4-range', OBSERVED_MP4],
  ['sacdn:init-segment', `https://sacdn.hakunaymatata.com/dash/${OBSERVED_DIR}/init-stream3.m4s`],
  // The player is reached through a worker relay; check whether the relay is
  // open (no session) or bound to TG FROST.
  ['reelsdownload:subs', 'https://embed.reelsdownload.online/api/subs/vtt'],
]) {
  const r = await get(label, url, { Range: 'bytes=0-2048' });
  // Log failures too: a silent skip here would read as "not tested" when the
  // real answer is "refused", and the two mean opposite things.
  if (!r.status) {
    log(label, `ERR ${r.error || 'no-response'} (direct fetch from the runner)`);
  } else {
    const head = r.text.slice(0, 120).replace(/\s+/g, ' ');
    log(label, `HTTP ${r.status} bytes=${r.text.length} :: ${head}`);
  }
}

console.log('[tg:done]');
