#!/usr/bin/env node
/**
 * Does zxcstream actually hand over playable streams, and is the 31-server list
 * real or 31 labels on 4 backends?
 *
 * The previous probes were wrong twice over: the token endpoint rotates (now
 * discovered from the JS chunks) and the request field names are obfuscated hex
 * keys. The source call is NOT the details call either - details only returns
 * metadata. The real one is:
 *
 *   GET /backend_/sources/{serverKey}?<obfuscated field map>=...
 *   -> links[].link is base64 "Salted__" AES-256-CBC
 *
 * decrypted with an OpenSSL-compatible EVP_BytesToKey derivation (the mirror's
 * decryptCryptoJS). This probe runs that whole chain end to end and, crucially,
 * asks the SAME title from several serverKeys to test whether the 31 named
 * servers are distinct backends or four backends relabelled.
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
log('token endpoint', tokenEndpoint || 'NOT FOUND');
log('field map', fieldMap.id ? 'acquired' : 'NOT FOUND');
if (!tokenEndpoint || !fieldMap.id) {
  console.log('[zxc3:done]');
  process.exit(0);
}

// ---- resolve one title on one serverKey -----------------------------------
async function resolve(serverKey, c) {
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

  const tok = await postJson(`${HOST}${tokenEndpoint}`, tokenBody, referer);
  if (!tok.status) return { err: `token ERR ${tok.error}` };
  let tokData;
  try { tokData = JSON.parse(tok.text); } catch { return { err: `token non-json HTTP ${tok.status}` }; }
  if (!tokData?.token) return { err: `token HTTP ${tok.status} no token` };

  // Metadata gives us title/year/date, which the source query wants.
  const det = await getText(
    `${HOST}/backend/imdb/details/${c.type}/${c.id}?language=en&token=${encodeURIComponent(tokData.token)}`,
    { Origin: HOST, Referer: referer, Accept: 'application/json' }
  );
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

  const src = await getText(
    `${HOST}/backend_/sources/${encodeURIComponent(serverKey)}?${q.toString()}`,
    { Origin: HOST, Referer: referer, Accept: 'application/json' }
  );
  if (!src.status) return { err: `sources ERR ${src.error}` };

  let data;
  try { data = JSON.parse(src.text); } catch { return { err: `sources non-json HTTP ${src.status}` }; }

  const raw = Array.isArray(data?.links) ? data.links : [];
  const decoded = raw.map((item) => {
    let link = decryptCryptoJS(String(item?.link || ''), DECRYPTION_KEY);
    if (typeof link === 'string' && link.startsWith('/')) link = `https://vidstuck.cc${link}`;
    return { ...item, link };
  }).filter((i) => typeof i.link === 'string' && i.link.startsWith('http'));

  const hosts = [...new Set(decoded.map((i) => {
    try { return new URL(i.link).hostname; } catch { return '?'; }
  }))];
  const kinds = [...new Set(decoded.map((i) => i.type || (i.link.includes('.mpd') ? 'dash' : 'hls')))];
  const quals = [...new Set(decoded.map((i) => i.quality).filter(Boolean))];

  return {
    http: src.status,
    rawCount: raw.length,
    count: decoded.length,
    hosts,
    kinds,
    quals,
    keys: Object.keys(data).slice(0, 8),
    sample: decoded.slice(0, 2).map((i) => ({
      type: i.type, quality: i.quality, lang: i.lang,
      // host + path only, never the full signed URL
      host: (() => { try { return new URL(i.link).hostname; } catch { return '?'; } })(),
      ext: (i.link.match(/\.(m3u8|mpd|mp4)(\?|$)/) || [])[1] || 'none',
    })),
  };
}

const CASES = [
  { key: 'AethoAtlas', c: { type: 'movie', id: '550', label: 'Fight Club' } },
  { key: 'AethoAtlas', c: { type: 'tv', id: '1399', season: 1, episode: 1, label: 'Game of Thrones' } },
  { key: 'AethoValstrax', c: { type: 'movie', id: '550', label: 'Fight Club' } },
  { key: 'AethoUrsa', c: { type: 'movie', id: '550', label: 'Fight Club' } },
  { key: 'AethoAlatreon', c: { type: 'movie', id: '550', label: 'Fight Club' } },
  { key: 'AethoOrion', c: { type: 'movie', id: '550', label: 'Fight Club' } },
  { key: 'AethoRousav', c: { type: 'movie', id: '550', label: 'Fight Club' } },
];

for (const { key, c } of CASES) {
  log('---', `${key} ${c.type}/${c.id}`);
  try {
    const r = await resolve(key, c);
    if (r.err) { log('  result', r.err); continue; }
    log('  result', `HTTP ${r.http} raw=${r.rawCount} kept=${r.count} kinds=${r.kinds.join(',') || '-'} quals=${r.quals.join(',') || '-'} hosts=${r.hosts.join('|') || '-'}`);
    if (r.sample.length) log('  sample', JSON.stringify(r.sample));
  } catch (error) {
    log('  result', `threw ${error.message}`);
  }
  await new Promise((r) => setTimeout(r, 1200)); // be polite; 429s seen earlier
}

console.log('[zxc3:done]');
