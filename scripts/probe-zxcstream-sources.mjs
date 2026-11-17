#!/usr/bin/env node
/**
 * Does zxcstream actually hand over playable streams, and is the 31-server list
 * real or 31 labels on 4 backends?
 *
 * The earlier probes were wrong twice over: the token endpoint rotates (so it
 * is discovered from the JS chunks) and the request field names are obfuscated
 * hex keys. The source call is also NOT the details call - details returns
 * metadata only. The real one is:
 *
 *   GET /backend_/sources/{serverKey}?<obfuscated field map>=...
 *   -> links[].link is base64 "Salted__" AES-256-CBC
 *
 * decrypted with an OpenSSL-compatible EVP_BytesToKey derivation (the mirror's
 * decryptCryptoJS). This runs the whole chain and then asks the SAME title from
 * several serverKeys: if hosts and quality sets come back identical, the 31
 * named servers are four backends wearing 31 labels.
 *
 * The runner IP gets Cloudflare 429/1015 quickly, so one token is shared across
 * serverKeys and 429s back off.
 */
import crypto from 'node:crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[zxc3] ${t} :: ${v}`);
const HOST = 'https://zxcstream.cc';
const DECRYPTION_KEY =
  '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c';

/** OpenSSL EVP_BytesToKey, matching the mirror's decryptCryptoJS. */
function decryptCryptoJS(cipherBase64, passphrase) {
  try {
    const buf = Buffer.from(cipherBase64, 'base64');
    if (buf.subarray(0, 8).toString('utf8') !== 'Salted__') return cipherBase64;
    const salt = buf.subarray(8, 16);
    const ciphertext = buf.subarray(16);
    let keyIv = Buffer.alloc(0);
    let prev = Buffer.alloc(0);
    while (keyIv.length < 48) {
      prev = crypto.createHash('md5')
        .update(Buffer.concat([prev, Buffer.from(passphrase, 'utf8'), salt]))
        .digest();
      keyIv = Buffer.concat([keyIv, prev]);
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      keyIv.subarray(0, 32),
      keyIv.subarray(32, 48)
    );
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return cipherBase64;
  }
}

