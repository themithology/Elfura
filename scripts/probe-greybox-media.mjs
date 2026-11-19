#!/usr/bin/env node
/**
 * Do greyboxtv's own /api/media proxy URLs actually serve playable manifests?
 *
 * The sources payload mixes two URL shapes:
 *   - relative  /api/media?u=m1.xxxx        (a proxy on greyboxtv itself)
 *   - absolute  https://dash-hls-bridge...  (already a CDN)
 *
 * Only the absolute ones are proven. The relative ones dominate the payload, so
 * if they are dead then the source is a handful of streams, not 21. This fetches
 * each shape and reports whether the body is a real #EXTM3U rather than an
 * error page — the liveness sniff we actually gate on.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const ORIGIN = 'https://greyboxtv.duckdns.org';
const log = (t, v) => console.log(`[gbm] ${t} :: ${v}`);

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json,*/*', Referer: `${ORIGIN}/` },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function sniff(url, label) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: `${ORIGIN}/` },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const head = (await res.text()).slice(0, 400);
    const isM3u8 = head.trimStart().startsWith('#EXTM3U');
    const variants = (head.match(/#EXT-X-STREAM-INF/g) || []).length;
    const segs = (head.match(/#EXTINF|\.ts|\.m4s/g) || []).length;
    log(label, `HTTP ${res.status} m3u8=${isM3u8} variants=${variants} segRefs=${segs} ` +
      `ct=${res.headers.get('content-type') || '-'} head="${head.slice(0, 60).replace(/\s+/g, ' ')}"`);
    return isM3u8;
  } catch (error) {
    log(label, `ERR ${error?.cause?.code || error.name}`);
    return false;
  }
}

for (const [label, url] of [
  ['movie/1368337', `${ORIGIN}/api/player/sources?media=movie&id=1368337`],
  ['tv/71446 s1e1', `${ORIGIN}/api/player/sources?media=tv&id=71446&season=1&episode=1`],
]) {
  const { status, body } = await getJson(url);
  const sources = Array.isArray(body?.sources) ? body.sources : [];
  log(label, `HTTP ${status} sources=${sources.length}`);

  const rel = sources.filter((s) => typeof s.url === 'string' && s.url.startsWith('/'));
  const abs = sources.filter((s) => typeof s.url === 'string' && /^https?:\/\//.test(s.url));
  log(`  ${label} shapes`, `relative=${rel.length} absolute=${abs.length}`);

  // Prove the relative ones (the majority) resolve into real manifests.
  for (const s of rel.slice(0, 3)) {
    await sniff(`${ORIGIN}${s.url}`, `  ${label} rel ${s.provider}/${s.quality}/${s.language || 'und'}`);
  }
  for (const s of abs.slice(0, 2)) {
    await sniff(s.url, `  ${label} abs ${s.provider}/${s.quality}/${s.language || 'und'}`);
  }

  // A subtitle track, to confirm they are fetchable VTT/SRT and not gated.
  const withSubs = sources.find((s) => Array.isArray(s.subtitles) && s.subtitles.length);
  const sub = withSubs?.subtitles?.[0];
  if (sub?.url) {
    const su = sub.url.startsWith('/') ? `${ORIGIN}${sub.url}` : sub.url;
    try {
      const r = await fetch(su, { headers: { 'User-Agent': UA, Referer: `${ORIGIN}/` }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      const t = (await r.text()).slice(0, 200);
      log(`  ${label} subtitle`, `HTTP ${r.status} looks-vtt=${/WEBVTT|^\d+\s*$/m.test(t)} bytes=${t.length}`);
    } catch (error) {
      log(`  ${label} subtitle`, `ERR ${error?.cause?.code || error.name}`);
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.log('[gbm:done]');
