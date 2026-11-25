#!/usr/bin/env node
/**
 * A minimal nxsha client for research probes.
 *
 * The retired adapter at backend/attic/sources/source5.ts already implements this
 * protocol, but importing it from a probe does not work: attic is not compiled,
 * and its own imports were rewritten when it moved (`../security.js` and
 * `../src/sources/liveness.js` no longer resolve from that directory). Rather
 * than patch a retired file to keep it loadable, the ~60 lines that matter live
 * here, so a probe has no dependency on code that is not supposed to run.
 *
 * Protocol, as measured:
 *   q = base64url("Salted__" + salt[8] + AES-256-CBC(json, key, iv))
 *   key material = iterated MD5(pass, salt) -> 32-byte key + 16-byte IV
 *   GET /api/servers?q=...  -> { _hash }  -> same envelope -> { servers: [{scraper}] }
 *   GET /api/sources?q=...  -> { _hash }  -> same envelope -> { sources: [{url,language,...}] }
 *
 * The passphrase is a public front-end constant that rotates on redeploy, so the
 * known history is tried in order.
 */
import crypto from 'node:crypto';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

export const ORIGIN = 'https://nxsha.space';

/** Known public front-end passphrases, current first. */
export const PASSES = [
  '38c8cd65d781936f4b9fe1fd985234fd7335699855051abf76ea3493bcfc0120',
  'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3',
  'S8x!Jk4ZP1uG8$my',
];

function derive(salt, pass) {
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from(pass), salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

export function encode(body, pass = PASSES[0]) {
  const salt = crypto.randomBytes(8);
  const { key, iv } = derive(salt, pass);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const plain = JSON.stringify({
    ...body,
    _req_ts: Date.now(),
    _req_salt: crypto.randomBytes(6).toString('base64url'),
  });
  return Buffer.concat([
    Buffer.from('Salted__'),
    salt,
    cipher.update(plain),
    cipher.final(),
  ]).toString('base64url');
}

export function decodeWith(input, pass) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(input))) throw new Error('not-base64url');
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.length < 32) throw new Error('too-short');
  if (bytes.subarray(0, 8).toString() !== 'Salted__') throw new Error('bad-magic');
  const { key, iv } = derive(bytes.subarray(8, 16), pass);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** Open an envelope with whichever recorded passphrase still works. */
export function decode(input) {
  let last;
  for (const pass of PASSES) {
    try {
      return { payload: decodeWith(input, pass), pass: pass.slice(0, 8) + '…' };
    } catch (error) {
      last = error;
    }
  }
  throw last ?? new Error('undecodable');
}

/**
 * Ask one API endpoint and open the reply.
 *
 * Returns `{ payload, error }` rather than throwing, because a probe needs the
 * reason in the row and a caller needs to tell "refused" from "new key".
 */
export async function call(endpoint, body, { origin = ORIGIN, timeout = 20_000 } = {}) {
  const url = `${origin}/api/${endpoint}?q=${encodeURIComponent(encode(body))}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: `${origin}/`,
        Origin: origin,
      },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
  } catch (error) {
    const cause = error?.cause?.code ?? '';
    return { status: null, error: `${error?.name}: ${error?.message}${cause ? ` (${cause})` : ''}` };
  }
  const text = await response.text();
  if (!response.ok) return { status: response.status, error: `http=${response.status}`, body: text.slice(0, 120) };
  let envelope;
  try {
    envelope = JSON.parse(text)._hash;
  } catch {
    return { status: response.status, error: 'no-json', body: text.slice(0, 120) };
  }
  if (typeof envelope !== 'string') return { status: response.status, error: 'no-envelope', body: text.slice(0, 120) };
  try {
    const { payload, pass } = decode(envelope);
    return { status: response.status, payload, pass };
  } catch (error) {
    return { status: response.status, error: `undecodable:${error?.message}`, envelope };
  }
}

/** The scraper names it currently lists. */
export async function scrapers(query, options = {}) {
  const body = {
    tmdbId: query.tmdbId,
    imdb_id: '',
    type: query.type,
    season: query.type === 'tv' ? (query.season ?? 1) : 0,
    episode: query.type === 'tv' ? (query.episode ?? 1) : 0,
  };
  const answer = await call('servers', body, options);
  if (!answer.payload) return { error: answer.error ?? 'no payload', names: [] };
  const names = [...new Set((answer.payload.servers ?? []).map((s) => s?.scraper).filter(Boolean))];
  return { names, pass: answer.pass, error: null };
}

/**
 * Every HLS row from one lane, shaped like an adapter result.
 *
 * Only https, only .m3u8 (or an explicit hls type), only non-embed rows - the
 * same admission rules the retired adapter applied, so a probe does not credit
 * this candidate with candidates the board would refuse anyway.
 */
export async function laneSources(query, lane, options = {}) {
  const body = {
    tmdbId: query.tmdbId,
    imdb_id: '',
    type: query.type,
    season: query.type === 'tv' ? (query.season ?? 1) : 0,
    episode: query.type === 'tv' ? (query.episode ?? 1) : 0,
    ex_lang: true,
    provider: lane,
  };
  const answer = await call('sources', body, options);
  if (!answer.payload) return { error: answer.error ?? 'no payload', rows: [] };
  const rows = (Array.isArray(answer.payload.sources) ? answer.payload.sources : [])
    .filter((s) => typeof s?.url === 'string')
    .filter((s) => /^https:\/\//i.test(s.url))
    .filter((s) => !s.isEmbed && !/embed/i.test(String(s.type ?? '')))
    .filter((s) => /\.m3u8(?:[?#]|$)/i.test(s.url) || /^(hls|m3u8)$/i.test(String(s.type ?? '')))
    .map((s) => ({
      key: s.url,
      url: s.url,
      type: 'hls',
      quality: String(s.quality ?? s.label ?? 'auto'),
      audioLang: String(s.language ?? s.label ?? '').slice(0, 24) || undefined,
    }));
  return { rows, error: null };
}
