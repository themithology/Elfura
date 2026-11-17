#!/usr/bin/env node
/**
 * Why does source-4 read 403 on bingr.one/watch when a plain fetch reads 200?
 *
 * Both requests hit the same URL, so the difference is in the request, not the
 * upstream. Two things differ between our adapter and a bare fetch:
 *
 *   1. Referer. The adapter sends Referer = the URL it is fetching
 *      (ORIGIN + path), i.e. it refers to itself. A WAF scoring that as
 *      abnormal is entirely plausible.
 *   2. Redirect mode. Our guarded fetch always uses redirect:'manual'; a bare
 *      fetch follows. If bingr 30x-hops, the two paths diverge completely.
 *
 * Rather than guess, this runs the 2x2 across both embed hosts as well, so the
 * fix is chosen from measured behaviour.
 */
const UA22 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36';
const UA131 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const log = (t, v) => console.log(`[bent] ${t} :: ${v}`);

const PATH = '/watch/movie/550';
const FULL = `https://bingr.one${PATH}`;

const VARIANTS = [
  { name: 'manual+selfReferer+UA22', redirect: 'manual', referer: FULL, ua: UA22 },
  { name: 'manual+originReferer+UA22', redirect: 'manual', referer: 'https://bingr.one/', ua: UA22 },
  { name: 'manual+noReferer+UA22', redirect: 'manual', referer: null, ua: UA22 },
  { name: 'follow+selfReferer+UA22', redirect: 'follow', referer: FULL, ua: UA22 },
  { name: 'follow+originReferer+UA22', redirect: 'follow', referer: 'https://bingr.one/', ua: UA22 },
  { name: 'manual+selfReferer+UA131', redirect: 'manual', referer: FULL, ua: UA131 },
  { name: 'follow+noReferer+UA131', redirect: 'follow', referer: null, ua: UA131 },
];

for (const v of VARIANTS) {
  const headers = { 'User-Agent': v.ua, Accept: '*/*' };
  if (v.referer) headers.Referer = v.referer;
  try {
    const res = await fetch(FULL, {
      headers,
      redirect: v.redirect,
      signal: AbortSignal.timeout(12_000),
    });
    const body = await res.text();
    const blob = /v1\.[A-Za-z0-9_-]{40,}/.test(body) ? 'blob=yes' : 'blob=no';
    const loc = res.headers.get('location');
    log(
      v.name,
      `HTTP ${res.status} ${blob} bytes=${body.length}${loc ? ` location=${loc}` : ''}`
    );
  } catch (error) {
    log(v.name, `ERR ${error.name}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}

// The entry hosts our adapter does not currently use.
for (const host of ['https://vidly.pro', 'https://embed.filmu.in']) {
  try {
    const res = await fetch(`${host}/embed/movie/550`, {
      headers: {
        'User-Agent': UA131,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: 'https://bingr.one/',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    });
    const body = await res.text();
    log(
      `${host} (manual)`,
      `HTTP ${res.status} ${/v1\.[A-Za-z0-9_-]{40,}/.test(body) ? 'blob=yes' : 'blob=no'} bytes=${body.length}`
    );
  } catch (error) {
    log(`${host} (manual)`, `ERR ${error.name}`);
  }
}

console.log('[bent:done]');
