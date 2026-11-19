#!/usr/bin/env node
/**
 * Can we get TGVID's streams WITHOUT a browser?
 *
 * Evidence this is worth asking: TGVID plays for real. In a browser, one run
 * showed "Fight Club 0:02 / 2:19:08" and "Game of Thrones S1E1 0:05 / 1:01:36"
 * with these manifests answering 200:
 *
 *   cdn.mhbdtv.top/stream/<uuid>/master.m3u8      application/vnd.apple.mpegurl
 *   stream.cdnmhbd.top/v/<uuid>/video.m3u8        application/vnd.apple.mpegurl
 *   img1.fcxmb.com/hls_mps/<hash>/720/index_266.m3u8
 *
 * There were zero POSTs and zero JSON responses, so the player is not calling
 * an API — it is a server-rendered app, which means the manifest URL is almost
 * certainly embedded in the HTML itself. If so we can read it with a plain
 * fetch: no browser, no per-title cost, no dependency on their player.
 *
 * This tests exactly that, and then tests whether the CDN hands the bytes to a
 * backend. Those are two independent questions and both must be yes.
 */
const BASE = (process.env.TGVID_BASE || 'https://tgvid.lovable.app').replace(/\/+$/, '');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[tgv3] ${t} :: ${v}`);

async function get(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    });
    return {
      status: res.status,
      text: await res.text(),
      ct: res.headers.get('content-type') || '',
    };
  } catch (error) {
    return { status: 0, text: '', error: error.name };
  }
}

const ROUTES = [
  ['movie', '550', '/embed/movie/550'],
  ['tv', '1399/1/1', '/embed/tv/1399/1/1'],
  ['movie', '1007757', '/embed/movie/1007757'],
  ['tv', '94664/1/1', '/embed/tv/94664/1/1'],
];

const found = [];

for (const [kind, id, route] of ROUTES) {
  const r = await get(`${BASE}${route}`);
  if (!r.status) {
    log(route, `ERR ${r.error}`);
    continue;
  }
  // Any absolute media URL in the document, escaped or not. Server-rendered
  // payloads usually JSON-encode them, so backslashes are stripped first.
  const flat = r.text.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
  const urls = [...new Set(
    (flat.match(/https?:\/\/[^\s"'<>\\]+?(?:\.m3u8|\.mpd)(?:\?[^\s"'<>\\]*)?/gi) || []),
  )];
  const hosts = [...new Set(urls.map((u) => { try { return new URL(u).hostname; } catch { return '?'; } }))];
  log(route, `HTTP ${r.status} ${r.text.length}B media=${urls.length} hosts=${hosts.join(',') || '-'}`);
  for (const u of urls.slice(0, 6)) found.push({ kind, id, url: u });
}

// Second question, the one that decides viability: does the CDN answer a
// backend fetch? A manifest that only a browser can read is another dead end,
// and I would rather find that out here than after writing an adapter.
log('--- CDN reachability from the runner ---');
const seenHosts = new Set();
for (const f of found) {
  let host;
  try { host = new URL(f.url).hostname; } catch { continue; }
  if (seenHosts.has(host)) continue;
  seenHosts.add(host);
  const r = await get(f.url, { Range: 'bytes=0-4096' });
  if (!r.status) {
    log(`cdn ${host}`, `ERR ${r.error}`);
    continue;
  }
  const head = r.text.slice(0, 100).replace(/\s+/g, ' ');
  const isPlaylist = /#EXTM3U|<MPD/.test(r.text.slice(0, 512));
  log(`cdn ${host}`, `HTTP ${r.status} ct=${r.ct} playlist=${isPlaylist} :: ${head}`);
}

log('media urls found', found.length);
for (const f of found.slice(0, 12)) {
  try {
    log('  url', `${f.kind}/${f.id} ${new URL(f.url).hostname}${new URL(f.url).pathname.slice(0, 46)}`);
  } catch { /* ignore */ }
}

console.log('[tgv3:done]');
