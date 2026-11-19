#!/usr/bin/env node
/**
 * Is the bingr "crack" real, and does the embed-host entry actually work where
 * our current source4 entry does not?
 *
 * Our source4 reaches bingr through https://bingr.st/watch/{type}/{id}, mines
 * the sealed v1. payload out of the RSC chunks, then races /api/sources across
 * every advertised server id. The mirror repo dodges all of that: it fetches
 * the plain embed page on vidly.pro / embed.filmu.in, and the sealed v1. blob
 * is sitting in the HTML, ready to unseal. No token, no API race.
 *
 * The unseal routine here is a straight port of ours (decodeBingrPayload in
 * source4.ts), which is itself byte-for-byte equivalent to the mirror's
 * bingrUnseal - same FNV-1a seed over SECRET||iv, same 4-word keystream. So the
 * cipher is NOT in question; only the entry host and what it serves.
 *
 * Reports the unsealed stream table (quality/lang/host), never a full URL.
 */
import crypto from 'node:crypto';

const SECRET = 'vY7#qL2!mZ9@wK4$';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[bingr] ${t} :: ${v}`);

/** Same algorithm as our decodeBingrPayload / their bingrUnseal. */
function unseal(blob) {
  const clean = String(blob || '').trim();
  if (!clean.startsWith('v1.')) throw new Error('not-v1');
  const bytes = Buffer.from(clean.slice(3), 'base64url');
  if (bytes.length < 13) throw new Error('short');
  const iv = bytes.subarray(0, 12);
  const data = Buffer.from(bytes.subarray(12));
  const seed = Buffer.concat([Buffer.from(SECRET, 'utf8'), iv]);
  let state = Array.from({ length: 4 }, (_, i) => {
    let x = (0x811c9dc5 ^ Math.imul(0x9e3779b9, i)) >>> 0;
    for (const byte of seed) x = Math.imul(x ^ byte, 0x1000193) >>> 0;
    return x;
  });
  let word = 0;
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 0) {
      const [a, b, c, oldD] = state;
      const d = (oldD + 1) >>> 0;
      word = (a + b + d) >>> 0;
      state = [
        (b ^ (b >>> 9)) >>> 0,
        Math.imul(c, 9) >>> 0,
        (((c << 21) | (c >>> 11)) + word) >>> 0,
        d,
      ];
    }
    data[i] ^= (word >>> ((i % 4) * 8)) & 255;
  }
  const text = data.toString('utf8');
  const end = text.lastIndexOf('}');
  if (end < 0) throw new Error('invalid-plaintext');
  return JSON.parse(text.slice(0, end + 1));
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://bingr.st/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    return { status: res.status, html: await res.text() };
  } catch (error) {
    return { status: 0, html: '', error: error.name };
  }
}

const HOSTS = ['https://vidly.pro', 'https://embed.filmu.in'];
const CASES = [
  { type: 'movie', id: '550', label: 'Fight Club' },
  { type: 'tv', id: '1399', season: 1, episode: 1, label: 'Game of Thrones' },
  { type: 'tv', id: '94664', season: 1, episode: 1, label: 'Mushoku Tensei' },
  { type: 'movie', id: '693134', label: 'Dune Part Two' },
];

for (const host of HOSTS) {
  for (const c of CASES) {
    const path =
      c.type === 'tv'
        ? `/embed/tv/${c.id}/${c.season}/${c.episode}`
        : `/embed/movie/${c.id}`;
    const r = await fetchPage(host + path);
    if (!r.status) {
      log(`${host}${path}`, `ERR ${r.error}`);
      continue;
    }
    const m = r.html.match(/v1\.[A-Za-z0-9_-]{40,}/);
    if (!m) {
      // Say what the page was, so "no blob" is distinguishable from "blocked".
      const title = (r.html.match(/<title[^>]*>([^<]{0,60})/i) || [])[1] || '';
      const cf = /cloudflare|just a moment|attention required/i.test(r.html) ? ' cf-challenge' : '';
      log(`${host}${path}`, `HTTP ${r.status} bytes=${r.html.length} blob=none${cf} title="${title.trim()}"`);
      continue;
    }
    let payload;
    try {
      payload = unseal(m[0]);
    } catch (error) {
      log(`${host}${path}`, `HTTP ${r.status} blob=${m[0].length}b unseal FAILED ${error.message}`);
      continue;
    }
    const streams = Array.isArray(payload?.streams) ? payload.streams : [];
    const hostOf = (u) => { try { return new URL(u).hostname; } catch { return '?'; } };
    const hosts = [...new Set(streams.map((s) => hostOf(s?.url)).filter((h) => h !== '?'))];
    const quals = [...new Set(streams.map((s) => s?.quality).filter(Boolean))];
    const langs = [...new Set(streams.map((s) => s?.language || s?.label).filter(Boolean))];
    const types = [...new Set(streams.map((s) => s?.type || (String(s?.url).includes('.mpd') ? 'dash' : 'hls')))];
    const subs = streams.reduce((n, s) => n + (Array.isArray(s?.subtitles) ? s.subtitles.length : 0), 0);
    log(
      `${host}${path}`,
      `HTTP ${r.status} blob=${m[0].length}b provider=${payload?.provider?.label || payload?.provider?.id || '-'} ` +
      `streams=${streams.length} types=${types.join(',') || '-'} quals=${quals.join(',') || '-'} ` +
      `langs=${langs.slice(0, 6).join(',') || '-'} subs=${subs} hosts=${hosts.slice(0, 4).join('|') || '-'}`
    );
    await new Promise((res) => setTimeout(res, 700));
  }
}

// Control: can a datacenter IP even reach the canonical watch page?
const ctl = await fetchPage('https://bingr.st/watch/movie/550');
const ctlBlob = ctl.html.match(/v1\.[A-Za-z0-9_-]{40,}/);
log('control bingr.st/watch/movie/550', ctl.status
  ? `HTTP ${ctl.status} bytes=${ctl.html.length} blob=${ctlBlob ? 'yes' : 'no'}`
  : `ERR ${ctl.error}`);

console.log('[bingr:done]');
