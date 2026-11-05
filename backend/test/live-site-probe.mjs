/**
 * Live deployed-site probe (CI/manual only).
 *
 * Runs the real browser flow against a deployed Elfura origin:
 *   1. GET  /api/v1/catalog            (TMDB sanity)
 *   2. POST /api/v1/session            (mint pltoken, same UA throughout)
 *   3. GET  /api/v1/playback           (combined, source-1, source-2, source-3)
 *   4. GET  primary stream manifest    (real manifest bytes via relay)
 * Reports only counts/labels/statuses via GitHub annotations — never URLs,
 * tokens, or provider identifiers.
 */
const SITE = (process.env.SITE_ORIGIN || 'https://embed.theogpiratebot.online').replace(/\/+$/, '');
const TYPE = (process.env.PROBE_TYPE || 'movie') === 'tv' ? 'tv' : 'movie';
const TMDB = process.env.PROBE_TMDB || '693134';
const SEASON = process.env.PROBE_SEASON || '1';
const EPISODE = process.env.PROBE_EPISODE || '1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function annotate(level, title, message) {
  const clean = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${level} title=${title}::${clean}`);
}

async function req(path, init = {}) {
  const t0 = performance.now();
  const res = await fetch(`${SITE}${path}`, {
    ...init,
    headers: { 'User-Agent': UA, Origin: SITE, ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const ms = Math.round(performance.now() - t0);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, ms, json, text };
}

let failures = 0;

// 1) Catalog / TMDB sanity
try {
  const cat = await req('/api/v1/catalog');
  const counts = cat.json
    ? `movies=${cat.json.movies?.length ?? '?'} series=${cat.json.series?.length ?? '?'} anime=${cat.json.anime?.length ?? '?'}`
    : 'non-json';
  annotate(cat.json?.ok ? 'notice' : 'error', 'SiteCatalog', `HTTP ${cat.status} in ${cat.ms}ms ${counts}`);
  if (!cat.json?.ok || !(cat.json.movies?.length || cat.json.series?.length || cat.json.anime?.length)) failures++;
} catch (e) {
  failures++;
  annotate('error', 'SiteCatalog', `request failed: ${e.message}`);
}

// 2) Session mint
let token = '';
try {
  const ses = await req('/api/v1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: `${SITE}/${TYPE === 'tv' ? `embed/tv/${TMDB}/${SEASON}/${EPISODE}` : `embed/movie/${TMDB}`}` },
    body: JSON.stringify({ type: TYPE, tmdb: TMDB, ...(TYPE === 'tv' ? { season: Number(SEASON), episode: Number(EPISODE) } : {}) }),
  });
  token = ses.json?.pltoken || '';
  annotate(token ? 'notice' : 'error', 'SiteSession', `HTTP ${ses.status} in ${ses.ms}ms token=${token ? 'minted' : 'MISSING'} error=${ses.json?.error || '-'}`);
  if (!token) failures++;
} catch (e) {
  failures++;
  annotate('error', 'SiteSession', `request failed: ${e.message}`);
}

// 3) Playback per source + combined
const seasonQ = TYPE === 'tv' ? `&s=${SEASON}&e=${EPISODE}` : '';
let primaryUrl = '';
let combinedUrls = [];
if (token) {
  for (const source of ['combined', 'source-1', 'source-2', 'source-3']) {
    try {
      const srcQ = source === 'combined' ? '' : `&source=${source}`;
      const pb = await req(`/api/v1/playback?type=${TYPE}&tmdb=${TMDB}${seasonQ}${srcQ}`, {
        headers: { 'X-Playback-Token': token, Referer: `${SITE}/` },
      });
      const sources = Array.isArray(pb.json?.sources) ? pb.json.sources : [];
      const labels = sources.slice(0, 6).map((s) => `${s.label}|${s.type}|${s.quality || 'auto'}`).join('; ');
      annotate(
        sources.length ? 'notice' : 'error',
        'SitePlayback',
        `${source}: HTTP ${pb.status} in ${pb.ms}ms ok=${pb.json?.ok ?? false} options=${sources.length} error=${pb.json?.error || '-'} [${labels}]`,
      );
      if (!sources.length) failures++;
      if (source === 'combined' && sources.length) {
        primaryUrl = sources[0].url || '';
        combinedUrls = sources.slice(0, 3).map((s) => s.url).filter(Boolean);
      }
    } catch (e) {
      failures++;
      annotate('error', 'SitePlayback', `${source}: request failed: ${e.message}`);
    }
  }
}

// 4) Primary manifest bytes through the relay
async function probeManifest(candidateUrl, idx) {
  const abs = new URL(candidateUrl, SITE).toString();
  try {
    const t0 = performance.now();
    const res = await fetch(abs, {
      headers: { 'User-Agent': UA, Origin: SITE, Referer: `${SITE}/`, ...(token ? { 'X-Playback-Token': token } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const kind = text.trimStart().startsWith('#EXTM3U') ? 'HLS' : text.includes('<MPD') ? 'DASH' : 'other';
    const ok = res.ok && kind !== 'other';
    annotate(
      ok ? 'notice' : 'error',
      'SiteStream',
      `option ${idx + 1} manifest: HTTP ${res.status} in ${Math.round(performance.now() - t0)}ms kind=${kind} bytes=${text.length}`,
    );
    if (!ok) return false;
    // Time the first real media segment referenced by the (rewritten) manifest.
    if (kind === 'HLS') {
      const segRef = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (segRef) {
        try {
          const segUrl = new URL(segRef, abs).toString();
          const s0 = performance.now();
          const segRes = await fetch(segUrl, {
            headers: { 'User-Agent': UA, Origin: SITE, Referer: `${SITE}/`, Range: 'bytes=0-1023', ...(token ? { 'X-Playback-Token': token } : {}) },
            signal: AbortSignal.timeout(15_000),
          });
          const buf = segRes.body ? Buffer.from(await segRes.arrayBuffer()) : Buffer.alloc(0);
          const segOk = (segRes.ok || segRes.status === 206) && buf.byteLength > 0;
          annotate(
            segOk ? 'notice' : 'error',
            'SiteSegment',
            `option ${idx + 1} first segment: HTTP ${segRes.status} in ${Math.round(performance.now() - s0)}ms bytes=${buf.byteLength}`,
          );
          return segOk;
        } catch (e) {
          annotate('error', 'SiteSegment', `option ${idx + 1} first segment failed: ${e.message}`);
          return false;
        }
      }
    }
    return true;
  } catch (e) {
    annotate('error', 'SiteStream', `option ${idx + 1} manifest failed: ${e.message}`);
    return false;
  }
}

if (combinedUrls.length) {
  let anyOk = false;
  for (let i = 0; i < combinedUrls.length && !anyOk; i++) {
    anyOk = await probeManifest(combinedUrls[i], i);
  }
  if (!anyOk) failures++;
}

annotate(failures ? 'error' : 'notice', 'SiteProbeSummary', `${SITE} ${TYPE} ${TMDB}: failures=${failures}`);
if (failures) process.exitCode = 1;
