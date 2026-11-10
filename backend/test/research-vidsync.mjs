// Research probe: how does vidsync.pro resolve streams under its embed?
// Hosted-only (sandbox network to the provider is blocked). Reports shapes,
// statuses, key NAMES, server names, and aggregate stream stats as GitHub
// annotations. Never prints tokens, stream URLs, or crypto secrets.
const annotate = (level, title, message) =>
  console.log(`::${level} title=${title}::${String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);

const BASE = (process.env.VS_BASE || 'https://vidsync.pro').replace(/\/+$/, '');
const TMDB = process.env.VS_TMDB || '693134';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Accept: '*/*', Referer: `${BASE}/` };

const short = (s, n = 300) => String(s || '').slice(0, n);

// 1) Embed HTML + script bundles
let html = '';
try {
  const r = await fetch(`${BASE}/embed/movie/${TMDB}`, { headers: H, signal: AbortSignal.timeout(20_000) });
  html = await r.text();
  annotate(r.ok ? 'notice' : 'error', 'VsEmbed', `GET /embed/movie/${TMDB} HTTP ${r.status} bytes=${html.length}`);
} catch (e) {
  annotate('error', 'VsEmbed', `embed fetch failed: ${e.name}`);
}

const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);

let bundle = '';
for (const src of scriptSrcs.slice(0, 6)) {
  try {
    const abs = new URL(src, BASE).toString();
    const r = await fetch(abs, { headers: H, signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    if (text.length > bundle.length) bundle = text;
  } catch { /* ignore */ }
}
// 2) Endpoint shapes referenced by the client bundle (paths only), combined
// into one annotation (GitHub surfaces ~10 annotations per step).
if (bundle) {
  const paths = [...new Set([...bundle.matchAll(/["'`](\/(?:backend|api)\/[a-zA-Z0-9_/\-]{2,60})["'`]/g)].map((m) => m[1]))];
  const serverWords = [...new Set([...bundle.matchAll(/["'`](orion|andromeda|atlas|daedalus|ursa|icarus|berkas|athena|cinevault|nitro|castle)["'`]/gi)].map((m) => m[1].toLowerCase()))];
  annotate(
    'notice',
    'VsBundleInfo',
    `bundleBytes=${bundle.length} scripts=${scriptSrcs.length} servers=[${serverWords.join(',')}] raider=${/raider/i.test(bundle)} paths=${paths.slice(0, 20).join(' | ')}`,
  );
}

// 3) Try the VidStuck-family token endpoint shape (names only in output)
async function tryRaider(label, url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let keys = '';
    try {
      keys = Object.keys(JSON.parse(text)).join(',');
    } catch { /* not json */ }
    annotate(r.ok ? 'notice' : 'warning', 'VsRaider', `${label}: HTTP ${r.status} bytes=${text.length} jsonKeys=[${short(keys, 160)}]`);
    return r.ok ? text : null;
  } catch (e) {
    annotate('warning', 'VsRaider', `${label}: failed ${e.name}`);
    return null;
  }
}

void tryRaider;

void bundle;

// Real handshake: session init takes NO body and returns { token }.
let sessionToken = '';
try {
  const r = await fetch(`${BASE}/api/stream/session/init`, {
    method: 'POST',
    headers: { ...H, Origin: BASE },
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => null);
  sessionToken = typeof j?.token === 'string' ? j.token : '';
  annotate(
    r.ok && sessionToken ? 'notice' : 'warning',
    'VsSession',
    `init HTTP ${r.status} tokenPresent=${!!sessionToken} tokenLen=${sessionToken.length} keys=[${j ? Object.keys(j).join(',') : ''}]`,
  );
} catch (e) {
  annotate('warning', 'VsSession', `init failed ${e.name}`);
}

// 7) Deep structure: stages, per-source aggregates, and real media bytes.
import crypto from 'node:crypto';
const hostHash = (u) => {
  try {
    return crypto.createHash('sha256').update(new URL(u).host).digest('hex').slice(0, 10);
  } catch {
    return 'invalid';
  }
};
async function getStream(label, qs) {
  try {
    const r = await fetch(`${BASE}/api/stream?${qs}`, { headers: { ...H, Origin: BASE }, signal: AbortSignal.timeout(25_000) });
    const j = await r.json().catch(() => null);
    const srcs = Array.isArray(j?.sources) ? j.sources : [];
    const servers = [...new Set(srcs.map((s) => `${s.provider ?? '?'}/${s.server ?? '?'}#${s.layer ?? '?'}`))];
    const langs = new Set();
    const quals = new Set();
    let subs = 0;
    for (const s of srcs) {
      for (const t of s.audioTracks ?? []) langs.add(String(t.lang ?? t.code ?? t.name ?? t.label ?? '?'));
      if (s.audioLanguage) langs.add(String(s.audioLanguage));
      for (const q of s.availableQualities ?? []) quals.add(String(q?.quality ?? q?.label ?? q));
      if (s.quality) quals.add(String(s.quality));
      subs += Array.isArray(s.subtitles) ? s.subtitles.length : 0;
    }
    annotate(
      r.ok ? 'notice' : 'warning',
      'VsDeep',
      `${label}: HTTP ${r.status} sources=${srcs.length} servers=[${servers.slice(0, 8).join(',')}] langs=[${[...langs].slice(0, 16).join(',')}] quals=[${[...quals].slice(0, 10).join(',')}] subs=${subs} err=${short(String(j?.error ?? ''), 60)}`,
    );
    return srcs;
  } catch (e) {
    annotate('warning', 'VsDeep', `${label}: failed ${e.name}`);
    return [];
  }
}

const primary = await getStream('primary-movie', `type=movie&id=${TMDB}&season=1&episode=1&stage=primary`);
await getStream('secondary-movie', `type=movie&id=${TMDB}&season=1&episode=1&stage=secondary`);
await getStream('fallback-movie', `type=movie&id=${TMDB}&season=1&episode=1&stage=fallback`);
await getStream('primary-tv-rezero', 'type=tv&id=65942&season=1&episode=1&stage=primary');

// Audio track / quality object shapes + URL kind mix + no-stage comparison.
if (primary[0]) {
  const f = primary[0];
  const t0 = (f.audioTracks ?? [])[0] ?? {};
  const q0 = (f.availableQualities ?? [])[0];
  let proxyCount = 0;
  let directCount = 0;
  let permanentCount = 0;
  let trackUrlCount = 0;
  for (const s of primary) {
    const u = String(s.url ?? '');
    if (u.startsWith(BASE)) proxyCount++;
    else if (u) directCount++;
    if (s.permanent_m3u8_url) permanentCount++;
    for (const t of s.audioTracks ?? []) if (t?.url || t?.link || t?.file) trackUrlCount++;
  }
  annotate(
    'notice',
    'VsShapes',
    `trackKeys=[${Object.keys(t0).join(',')}] trackHasUrl=${!!(t0.url || t0.link || t0.file)} trackUrlHost=${t0.url ? hostHash(String(t0.url)) : '-'} qualityShape=${JSON.stringify(q0 ?? null).slice(0, 120)} proxyUrls=${proxyCount} directUrls=${directCount} permanent=${permanentCount} trackUrls=${trackUrlCount}`,
  );
}
await getStream('nostage-movie', `type=movie&id=${TMDB}&season=1&episode=1`);

// Real bytes from the first primary source (manifest + first segment).
const first = primary[0];
if (first) {
  const murl = String(first.url ?? '');
  annotate('notice', 'VsFirst', `urlHost=${hostHash(murl)} viaProxy=${murl.startsWith(BASE)} permanent=${!!first.permanent_m3u8_url} headerKeys=[${Object.keys(first.headers ?? {}).join(',')}] audioTracks=${(first.audioTracks ?? []).length}`);
  try {
    const mr = await fetch(murl, { headers: { ...H, ...(first.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    const mtext = await mr.text();
    const isHls = mtext.trimStart().startsWith('#EXTM3U');
    const audioLines = (mtext.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
    const variants = (mtext.match(/#EXT-X-STREAM-INF/g) || []).length;
    annotate(mr.ok && isHls ? 'notice' : 'error', 'VsManifest', `HTTP ${mr.status} hls=${isHls} bytes=${mtext.length} audioRenditions=${audioLines} variants=${variants}`);
    const segRef = mtext.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (segRef) {
      const segUrl = new URL(segRef, murl).toString();
      const sr = await fetch(segUrl, { headers: { ...H, ...(first.headers ?? {}), Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20_000) });
      const buf = sr.body ? Buffer.from(await sr.arrayBuffer()) : Buffer.alloc(0);
      annotate(sr.ok || sr.status === 206 ? 'notice' : 'error', 'VsSegment', `HTTP ${sr.status} bytes=${buf.byteLength} tsMagic=${buf[0] === 0x47}`);
    }
  } catch (e) {
    annotate('error', 'VsManifest', `manifest fetch failed: ${e.name}`);
  }
}

annotate('notice', 'VsResearchDone', `${BASE} tmdb=${TMDB}`);
