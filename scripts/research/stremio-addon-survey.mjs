#!/usr/bin/env node
/**
 * Can a Stremio addon be a source? Measured, not assumed.
 *
 * ---------------------------------------------------------------
 * A Stremio addon is just an HTTP service speaking a documented protocol:
 *
 *   GET {base}/manifest.json
 *   GET {base}/stream/{type}/{id}.json      type: movie | series
 *
 * So nothing about the protocol is a barrier. The barrier is WHAT a stream
 * object contains:
 *
 *   { url: "https://..." }        -> direct HTTP/HLS, playable through our proxy
 *   { infoHash: "...", ... }      -> a TORRENT. Needs a debrid service or a P2P
 *                                    client. We have neither, and we do not
 *                                    torrent. Unusable.
 *   { externalUrl: "..." }        -> a link to open elsewhere. Not playable.
 *   { ytId: "..." }               -> YouTube. Not usable.
 *
 * So the only question that matters is the RATIO of direct URLs, per addon, on
 * Indian titles. Everything else about an addon -- catalogue breadth, "everything
 * literally everything", language claims -- is a label until we see a url.
 *
 * This has burned us before. The nxsha board was built on a survey of two
 * Western titles and quietly discarded eleven Indian lanes. The same mistake here
 * would be asking an American film and declaring the addon empty.
 *
 * WHAT THIS PROBE DOES
 * --------------------
 *   - fetches each addon's manifest (a malformed manifest is a fact worth having)
 *   - asks each for the SAME four titles across four catalogues:
 *       Fight Club   tt0137523   Western film -- the board's own gate title
 *       RRR          tt8178634   Indian, Hindi/Tamil/Telugu
 *       Jawan        tt15354916  Hindi
 *       Squid Game   tt10919420  K-drama (tv)
 *   - classifies every stream object and tallies url / infoHash / externalUrl
 *   - prints, for direct streams, the height and any language words in the title
 *
 * Exit code 0 always: this is a survey, not a gate. A dead addon is a result.
 */

const TIMEOUT_MS = 20_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * Candidate addons, each with the REASON it is on the list. Public, no-account
 * instances only -- anything needing a debrid key or a paid tier cannot serve a
 * zero-budget, zero-disk board and is not worth measuring.
 */
const ADDONS = [
  {
    id: 'ggplay',
    base: 'https://ggplay-gf.vercel.app',
    note: 'HTTP/HLS only, claims 4K + multi-audio. README lists its upstreams as Vidlink/Videasy/Cinejoy/VixSrc/VAPlayer/DirectWeb — three of which this board has already measured and rejected, so the interesting question is whether anything is left.',
  },
  {
    id: 'nuviostreams',
    base: 'https://nuviostreams.hayd.uk',
    note: 'HTTP direct, multi-provider, TMDB+IMDb ids.',
  },
  {
    id: 'mediafusion',
    base: 'https://mediafusion.elfhosted.com',
    note: 'Widest catalogue of the set — Tamil/Hindi/Malayalam/Kannada scrapers. Expected to be torrent-heavy; the direct ratio is the whole question.',
  },
  {
    id: 'webstreamr',
    base: 'https://webstreamr.hayd.uk',
    note: 'HTTP from streaming sites. MediaFlow proxy reportedly needed for some hosters.',
  },
];

const TITLES = [
  { id: 'tt0137523', type: 'movie', label: 'fight-club', cat: 'western' },
  { id: 'tt8178634', type: 'movie', label: 'rrr', cat: 'indian' },
  { id: 'tt15354916', type: 'movie', label: 'jawan', cat: 'indian' },
  { id: 'tt10919420', type: 'series', label: 'squid-game', cat: 'kdrama', season: 1, episode: 1 },
];

const LANG_WORDS = [
  'hindi', 'tamil', 'telugu', 'malayalam', 'kannada', 'punjabi', 'bengali', 'marathi',
  'english', 'korean', 'japanese', 'chinese', 'cantonese', 'mandarin', 'thai', 'spanish',
  'french', 'german', 'italian', 'portuguese', 'russian', 'arabic', 'turkish',
  'multi', 'dual', 'dub', 'sub',
];

