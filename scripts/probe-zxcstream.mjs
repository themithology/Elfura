#!/usr/bin/env node
/**
 * Does ZXCSTREAM-MIRROR's backend actually serve streams, and is the 31-server
 * list real?
 *
 * Reading the mirror repo says: 31 named servers in AETHO_SERVER_DEFINITIONS,
 * each mapping to one of FOUR upstream clusters (alatreon, valstrax, ursa,
 * atlas) on zxcstream.cc, all fed by ONE shared extraction. If that is accurate
 * then "31 servers" is 4 backends with 31 labels, and adding 31 sources would
 * be 31 copies of the same data. That distinction decides the whole design, so
 * it is measured here before any adapter is written.
 *
 * The extraction flow, taken from the mirror's own source:
 *   POST https://zxcstream.cc/backend/trace   { id, type, path }  -> { token }
 *   then the details call carrying that token.
 * The token endpoint ROTATES, so several candidates are tried in order.
 *
 * Reports statuses, shapes and counts only — never a full stream URL.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[zxc] ${t} :: ${v}`);

const HOST = 'https://zxcstream.cc';
const REFERER = `${HOST}/`;
const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  Origin: HOST,
  Referer: REFERER,
};

/** Token endpoints in the order the mirror tries them. */
const TOKEN_ENDPOINTS = [
  '/backend/trace',
  '/backend/getthefuckoutniiguh',
  '/backend/wtfnigga',
  '/backend/fucku',
  '/backend/token',
];

async function post(path, body, timeoutMs = 12_000) {
  try {
    const res = await fetch(`${HOST}${path}`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, text, ct: res.headers.get('content-type') || '' };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

async function get(url, headers = {}, timeoutMs = 12_000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { status: res.status, text, ct: res.headers.get('content-type') || '' };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

const CASES = [
  { type: 'movie', id: '550', label: 'Fight Club' },
  { type: 'tv', id: '1399', season: 1, episode: 1, label: 'Game of Thrones' },
  { type: 'tv', id: '94664', season: 1, episode: 1, label: 'Mushoku Tensei' },
];

for (const c of CASES) {
  log('--- case', `${c.type}/${c.id} (${c.label})`);

  // 1. get a token
  let token = null;
  let tokenPath = null;
  for (const ep of TOKEN_ENDPOINTS) {
    const body = { id: String(c.id), type: c.type, path: 'AethoAtlas' };
    if (c.type === 'tv') {
      body.season = c.season;
      body.episode = c.episode;
    }
    const r = await post(ep, body);
    const head = r.text.slice(0, 80).replace(/\s+/g, ' ');
    log(`  token ${ep}`, r.error ? `ERR ${r.error}` : `HTTP ${r.status} ${head}`);
    if (r.status && r.text) {
      try {
        const j = JSON.parse(r.text);
        if (j?.token || j?.data?.token) {
          token = j.token || j.data.token;
          tokenPath = ep;
          break;
        }
        // A 200 with a different shape is still information.
        log(`  token shape ${ep}`, `keys=${Object.keys(j).slice(0, 8).join(',')}`);
      } catch { /* not json */ }
    }
  }
  if (!token) {
    log('  token', 'NONE — cannot continue for this case');
    continue;
  }
  log('  token', `acquired from ${tokenPath} (len=${token.length})`);

  // 2. the details call. Try both id namespaces and both placements of the token.
  const q = `?language=en&token=${encodeURIComponent(token)}`;
  const urls = [
    `${HOST}/backend/imdb/details/${c.type}/${c.id}${q}`,
    `${HOST}/backend/tmdb/details/${c.type}/${c.id}${q}`,
  ];
  for (const url of urls) {
    const r = await get(url, { Origin: HOST, Referer: REFERER, Accept: 'application/json' });
    if (!r.status) {
      log(`  details ${new URL(url).pathname}`, `ERR ${r.error}`);
      continue;
    }
    let shape = r.text.slice(0, 100).replace(/\s+/g, ' ');
    try {
      const j = JSON.parse(r.text);
      const keys = Object.keys(j).slice(0, 10).join(',');
      const arrs = Object.entries(j)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => `${k}[${v.length}]`)
        .join(' ');
      shape = `json keys=${keys} ${arrs}`;
      // Look for stream-ish payloads anywhere one level down.
      const blob = JSON.stringify(j);
      const m3u8 = (blob.match(/\.m3u8/g) || []).length;
      const mpd = (blob.match(/\.mpd/g) || []).length;
      const hosts = [...new Set((blob.match(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi) || []).map((u) => {
        try { return new URL(u).hostname; } catch { return '?'; }
      }))].slice(0, 6);
      shape += ` m3u8=${m3u8} mpd=${mpd} hosts=${hosts.join('|')}`;
    } catch { /* not json */ }
    log(`  details ${new URL(url).pathname}`, `HTTP ${r.status} ${shape}`);
  }

  // 3. does the token work as a POST body field instead of a query param?
  const bodyRes = await post(`/backend/imdb/details/${c.type}/${c.id}`, {
    id: String(c.id),
    type: c.type,
    token,
    language: 'en',
    ...(c.type === 'tv' ? { season: c.season, episode: c.episode } : {}),
  });
  if (bodyRes.status) {
    log('  details(POST)', `HTTP ${bodyRes.status} ${bodyRes.text.slice(0, 90).replace(/\s+/g, ' ')}`);
  }
}

// 4. Sanity: is the front door even up from a datacenter?
const root = await get(`${HOST}/`);
log('root', root.error ? `ERR ${root.error}` : `HTTP ${root.status} bytes=${root.text.length}`);

console.log('[zxc:done]');