async function getText(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

async function postJson(url, body, referer) {
  try {
    const res = await fetch(url, {
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
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

/** Retry on 429 with backoff - the runner IP gets Cloudflare-throttled fast. */
async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (last.status !== 429 && last.status !== 1015) return last;
    await new Promise((r) => setTimeout(r, 4000 * (i + 1)));
  }
  return last;
}

// ---- discover the live contract -------------------------------------------
const page = await getText(`${HOST}/player/movie/128`);
const chunks = [...new Set(page.text.match(/\/_next\/static\/chunks\/[a-zA-Z0-9_.~-]+\.js/g) || [])];
log('chunks', chunks.length);

let tokenEndpoint = null;
let fieldMap = {};
for (const c of chunks.slice(0, 40)) {
  const r = await getText(`${HOST}${c}`);
  if (!r.status) continue;
  const js = r.text;
  if (!tokenEndpoint) {
    const pm = js.match(/post\(["'](\/backend\/[a-zA-Z0-9_~-]+)["']/);
    if (pm) tokenEndpoint = pm[1];
  }
  if (!fieldMap.id && /generateFrontendToken|FIELD_MAP|latestDate:/.test(js)) {
    const map = {};
    for (const key of [
      'id', 'fToken', 'ts', 'token', 'title', 'year', 'season', 'episode',
      'imdbId', 'path', 'mediaType', 'date', 'latestDate',
    ]) {
      const m = js.match(new RegExp(`${key}:["']([a-f0-9]{16,32})["']`));
      if (m) map[key] = m[1];
    }
    if (map.id && map.path && map.mediaType) fieldMap = map;
  }
  if (tokenEndpoint && fieldMap.id) break;
}
// Enumerate every backend-ish path so the sources prefix is discovered, not
// guessed. The mirror hardcodes '/backend_/sources' but that segment rotates
// like the token endpoint does, so a hardcoded value 404s.
const backendPaths = new Set();
const stringPaths = new Set();
for (const c of chunks.slice(0, 40)) {
  const r = await getText(`${HOST}${c}`);
  if (!r.status) continue;
  for (const m of r.text.matchAll(/["'`](\/backend[^"'`\s]{0,60})["'`]/g)) backendPaths.add(m[1]);
  // template-literal forms: `/backend_/sources/${...}`
  for (const m of r.text.matchAll(/["'`](\/backend[^"'`]*?)\$\{/g)) stringPaths.add(m[1]);
}
log('backend paths', [...backendPaths].slice(0, 30).join(' ') || 'none');
log('template prefixes', [...stringPaths].slice(0, 20).join(' ') || 'none');

log('token endpoint', tokenEndpoint || 'NOT FOUND');
log('field map', fieldMap.id ? 'acquired' : 'NOT FOUND');
if (!tokenEndpoint || !fieldMap.id) {
  console.log('[zxc3:done]');
  process.exit(0);
}

// ---- resolve one title on one serverKey -----------------------------------
async function resolve(serverKey, c, shared) {
  const referer = c.type === 'tv'
    ? `${HOST}/player/tv/${c.id}/${c.season || 1}/${c.episode || 1}`
    : `${HOST}/player/movie/${c.id}`;

  const tokenBody = {
    [fieldMap.id]: String(c.id),
    [fieldMap.mediaType]: c.type,
    [fieldMap.path]: serverKey,
  };
  if (c.type === 'tv') {
    tokenBody[fieldMap.season] = Number(c.season) || 1;
    tokenBody[fieldMap.episode] = Number(c.episode) || 1;
  }

  // Reuse a token across serverKeys when one is in hand. That spares the rate
  // limit and also answers whether the token is bound to a specific serverKey.
  let tokData = shared?.tokData;
  if (!tokData) {
    const tok = await withRetry(() => postJson(`${HOST}${tokenEndpoint}`, tokenBody, referer));
    if (!tok.status) return { err: `token ERR ${tok.error}` };
    try { tokData = JSON.parse(tok.text); } catch { return { err: `token non-json HTTP ${tok.status}` }; }
    if (!tokData?.token) return { err: `token HTTP ${tok.status} no token` };
    if (shared) shared.tokData = tokData;
  }

  // Metadata supplies title/year/date, which the source query wants.
  const det = await withRetry(() => getText(
    `${HOST}/backend/imdb/details/${c.type}/${c.id}?language=en&token=${encodeURIComponent(tokData.token)}`,
    { Origin: HOST, Referer: referer, Accept: 'application/json' }
  ));
  let meta = {};
  try { meta = JSON.parse(det.text); } catch { /* metadata is best-effort */ }

  const q = new URLSearchParams({
    [fieldMap.id]: String(c.id),
    [fieldMap.path]: serverKey,
    [fieldMap.mediaType]: c.type,
    [fieldMap.ts]: String(tokData.ts ?? ''),
    [fieldMap.token]: tokData.token,
    [fieldMap.title]: String(meta.title || c.label || ''),
    [fieldMap.year]: String(String(meta.release_date || meta.first_air_date || '').slice(0, 4)),
    [fieldMap.date]: String(meta.release_date || meta.first_air_date || ''),
  });
  if (c.type === 'tv') {
    q.set(fieldMap.season, String(Number(c.season) || 1));
    q.set(fieldMap.episode, String(Number(c.episode) || 1));
    if (meta.last_air_date) q.set(fieldMap.latestDate, String(meta.last_air_date));
  }
  if (meta.imdb_id) q.set(fieldMap.imdbId, String(meta.imdb_id));

  const src = await withRetry(() => getText(
    `${HOST}/backend_/sources/${encodeURIComponent(serverKey)}?${q.toString()}`,
    { Origin: HOST, Referer: referer, Accept: 'application/json' }
  ));
  if (!src.status) return { err: `sources ERR ${src.error}` };

  let data;
  try {
    data = JSON.parse(src.text);
  } catch {
    // A 404 body distinguishes "route missing" from "unknown serverKey".
    const head = src.text.slice(0, 120).replace(/\s+/g, ' ');
    const nextNotFound = /This page could not be found|404/i.test(src.text) ? 'next404' : 'other';
    return { err: `sources non-json HTTP ${src.status} [${nextNotFound}] ${head}` };
  }

  const raw = Array.isArray(data?.links) ? data.links : [];
  const decoded = raw.map((item) => {
    let link = decryptCryptoJS(String(item?.link || ''), DECRYPTION_KEY);
    if (typeof link === 'string' && link.startsWith('/')) link = `https://vidstuck.cc${link}`;
    return { ...item, link };
  }).filter((i) => typeof i.link === 'string' && i.link.startsWith('http'));

  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '?'; } };
  const hosts = [...new Set(decoded.map((i) => hostOf(i.link)))];
  const kinds = [...new Set(decoded.map((i) => i.type || (i.link.includes('.mpd') ? 'dash' : 'hls')))];
  const quals = [...new Set(decoded.map((i) => i.quality).filter(Boolean))];

  return {
    http: src.status,
    rawCount: raw.length,
    count: decoded.length,
    hosts, kinds, quals,
    sample: decoded.slice(0, 3).map((i) => ({
      type: i.type, quality: i.quality, lang: i.lang,
      host: hostOf(i.link),
      ext: (i.link.match(/\.(m3u8|mpd|mp4)(\?|$)/) || [])[1] || 'none',
    })),
  };
}

const line = (r) =>
  `HTTP ${r.http} raw=${r.rawCount} kept=${r.count} kinds=${r.kinds.join(',') || '-'} ` +
  `quals=${r.quals.join(',') || '-'} hosts=${r.hosts.join('|') || '-'}`;

// Pass 1: one shared token, several serverKeys, same title.
const shared = {};
// Definition keys are lowercase ('atlas'); the display names ('AethoAtlas') are
// what the mirror *labels* them. Both are tried, because a 404 cannot tell us
// which one the route expects.
const SERVER_KEYS = ['atlas', 'AethoAtlas', 'valstrax', 'ursa', 'alatreon'];
const MOVIE = { type: 'movie', id: '550', label: 'Fight Club' };

log('=== pass 1: 6 serverKeys, movie/550, one shared token');
for (const key of SERVER_KEYS) {
  log('---', key);
  try {
    const r = await resolve(key, MOVIE, shared);
    if (r.err) { log('  result', r.err); continue; }
    log('  result', line(r));
    if (r.sample.length) log('  sample', JSON.stringify(r.sample));
  } catch (error) { log('  result', `threw ${error.message}`); }
  await new Promise((r) => setTimeout(r, 2500));
}

// Pass 2: TV, fresh token.
log('=== pass 2: TV, fresh token');
try {
  const r = await resolve('AethoAtlas', { type: 'tv', id: '1399', season: 1, episode: 1, label: 'Game of Thrones' }, {});
  if (r.err) log('  result', r.err);
  else {
    log('  result', line(r));
    if (r.sample.length) log('  sample', JSON.stringify(r.sample));
  }
} catch (error) { log('  result', `threw ${error.message}`); }

console.log('[zxc3:done]');