const get = async (url) => {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json,*/*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  const body = await res.text();
  return { status: res.status, body };
};

/** Series streams use id "tt...:season:episode"; movies use the bare id. */
const streamId = (t) => (t.season ? `${t.id}:${t.season}:${t.episode}` : t.id);

const classify = (s) => {
  if (!s || typeof s !== 'object') return 'malformed';
  if (s.url) return /\.m3u8(\?|$)/i.test(s.url) ? 'hls' : 'http';
  if (s.infoHash) return 'torrent';
  if (s.ytId) return 'youtube';
  if (s.externalUrl) return 'external';
  return 'other';
};

const langsIn = (text) => {
  const low = String(text ?? '').toLowerCase();
  return LANG_WORDS.filter((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(low));
};

const heightsIn = (text) => {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(/\b(2160|1440|1080|720|480|360)p\b/gi)) found.add(Number(m[1]));
  return [...found].sort((a, b) => b - a);
};

const tally = {};
const bump = (k) => { tally[k] = (tally[k] ?? 0) + 1; };
const perAddon = {};

for (const addon of ADDONS) {
  perAddon[addon.id] = { manifest: null, titles: {} };
  console.log(`\n${'='.repeat(74)}\n${addon.id}  ${addon.base}`);
  console.log(`  ${addon.note}`);

  // ── manifest ──────────────────────────────────────────────────────────────
  try {
    const { status, body } = await get(`${addon.base}/manifest.json`);
    if (status !== 200) {
      console.log(`  manifest: HTTP ${status}`);
      perAddon[addon.id].manifest = { status };
      continue;
    }
    let m;
    try { m = JSON.parse(body); } catch { console.log(`  manifest: not JSON (${body.length}B)`); perAddon[addon.id].manifest = { status, parseError: true }; continue; }
    const resources = Array.isArray(m.resources) ? m.resources : [];
    const streamRes = resources.filter((r) => (typeof r === 'string' ? r : r?.name) === 'stream');
    console.log(`  manifest: ${m.id ?? '?'} v${m.version ?? '?'}  types=${(m.types ?? []).join(',')}  stream=${streamRes.length > 0}`);
    console.log(`  manifest languages: ${(m.catalogs ?? []).map((c) => c?.extra?.[0]?.options ?? '').filter(Boolean).slice(0, 3).join(' | ') || '(none declared)'}`);
    perAddon[addon.id].manifest = { status, id: m.id, version: m.version, types: m.types, hasStream: streamRes.length > 0 };
    if (streamRes.length === 0) { console.log('  -> declares no stream resource; nothing to ask'); continue; }
  } catch (e) {
    console.log(`  manifest: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
    perAddon[addon.id].manifest = { error: String(e.message ?? e) };
    continue;
  }

  // ── streams, per title ────────────────────────────────────────────────────
  for (const t of TITLES) {
    const url = `${addon.base}/stream/${t.type}/${streamId(t)}.json`;
    let line = `  ${t.label.padEnd(11)} ${t.cat.padEnd(8)}`;
    try {
      const { status, body } = await get(url);
      if (status !== 200) { console.log(`${line} HTTP ${status}`); perAddon[addon.id].titles[t.label] = { status }; continue; }
      let j;
      try { j = JSON.parse(body); } catch { console.log(`${line} not JSON (${body.length}B)`); perAddon[addon.id].titles[t.label] = { notJson: true }; continue; }
      const streams = Array.isArray(j?.streams) ? j.streams : [];
      const kinds = {};
      for (const s of streams) kinds[classify(s)] = (kinds[classify(s)] ?? 0) + 1;
      bump(`${addon.id}:${kinds.hls || kinds.http ? 'has-direct' : 'no-direct'}`);
      for (const [k, n] of Object.entries(kinds)) bump(`${k}`);

      const direct = streams.filter((s) => ['hls', 'http'].includes(classify(s)));
      const heights = direct.flatMap((s) => heightsIn(`${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''}`));
      const langs = [...new Set(direct.flatMap((s) => langsIn(`${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''} ${s.behaviorHints?.filename ?? ''}`)))];
      const sizes = direct.map((s) => s.behaviorHints?.videoSize).filter((n) => typeof n === 'number' && n > 0);

      console.log(`${line} ${String(streams.length).padStart(3)} streams  ${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(' ') || '(none)'}`);
      if (direct.length) {
        console.log(`${' '.repeat(4)}direct: maxH=${heights[0] ?? '?'} langs=[${langs.join(',')}] sizes=${sizes.length ? sizes.map((b) => (b / 1e9).toFixed(2) + 'GB').join(',') : 'none declared'}`);
        const sample = direct[0];
        console.log(`${' '.repeat(4)}sample url: ${String(sample.url).slice(0, 96)}`);
      }
      perAddon[addon.id].titles[t.label] = {
        status, total: streams.length, kinds,
        direct: direct.length, heights: heights.slice(0, 4), langs, sizes,
      };
    } catch (e) {
      console.log(`${line} ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
      perAddon[addon.id].titles[t.label] = { error: String(e.message ?? e) };
    }
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(74)}\nSTREAM-OBJECT TALLY ACROSS ALL ADDONS AND TITLES`);
const total = Object.entries(tally).filter(([k]) => !k.includes(':')).reduce((a, [, n]) => a + n, 0);
for (const [k, n] of Object.entries(tally).filter(([k]) => !k.includes(':')).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${String(n).padStart(4)}  ${total ? ((n / total) * 100).toFixed(0) + '%' : ''}`);
}

const usable = ADDONS.filter((a) => perAddon[a.id]?.titles && Object.values(perAddon[a.id].titles).some((t) => t?.direct > 0));
console.log(`\naddons returning at least one DIRECT stream: ${usable.length}/${ADDONS.length}`);
for (const a of ADDONS) {
  const ts = Object.values(perAddon[a.id]?.titles ?? {});
  const d = ts.reduce((n, t) => n + (t?.direct ?? 0), 0);
  const all = ts.reduce((n, t) => n + (t?.total ?? 0), 0);
  const indian = ts.slice(1, 3).reduce((n, t) => n + (t?.direct ?? 0), 0);
  console.log(`  ${a.id.padEnd(14)} direct ${String(d).padStart(3)}/${String(all).padEnd(3)}  indian-titles direct: ${indian}`);
}

// A run where NOTHING could be fetched is not a finding about the addons - it is
// a finding about this runner's egress. Say so, loudly, instead of writing an
// empty table that reads like "no addon has direct streams".
const anyManifest = ADDONS.some((a) => perAddon[a.id]?.manifest?.status === 200);
if (!anyManifest) {
  console.log('\n::error::not one manifest could be fetched — this measures the runner\'s\n' +
    'egress, not the addons. Do not read the zeros above as a verdict.');
}

const fs = await import('node:fs');
fs.mkdirSync('research', { recursive: true });
fs.writeFileSync('research/stremio-addon-survey.json', JSON.stringify({
  at: new Date().toISOString(),
  anyManifestFetched: anyManifest,
  tally, perAddon,
}, null, 2));
console.log(`\nwrote research/stremio-addon-survey.json (anyManifestFetched=${anyManifest})`);
process.exit(anyManifest ? 0 : 1);
