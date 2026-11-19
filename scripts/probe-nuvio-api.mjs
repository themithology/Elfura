#!/usr/bin/env node
/**
 * Which Nuvio providers are real JSON APIs and which are HTML scrapes?
 *
 * The Nuvio repo has 51 distinct providers (419 files are version iterations).
 * Two are already ours (vaplayer, xpass). The rest split into two very
 * different kinds of work:
 *
 *   JSON API    -> an adapter is a fetch + map. Cheap, stable, deterministic.
 *   HTML scrape -> an adapter needs the page shape, which changes, breaks, and
 *                  needs its own maintenance per provider.
 *
 * So before writing any adapter, this classifies them by measurement: does the
 * endpoint the Nuvio provider calls return JSON, a playlist, or HTML? A plain
 * HTML answer is not an API no matter what the provider file calls it.
 *
 * Reports host, query-less path, status, content-type and a short shape. The
 * shape is enough to know whether a stream list is in there; it never prints a
 * full stream URL.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[napi] ${t} :: ${v}`);

/** TMDB ids that exist, so a 404 cannot be blamed on the title. */
const MOVIE = '550'; // Fight Club
const TV = '1399'; // Game of Thrones
const TV_S = '1';
const TV_E = '1';

async function get(label, url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, */*', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const ct = (res.headers.get('content-type') || '').split(';')[0];
    let u;
    try { u = new URL(res.url || url); } catch { u = new URL(url); }

    // Classify: what did we actually get?
    let kind = 'html';
    if (/json/.test(ct)) kind = 'json';
    else if (text.trimStart().startsWith('#EXTM3U')) kind = 'playlist';
    else if (/json/.test(ct) === false && text.trimStart().startsWith('{')) kind = 'json-body';

    let shape = '';
    if (kind === 'json' || kind === 'json-body') {
      try {
        const j = JSON.parse(text);
        const keys = Array.isArray(j) ? `[${j.length}]` : Object.keys(j).slice(0, 8).join(',');
        const arrs = Array.isArray(j)
          ? ''
          : Object.entries(j)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => `${k}[${v.length}]`)
              .slice(0, 5)
              .join(' ');
        shape = `keys=${keys} ${arrs}`;
      } catch {
        shape = `unparsed:${text.slice(0, 40)}`;
      }
    } else if (kind === 'playlist') {
      const variants = (text.match(/#EXT-X-STREAM-INF/g) || []).length;
      const tracks = (text.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
      shape = `playlist variants=${variants} audio=${tracks}`;
    } else {
      shape = `head=${text.slice(0, 70).replace(/\s+/g, ' ')}`;
    }
    log(label, `HTTP ${res.status} ${u.hostname}${u.pathname.slice(0, 40)} ct=${ct} kind=${kind} ${shape}`);
  } catch (error) {
    log(label, `ERR ${error.name}`);
  }
}

const H = (ref) => ({ Referer: ref, Origin: new URL(ref).origin });

// Each entry is [label, url, headers]. Only endpoints the Nuvio provider files
// actually call, taken from their source — not guessed.
const CASES = [
  // --- JSON APIs: highest value if they answer ---
  ['vidlink:api/b', `https://vidlink.pro/api/b/movie/${MOVIE}`, H('https://vidlink.pro/')],
  ['vidlink:api/b/tv', `https://vidlink.pro/api/b/tv/${TV}/${TV_S}/${TV_E}`, H('https://vidlink.pro/')],
  ['enc-dec:enc-vidlink', `https://enc-dec.app/api/enc-vidlink?text=${MOVIE}`, H('https://enc-dec.app/')],
  // multimovies -> MovieBox-via-speedracelight
  ['speedracelight:find', `https://db.speedracelight.com/3/find/${MOVIE}?type=movie`, H('https://multimovies.top/')],
  // meowtv
  ['meowtv:root', 'https://meowtv.ru/', {}],
  ['meowtv:play', `https://meowtv.ru/play/${MOVIE}`, H('https://meowtv.ru/')],
  // zxcstream -> vidbolt (we already do this one)
  ['zxcstream:root', 'https://zxcstream.com/', {}],
  // netmirror
  ['netmirror:userver', 'https://userver.net52.cc/', {}],
  ['videodownloader:root', 'https://videodownloader.site/', {}],
  // animedekho
  ['animedekho:play', `https://animedekho.tv/aaa/get/play.php?id=${MOVIE}`, H('https://animedekho.tv/')],
  ['animedekho:root', 'https://animedekho.tv/', {}],
  // dooflix (xpass + 2embed)
  ['dooflix:xpass', `https://play.xpass.top/play/${MOVIE}`, H('https://play.xpass.top/')],
  ['dooflix:2embed', `https://streamsrcs.2embed.cc/swish?id=${MOVIE}`, H('https://www.2embed.cc/')],
  // --- HTML scrapes: cheap to check, likely html ---
  ['goojara:search', `https://www.goojara.to/xhrr.php?q=${encodeURIComponent('fight club')}`, H('https://www.goojara.to/')],
  ['vegamovies:root', 'https://vegamovies.moi/', {}],
  ['hdhub4u:root', 'https://hdhub4u.re/', {}],
  ['uhdmovies:root', 'https://uhdmovies.pink/', {}],
  ['fourkdhub:root', 'https://4kdhub.cyou/', {}],
  ['castletv:root', 'https://castletv.net/', {}],
  ['allmovieland:root', 'https://allmovieland.top/', {}],
  ['showbox:root', 'https://showbox.media/', {}],
  ['streamflix:root', 'https://streamflix.to/', {}],
  ['xon:root', 'https://xon.is/', {}],
];

for (const [label, url, headers] of CASES) await get(label, url, headers);

// Aggregate: the point is a shortlist, not a wall of lines.
console.log('[napi:done]');
