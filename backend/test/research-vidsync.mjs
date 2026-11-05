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
annotate('notice', 'VsScripts', `script tags=${scriptSrcs.length}`);

let bundle = '';
for (const src of scriptSrcs.slice(0, 6)) {
  try {
    const abs = new URL(src, BASE).toString();
    const r = await fetch(abs, { headers: H, signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    if (text.length > bundle.length) bundle = text;
  } catch { /* ignore */ }
}
annotate(bundle ? 'notice' : 'error', 'VsBundle', `largest bundle bytes=${bundle.length}`);

// 2) Endpoint shapes referenced by the client bundle (paths only)
if (bundle) {
  const paths = [...new Set([...bundle.matchAll(/["'`](\/(?:backend|api)\/[a-zA-Z0-9_/\-]{2,60})["'`]/g)].map((m) => m[1]))];
  annotate('notice', 'VsEndpoints', paths.slice(0, 25).join(' | ') || 'none found');

  // Obfuscated request-field key names near raider/token code (names only)
  const keyNames = [...new Set([...bundle.matchAll(/["'`]([a-f0-9]{16,64})["'`]\s*:/g)].map((m) => m[1]))];
  annotate('notice', 'VsFieldKeys', `hex-key names=${keyNames.length} sample=${keyNames.slice(0, 8).join(',')}`);

  const serverWords = [...new Set([...bundle.matchAll(/["'`](orion|andromeda|atlas|daedalus|ursa|icarus|berkas|athena|cinevault|nitro|castle)["'`]/gi)].map((m) => m[1].toLowerCase()))];
  annotate('notice', 'VsServerNames', serverWords.join(',') || 'none found');

  const hasRaider = /raider/i.test(bundle);
  const hasDubLang = /dubLang/i.test(bundle);
  annotate('notice', 'VsBundleFlags', `raider=${hasRaider} dubLang=${hasDubLang} audioTracks=${/audioTracks/i.test(bundle)}`);
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

await tryRaider('plain-fields', `${BASE}/backend/raider`, {
  id: Number(TMDB),
  type: 'movie',
  server: 'orion',
});

// 4) Candidate JSON API shapes an embed player commonly uses (statuses only)
for (const p of [
  `/api/sources?tmdb=${TMDB}&type=movie`,
  `/api/streams?tmdb=${TMDB}&type=movie`,
  `/api/embed/movie/${TMDB}`,
  `/backend/servers/orion?id=${TMDB}&type=movie`,
]) {
  try {
    const r = await fetch(`${BASE}${p}`, { headers: H, signal: AbortSignal.timeout(15_000) });
    const text = await r.text();
    let keys = '';
    try {
      const j = JSON.parse(text);
      keys = Array.isArray(j) ? `array(${j.length})` : Object.keys(j).join(',');
    } catch { /* not json */ }
    annotate(r.ok ? 'notice' : 'warning', 'VsApiGuess', `${p.split('?')[0]}: HTTP ${r.status} bytes=${text.length} keys=[${short(keys, 140)}]`);
  } catch (e) {
    annotate('warning', 'VsApiGuess', `${p.split('?')[0]}: failed ${e.name}`);
  }
}

// 5) Call-shape archaeology: redacted code context around key endpoints.
// GitHub surfaces only a limited number of annotations per run, so all
// contexts are combined into ONE annotation.
const redact = (s) =>
  String(s)
    .replace(/[a-f0-9]{24,}/gi, '<hex>')
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '<long>')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
if (bundle) {
  const parts = [];
  for (const needle of ['/api/stream/session/init', '/api/stream?', '/api/stream"', '/api/security/check', '/api/castle/']) {
    const at = bundle.indexOf(needle);
    parts.push(`${needle} :: ${at < 0 ? 'not found' : redact(bundle.slice(Math.max(0, at - 160), at + 220))}`);
  }
  annotate('notice', 'VsCallShapes', parts.join(' || ').slice(0, 950));
}

// 6) Session/security handshake attempts (statuses + key names only)
async function attempt(label, method, pathName, body) {
  try {
    const r = await fetch(`${BASE}${pathName}`, {
      method,
      headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}), Origin: BASE },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let keys = '';
    try {
      const j = JSON.parse(text);
      keys = Array.isArray(j) ? `array(${j.length})` : Object.keys(j).join(',');
    } catch { /* not json */ }
    annotate(r.ok ? 'notice' : 'warning', 'VsHandshake', `${label}: HTTP ${r.status} bytes=${text.length} keys=[${short(keys, 180)}]`);
    return { status: r.status, text };
  } catch (e) {
    annotate('warning', 'VsHandshake', `${label}: failed ${e.name}`);
    return null;
  }
}

await attempt('security-check-empty', 'POST', '/api/security/check', {});

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

const streamAttempts = [
  ['bearer-get', 'GET', `/api/stream?tmdbId=${TMDB}&type=movie`, null, { Authorization: `Bearer ${sessionToken}` }],
  ['xsession-get', 'GET', `/api/stream?tmdbId=${TMDB}&type=movie`, null, { 'x-stream-session': sessionToken }],
  ['bearer-post', 'POST', '/api/stream', { tmdbId: Number(TMDB), type: 'movie' }, { Authorization: `Bearer ${sessionToken}` }],
  ['plain-get-id', 'GET', `/api/stream?id=${TMDB}&type=movie`, null, { Authorization: `Bearer ${sessionToken}` }],
];
for (const [label, method, pathName, body, extraHeaders] of streamAttempts) {
  try {
    const r = await fetch(`${BASE}${pathName}`, {
      method,
      headers: { ...H, Origin: BASE, ...extraHeaders, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    let info = `bytes=${text.length}`;
    try {
      const j = JSON.parse(text);
      const srcs = Array.isArray(j?.sources) ? j.sources : null;
      info += ` error=${short(String(j?.error ?? ''), 90)} sources=${srcs ? srcs.length : 'n/a'}`;
      if (srcs?.length) {
        const first = srcs[0] ?? {};
        info += ` firstKeys=[${Object.keys(first).join(',')}] servers=[${[...new Set(srcs.map((s) => String(s.server ?? s.name ?? s.provider ?? '?')))].slice(0, 10).join(',')}]`;
      }
    } catch { /* not json */ }
    annotate(r.ok ? 'notice' : 'warning', 'VsStreamTry', `${label}: HTTP ${r.status} ${info}`);
  } catch (e) {
    annotate('warning', 'VsStreamTry', `${label}: failed ${e.name}`);
  }
}

annotate('notice', 'VsResearchDone', `${BASE} tmdb=${TMDB}`);
