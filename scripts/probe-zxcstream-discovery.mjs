#!/usr/bin/env node
/**
 * Self-discover zxcstream.cc's current backend contract, the way the mirror repo
 * does it at runtime.
 *
 * The previous probe hardcoded {id, type, path} and /backend/trace. Both are
 * wrong: the token endpoint ROTATES (the mirror keeps a mutable
 * CURRENT_TOKEN_ENDPOINT and re-discovers it), and the request field names are
 * obfuscated hex strings that also rotate (FIELD_MAP in the mirror). Poking
 * fixed paths therefore 404s no matter what.
 *
 * So: read the player page, walk its _next/static chunks, and pull the real
 * endpoint + field map out of the bundle. Then use what was found.
 *
 * Prints the discovered contract and statuses only, never stream URLs.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[zxc2] ${t} :: ${v}`);
const HOST = 'https://zxcstream.cc';

async function getText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

// ---- 1. discover -----------------------------------------------------------
const page = await getText(`${HOST}/player/movie/128`);
log('player page', page.error ? `ERR ${page.error}` : `HTTP ${page.status} bytes=${page.text.length}`);
if (!page.status) {
  console.log('[zxc2:done]');
  process.exit(0);
}

const chunks = [...new Set(page.text.match(/\/_next\/static\/chunks\/[a-zA-Z0-9_.~-]+\.js/g) || [])];
log('chunks', `${chunks.length} referenced`);

let tokenEndpoint = null;
const fieldMap = {};
const backendPaths = new Set();
const postCalls = new Set();

for (const c of chunks.slice(0, 40)) {
  const r = await getText(`${HOST}${c}`);
  if (!r.status) continue;
  const js = r.text;

  for (const m of js.matchAll(/["'`](\/backend\/[a-zA-Z0-9_~/-]+)["'`]/g)) backendPaths.add(m[1]);
  for (const m of js.matchAll(/post\(["'](\/backend\/[a-zA-Z0-9_~-]+)["']/g)) postCalls.add(m[1]);

  if (!tokenEndpoint) {
    const pm = js.match(/post\(["'](\/backend\/[a-zA-Z0-9_~-]+)["']/);
    if (pm) tokenEndpoint = pm[1];
  }

  // Obfuscated field map: id:"<hex>", path:"<hex>", mediaType:"<hex>" ...
  if (/generateFrontendToken|FIELD_MAP|latestDate:/.test(js) && Object.keys(fieldMap).length === 0) {
    for (const key of [
      'id', 'fToken', 'ts', 'token', 'title', 'year', 'season', 'episode',
      'imdbId', 'path', 'mediaType', 'date', 'latestDate',
    ]) {
      const m = js.match(new RegExp(`${key}:["']([a-f0-9]{16,32})["']`));
      if (m) fieldMap[key] = m[1];
    }
    log('field map source chunk', `${c} (${Object.keys(fieldMap).length} fields)`);
  }
}

log('token endpoint', tokenEndpoint || 'NOT FOUND');
log('POST calls', [...postCalls].join(' ') || 'none');
log('backend paths', [...backendPaths].slice(0, 24).join(' ') || 'none');
log('field map', Object.keys(fieldMap).length ? JSON.stringify(fieldMap) : 'not found');

if (!tokenEndpoint) {
  console.log('[zxc2:done]');
  process.exit(0);
}

// ---- 2. use the discovered contract ---------------------------------------
async function postJson(path, body, referer) {
  try {
    const res = await fetch(`${HOST}${path}`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: HOST,
        Referer: referer || `${HOST}/`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, text: await res.text(), ct: res.headers.get('content-type') || '' };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

/** Build a body with obfuscated keys when the map is known, plain keys otherwise. */
function body(map, values) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    out[map[k] || k] = v;
  }
  return out;
}

const CASES = [
  { type: 'movie', id: '550', label: 'Fight Club' },
  { type: 'tv', id: '1399', season: 1, episode: 1, label: 'Game of Thrones' },
  { type: 'tv', id: '94664', season: 1, episode: 1, label: 'Mushoku Tensei' },
];

function summarize(text) {
  try {
    const j = JSON.parse(text);
    const arrs = Object.entries(j)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k}[${v.length}]`)
      .join(' ');
    const blob = JSON.stringify(j);
    const m3u8 = (blob.match(/\.m3u8/g) || []).length;
    const mpd = (blob.match(/\.mpd/g) || []).length;
    const hosts = [...new Set((blob.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map((u) => {
      try { return new URL(u).hostname; } catch { return '?'; }
    }))].slice(0, 8);
    return `json keys=${Object.keys(j).slice(0, 10).join(',')} ${arrs} m3u8=${m3u8} mpd=${mpd} hosts=${hosts.join('|')}`;
  } catch {
    return `non-json ${text.slice(0, 90).replace(/\s+/g, ' ')}`;
  }
}

for (const c of CASES) {
  log('--- case', `${c.type}/${c.id} (${c.label})`);
  const referer = c.type === 'tv'
    ? `${HOST}/player/tv/${c.id}/${c.season}/${c.episode}`
    : `${HOST}/player/movie/${c.id}`;

  const tokRes = await postJson(
    tokenEndpoint,
    body(fieldMap, {
      id: String(c.id),
      mediaType: c.type,
      path: 'AethoAtlas',
      season: c.type === 'tv' ? c.season : undefined,
      episode: c.type === 'tv' ? c.episode : undefined,
    }),
    referer
  );
  log(`  token ${tokenEndpoint}`, tokRes.error ? `ERR ${tokRes.error}` : `HTTP ${tokRes.status} ${tokRes.text.slice(0, 120).replace(/\s+/g, ' ')}`);
  if (!tokRes.status) continue;

  let token = null;
  try {
    const j = JSON.parse(tokRes.text);
    token = j?.token || j?.data?.token || null;
  } catch { /* not json */ }
  if (!token) {
    log('  token', 'absent from response — stopping this case');
    continue;
  }
  log('  token', `len=${token.length}`);

  // Details call, both namespaces, token as query and as obfuscated body field.
  for (const ns of ['imdb', 'tmdb']) {
    const url = `${HOST}/backend/${ns}/details/${c.type}/${c.id}?language=en&token=${encodeURIComponent(token)}`;
    const r = await getText(url);
    log(`  details GET ${ns}`, r.error ? `ERR ${r.error}` : `HTTP ${r.status} ${summarize(r.text)}`);
  }
  const pd = await postJson(
    `/backend/imdb/details/${c.type}/${c.id}`,
    body(fieldMap, { id: String(c.id), mediaType: c.type, token, title: '', year: '' }),
    referer
  );
  if (pd.status) log('  details POST', `HTTP ${pd.status} ${summarize(pd.text)}`);
}

console.log('[zxc2:done]');
