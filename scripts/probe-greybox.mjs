#!/usr/bin/env node
/**
 * What does greyboxtv's /api/player/sources actually return?
 *
 * A user reports this as a plain multi-language JSON source, which would make it
 * the simplest lane we have - no token, no encryption, no browser. That claim is
 * worth exactly one measurement: the response shape, the languages, and whether
 * the URLs are real manifests rather than embeds.
 *
 * Prints schema, counts and hosts. Never a full URL.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ORIGIN = 'https://greyboxtv.duckdns.org';
const log = (t, v) => console.log(`[gb] ${t} :: ${v}`);

async function probe(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        Referer: `${ORIGIN}/`,
        Origin: ORIGIN,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return { status: res.status, text, ct: res.headers.get('content-type') || '' };
  } catch (error) {
    const cause = error?.cause?.code || error.name;
    return { status: 0, text: '', error: String(cause) };
  }
}

/** Show the structure without dumping signed URLs. */
function describe(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.length}${value.length ? ' x ' + describe(value[0], depth + 1) : ''}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).slice(0, 12);
    if (depth > 2) return `{${keys.join(',')}}`;
    return `{${keys.map((k) => `${k}:${describe(value[k], depth + 1)}`).join(', ')}}`;
  }
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      try {
        const u = new URL(value);
        const ext = (u.pathname.match(/\.(m3u8|mpd|mp4|vtt|srt)(?:$|[?#])/i) || [])[1] || 'no-ext';
        return `url(${u.hostname}/${ext})`;
      } catch { return 'url(bad)'; }
    }
    return JSON.stringify(value.slice(0, 28));
  }
  return String(value);
}

const CASES = [
  { label: 'movie/1368337', url: `${ORIGIN}/api/player/sources?media=movie&id=1368337` },
  { label: 'tv/71446 s1e1', url: `${ORIGIN}/api/player/sources?media=tv&id=71446&season=1&episode=1` },
  { label: 'movie/550', url: `${ORIGIN}/api/player/sources?media=movie&id=550` },
  { label: 'tv/1399 s1e1', url: `${ORIGIN}/api/player/sources?media=tv&id=1399&season=1&episode=1` },
  { label: 'tv/94664 s1e1', url: `${ORIGIN}/api/player/sources?media=tv&id=94664&season=1&episode=1` },
  { label: 'movie/693134', url: `${ORIGIN}/api/player/sources?media=movie&id=693134` },
];

for (const c of CASES) {
  const r = await probe(c.url);
  if (!r.status) {
    log(c.label, `ERR ${r.error}`);
    continue;
  }
  if (!/json/i.test(r.ct)) {
    const title = (r.text.match(/<title[^>]*>([^<]{0,60})/i) || [])[1] || '';
    log(c.label, `HTTP ${r.status} NON-JSON ct=${r.ct} bytes=${r.text.length} title="${title.trim()}"`);
    continue;
  }
  let body;
  try { body = JSON.parse(r.text); } catch { log(c.label, `HTTP ${r.status} unparseable`); continue; }

  // Count manifests anywhere in the tree, and collect language-ish labels.
  const blob = JSON.stringify(body);
  const m3u8 = (blob.match(/\.m3u8/gi) || []).length;
  const mpd = (blob.match(/\.mpd/gi) || []).length;
  const hosts = [...new Set((blob.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map((u) => {
    try { return new URL(u).hostname; } catch { return '?'; }
  }))];
  const langs = [...new Set((blob.match(/"language"\s*:\s*"([^"]{1,24})"/gi) || [])
    .map((s) => s.replace(/.*"([^"]+)"$/, '$1')))];
  const quals = [...new Set((blob.match(/"quality"\s*:\s*"?([\w .-]{1,20})/gi) || [])
    .map((s) => s.replace(/.*:\s*"?/, '')))];

  log(c.label, `HTTP ${r.status} ct=${r.ct} bytes=${r.text.length} m3u8=${m3u8} mpd=${mpd}`);
  log(`  ${c.label} schema`, describe(body));
  if (langs.length) log(`  ${c.label} langs`, langs.slice(0, 20).join(','));
  if (quals.length) log(`  ${c.label} quals`, quals.slice(0, 12).join(','));
  if (hosts.length) log(`  ${c.label} hosts`, hosts.slice(0, 8).join('|'));
  await new Promise((r2) => setTimeout(r2, 600));
}

// Is the front page up, and does it hint at an API base?
const root = await probe(`${ORIGIN}/`);
log('root', root.status ? `HTTP ${root.status} bytes=${root.text.length}` : `ERR ${root.error}`);

console.log('[gb:done]');
