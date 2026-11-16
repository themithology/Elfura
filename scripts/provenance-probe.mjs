#!/usr/bin/env node
/**
 * Provenance + expansion probe (run from CI; the agent sandbox has no egress).
 * =====================================================================
 * Three questions, answered with evidence instead of assumptions:
 *
 *  1. Provenance — when Sources 18/19/20 return a stream, does the playlist
 *     point at a real CDN object, or is everything funnelled through a proxy?
 *     For each sample we print `<manifest host> → <segment host(s)>` and whether
 *     the segment host equals the manifest host.
 *
 *  2. Source 14 — the adapter only asks the scrapper API for `citadel`. Sweep
 *     every Rive server (and a few fallbacks) and report status, row counts,
 *     CDN hosts and label shapes so the adapter can be widened safely.
 *
 *  3. Source 12 — the adapter only accepts `vidzen.fun/api/stream/...`. Report
 *     per-server counts, URL shapes and liveness so we know whether the other
 *     servers return something usable (different host/path/type) or nothing.
 *
 * No credentials, no full URLs: scheme + host + path shape only.
 */

import crypto from 'node:crypto';
import { loadBackendConfig } from '../dist/backend/config.js';
import { SourceRegistry } from '../dist/backend/sources/registry.js';
import { cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from '../dist/backend/sources/liveness.js';
import { fetchFromSubDub } from '../dist/backend/sources/source18.js';
import { fetchFromDesiDub } from '../dist/backend/sources/source19.js';
import { fetchFromVidora } from '../dist/backend/sources/source20.js';
import { extractVidZenToken, createSource12Adapter } from '../dist/backend/sources/source12.js';
import { createSource14Adapter } from '../dist/backend/sources/source14.js';
import { fetchFromWatchout } from '../dist/backend/sources/source21.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const hostOf = (value) => {
  try {
    return new URL(value).hostname;
  } catch {
    return '<invalid>';
  }
};
const pathShape = (value) => {
  try {
    const url = new URL(value);
    return url.pathname
      .replace(/[a-f0-9]{16,}/gi, '<hex>')
      .replace(/\d{4,}/g, '<n>')
      .split('/')
      .slice(0, 5)
      .join('/');
  } catch {
    return '<invalid>';
  }
};
const fingerprint = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);

async function get(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text().catch(() => '');
  return { status: response.status, ct: (response.headers.get('content-type') || '').split(';')[0], text };
}

/**
 * Where does a stream actually live? Reads the manifest, resolves the first
 * variant playlist, then reports the host of the first media segment.
 */
async function provenance(candidate) {
  if (candidate.type === 'mp4') {
    return `direct mp4 object on ${hostOf(candidate.url)}`;
  }
  const headers = { 'User-Agent': UA, ...(candidate.headers || {}) };
  try {
    const master = await get(candidate.url, headers);
    if (master.status >= 400) return `manifest http=${master.status}`;
    const lines = master.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variant = lines.find((line) => line && !line.startsWith('#') && /\.m3u8|\.mpd/i.test(line));
    const target = variant ? new URL(variant, candidate.url).href : candidate.url;
    const leaf = variant ? await get(target, headers) : master;
    const segment = leaf.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (!segment) return `manifest ok, no segment line (${hostOf(target)})`;
    const absolute = new URL(segment, target).href;
    const manifestHost = hostOf(candidate.url);
    const segmentHost = hostOf(absolute);
    const relayish = /(^|\.)(workers\.dev|pages\.dev|vercel\.app|netlify\.app)$|^prx[-.]|proxy|relay|mirror/i;
    const verdict = segmentHost === manifestHost
      ? relayish.test(manifestHost) ? 'relay host serving its own segments' : 'CDN serving its own segments (single origin)'
      : relayish.test(manifestHost) ? 'relay front → origin CDN segments' : 'edge → different segment host';
    return `manifest ${manifestHost} → segment ${segmentHost} (${verdict})`;
  } catch (err) {
    return `error ${err instanceof Error ? err.name : 'unknown'}`;
  }
}

const samples = [
  ['movie:872585:Oppenheimer', 'source-20'],
  ['tv:46260:Naruto:1:1', 'source-18'],
  ['tv:95479:Jujutsu Kaisen:1:1', 'source-18'],
  ['tv:46260:Naruto:1:1', 'source-19'],
  ['tv:95479:Jujutsu Kaisen:1:1', 'source-19'],
];

const lanes = {
  'source-18': fetchFromSubDub,
  'source-19': fetchFromDesiDub,
  'source-20': fetchFromVidora,
};

console.log(`# provenance + expansion probe — ${new Date().toISOString()}`);
console.log('');

console.log('## 1. Provenance of Sources 18-20');
for (const [spec, sourceId] of samples) {
  const [type, tmdbId, ...rest] = spec.split(':');
  const isSeries = type === 'tv' && rest.length >= 2;
  const title = (isSeries ? rest.slice(0, -2) : rest).join(':').trim();
  const query = {
    type,
    tmdbId,
    title,
    ...(isSeries ? { season: Number(rest[rest.length - 2]), episode: Number(rest[rest.length - 1]) } : {}),
  };
  let rows = [];
  try {
    rows = await lanes[sourceId](query);
  } catch {
    rows = [];
  }
  const checked = rows.length ? await verifyAndFilterCandidatesDetailed(rows) : { candidates: [] };
  const alive = checked.candidates.filter((candidate) => cachedCandidateEvidence(candidate)?.alive);
  console.log(`- ${sourceId} ${spec}: ${rows.length} row(s), ${alive.length} alive`);
  for (const candidate of alive.slice(0, 2)) {
    console.log(`    · ${candidate.type} ${candidate.quality} ${fingerprint(candidate.url)} — ${await provenance(candidate)}`);
  }
}
console.log('');

/* ───────────────────────── Source 14 sweep ───────────────────────── */

const SCRAPPER = 'https://scrapper.rivestream.app/api/provider';
// The scrapper API keys providers WITHOUT the site's `rive-` prefix (the
// working citadel lane proves it); the site-side names are kept for reference.
const RIVE_PROVIDERS = ['citadel', 'primevids', 'flowcast', 'quasar', 'guru', 'hindicast'];
const FALLBACK_PROVIDERS = ['mhbox', 'awsind', 'vidapi', 'stvv', 'streamflix'];

console.log('## 2. Source 14 provider sweep (scrapper API)');
for (const provider of [...RIVE_PROVIDERS, ...FALLBACK_PROVIDERS]) {
  const url = new URL(SCRAPPER);
  url.searchParams.set('provider', provider);
  url.searchParams.set('id', '1396');
  url.searchParams.set('season', '1');
  url.searchParams.set('episode', '1');
  url.searchParams.set('cb', String(Math.floor(Date.now() / 3_000_000)));
  const started = Date.now();
  try {
    const response = await get(url.href, { Referer: 'https://www.rivestream.app/', Origin: 'https://www.rivestream.app' });
    let body = null;
    try {
      body = JSON.parse(response.text);
    } catch {
      /* not json */
    }
    const rows = Array.isArray(body?.data?.sources) ? body.data.sources : [];
    const rootKeys = body && typeof body === 'object' ? Object.keys(body).slice(0, 6).join('|') : typeof body;
    const hosts = new Map();
    const formats = new Map();
    const labels = [];
    for (const row of rows.slice(0, 40)) {
      if (!row || typeof row !== 'object') continue;
      hosts.set(hostOf(row.url), (hosts.get(hostOf(row.url)) ?? 0) + 1);
      formats.set(String(row.format), (formats.get(String(row.format)) ?? 0) + 1);
      if (labels.length < 4) labels.push(`${String(row.quality).slice(0, 28)}|${String(row.source)}`);
    }
    console.log(
      `- ${provider}: http=${response.status} ${Date.now() - started}ms rows=${rows.length} root=${rootKeys} ` +
        `formats=${[...formats.entries()].map(([k, v]) => `${k}:${v}`).join(',') || 'none'} ` +
        `hosts=${[...hosts.entries()].map(([k, v]) => `${k}:${v}`).join(',') || 'none'}`,
    );
    if (labels.length) console.log(`    labels: ${labels.join(' ; ')}`);
    const first = rows.find((row) => typeof row?.url === 'string' && /^https:/.test(row.url));
    if (first) {
      console.log(`    first url: ${hostOf(first.url)}${pathShape(first.url)}`);
      const probe = await provenance({ url: first.url, type: 'hls', headers: { Referer: 'https://www.rivestream.app/' } });
      console.log(`    provenance: ${probe}`);
    }
  } catch (err) {
    console.log(`- ${provider}: error ${err instanceof Error ? err.name : 'unknown'}`);
  }
}
console.log('## 2b. Source 14 citadel language lanes (every row)');
/* Citadel publishes one playlist per language rendition. Print the label with
   the last two path segments so the report shows whether two languages share a
   directory (index_<lang>.m3u8) or live in per-language folders. */
const laneShape = (value) => {
  try {
    const url = new URL(value);
    const parts = url.pathname.replace(/[a-f0-9]{16,}/gi, '<hex>').split('/').filter(Boolean);
    return `${url.hostname}/${parts.slice(-2).join('/')}`;
  } catch {
    return '<invalid>';
  }
};
for (const [tmdbId, type] of [
  ['579974', 'movie'],
  ['872906', 'movie'],
  ['693134', 'movie'],
  ['1396', 'tv'],
]) {
  const url = new URL(SCRAPPER);
  url.searchParams.set('provider', 'citadel');
  url.searchParams.set('id', tmdbId);
  // The scrapper treats the request as TV whenever season/episode are present.
  if (type === 'tv') {
    url.searchParams.set('season', '1');
    url.searchParams.set('episode', '1');
  }
  url.searchParams.set('cb', String(Math.floor(Date.now() / 3_000_000)));
  try {
    const response = await get(url.href, { Referer: 'https://www.rivestream.app/', Origin: 'https://www.rivestream.app' });
    const body = JSON.parse(response.text);
    const rows = Array.isArray(body?.data?.sources) ? body.data.sources : [];
    console.log(`- citadel ${type}:${tmdbId}: http=${response.status} rows=${rows.length}`);
    for (const row of rows.slice(0, 20)) {
      if (!row || typeof row !== 'object') continue;
      console.log(`    · ${String(row.quality ?? '').slice(0, 30)} | ${String(row.language ?? '')} → ${laneShape(row.url)}`);
    }
  } catch (err) {
    console.log(`- citadel ${type}:${tmdbId}: error ${err instanceof Error ? err.name : 'unknown'}`);
  }
}
console.log('');

console.log('');

console.log('## 2c. Shared-URL citadel rows — one file with several audio tracks?');
/* Jawan returns the same playlist URL under Hindi, Kannada and Telugu labels.
   Either the API is sloppy (one label is real) or the master carries several
   EXT-X-MEDIA audio renditions and every label is a real track. The manifest
   answers that, so read it instead of guessing. */
const audioLine = (line) => {
  const pick = (key) => (line.match(new RegExp(`${key}="([^"]*)"`, 'i')) || [])[1] || '';
  return `lang=${pick('LANGUAGE') || '?'} name=${pick('NAME') || '?'} group=${pick('GROUP-ID') || '?'} uri=${/URI="/i.test(line) ? 'yes' : 'no'}`;
};
for (const [tmdbId, type] of [['872906', 'movie'], ['693134', 'movie'], ['1396', 'tv']]) {
  const url = new URL(SCRAPPER);
  url.searchParams.set('provider', 'citadel');
  url.searchParams.set('id', tmdbId);
  if (type === 'tv') {
    url.searchParams.set('season', '1');
    url.searchParams.set('episode', '1');
  }
  url.searchParams.set('cb', String(Math.floor(Date.now() / 3_000_000)));
  let rows = [];
  try {
    const response = await get(url.href, { Referer: 'https://www.rivestream.app/', Origin: 'https://www.rivestream.app' });
    rows = (JSON.parse(response.text)?.data?.sources ?? []).filter((row) => typeof row?.url === 'string');
  } catch {
    console.log(`- ${type}:${tmdbId}: api error`);
    continue;
  }
  const groups = new Map();
  for (const row of rows) {
    const label = String(row.quality ?? row.label ?? row.language ?? '').replace(/\s*\|\s*/g, ' ').trim();
    groups.set(row.url, [...(groups.get(row.url) ?? []), label]);
  }
  console.log(`- ${type}:${tmdbId}: ${rows.length} row(s) in ${groups.size} distinct url(s)`);
  for (const [shared, labels] of [...groups.entries()].slice(0, 4)) {
    let man;
    try {
      man = await get(shared, { Referer: 'https://www.rivestream.app/' });
    } catch (err) {
      console.log(`    · ${laneShape(shared)} [${labels.join(' + ')}]: error ${err instanceof Error ? err.name : '?'}`);
      continue;
    }
    const lines = man.text.split(/\r?\n/).map((line) => line.trim());
    const audio = lines.filter((line) => /^#EXT-X-MEDIA:TYPE=AUDIO/i.test(line));
    const variants = lines.filter((line) => /^#EXT-X-STREAM-INF/i.test(line)).length;
    console.log(
      `    · ${laneShape(shared)} [${labels.join(' + ')}]: http=${man.status} variants=${variants} audioRenditions=${audio.length}`,
    );
    for (const line of audio.slice(0, 8)) console.log(`        ${audioLine(line)}`);
  }
}
console.log('');

console.log('## 2d. Same citadel path, different language labels — same bytes or not?');
/* The API hands each row its own signature, so two rows can look identical once
   the query is stripped. Compare the actual playlists: identical bytes mean the
   labels contradict each other on one file; different bytes mean each label is
   its own rendition and both lanes must survive. */
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
for (const [tmdbId, type] of [['872906', 'movie'], ['693134', 'movie']]) {
  const url = new URL(SCRAPPER);
  url.searchParams.set('provider', 'citadel');
  url.searchParams.set('id', tmdbId);
  if (type === 'tv') {
    url.searchParams.set('season', '1');
    url.searchParams.set('episode', '1');
  }
  url.searchParams.set('cb', String(Math.floor(Date.now() / 3_000_000)));
  let rows = [];
  try {
    const response = await get(url.href, { Referer: 'https://www.rivestream.app/', Origin: 'https://www.rivestream.app' });
    rows = (JSON.parse(response.text)?.data?.sources ?? []).filter((row) => typeof row?.url === 'string');
  } catch {
    console.log(`- ${type}:${tmdbId}: api error`);
    continue;
  }
  const byPath = new Map();
  for (const row of rows) {
    let path = '';
    try {
      path = new URL(row.url).pathname;
    } catch {
      continue;
    }
    const label = String(row.quality ?? row.label ?? row.language ?? '').replace(/\s*\|\s*/g, ' ').trim();
    byPath.set(path, [...(byPath.get(path) ?? []), { url: row.url, label }]);
  }
  const shared = [...byPath.entries()].filter(([, items]) => items.length > 1);
  console.log(`- ${type}:${tmdbId}: ${shared.length} path(s) carrying more than one label`);
  const headers = { 'User-Agent': UA, Referer: 'https://www.rivestream.app/', Origin: 'https://www.rivestream.app' };
  for (const [path, items] of shared.slice(0, 3)) {
    console.log(`    · ${laneShape(`https://x${path}`)}`);
    for (const item of items.slice(0, 4)) {
      try {
        const man = await get(item.url, headers);
        const audio = man.text.split(/\r?\n/).filter((line) => /^#EXT-X-MEDIA:TYPE=AUDIO/i.test(line)).length;
        const head = man.text.split(/\r?\n/).find((line) => line.trim()) ?? '';
        console.log(
          `        ${item.label} → http=${man.status} ct=${man.ct || '?'} bytes=${man.text.length} sha=${digest(man.text)} audio=${audio} head=${head.slice(0, 40)}`,
        );
      } catch (err) {
        console.log(`        ${item.label} → error ${err instanceof Error ? err.name : '?'}`);
      }
    }
  }
}
console.log('');

/* ───────────────────────── Source 12 sweep ───────────────────────── */

const VZ = 'https://vidzen.fun';
const VZ_SERVERS = ['hyperion', 'mars', 'jupiter', 'venus', 'saturn', 'mercury', 'neptune', 'earth', 'uranus', 'pluto', 'helios'];

for (const [caseLabel, watchPath, apiParams] of [
  ['tv 1396 S1E1', '/tv/1396/1/1', { type: 'tv', id: '1396', season: '1', episode: '1' }],
  ['movie 872585', '/movie/872585', { type: 'movie', id: '872585' }],
]) {
console.log(`## 3. Source 12 per-server sweep (${caseLabel})`);
try {
  const page = await get(`${VZ}${watchPath}`, { Referer: `${VZ}/`, Accept: 'text/html' });
  const token = extractVidZenToken(page.text);
  console.log(`- page http=${page.status} bytes=${page.text.length} token=${token ? 'yes' : 'no'}`);
  if (token) {
    for (const server of VZ_SERVERS) {
      const endpoint = new URL('/api/sources', VZ);
      for (const [key, value] of Object.entries(apiParams)) endpoint.searchParams.set(key, value);
      endpoint.searchParams.set('server', server);
      endpoint.searchParams.set('token', token);
      try {
        const response = await get(endpoint.href, { Referer: `${VZ}/`, Accept: 'application/json' });
        let body = null;
        try {
          body = JSON.parse(response.text);
        } catch {
          /* not json */
        }
        const rows = Array.isArray(body?.sources) ? body.sources : [];
        const absolute = (raw) => {
          try {
            return new URL(String(raw), VZ).href;
          } catch {
            return '';
          }
        };
        const shapes = rows.slice(0, 3).map((row) => {
          const url = absolute(row?.url);
          const host = hostOf(url);
          return `${String(row?.type)}@${host === 'vidzen.fun' ? 'self' : host}${pathShape(url).slice(0, 24)}`;
        });
        console.log(`- ${server}: http=${response.status} rows=${rows.length} ${shapes.join(' | ')}`);
        if (rows.length) {
          const candidates = rows
            .filter((row) => row && typeof row.url === 'string' && row.url)
            .map((row, index) => ({
              key: row.url,
              url: absolute(row.url),
              type: /mp4/i.test(String(row.type)) ? 'mp4' : 'hls',
              quality: 'auto',
              headers: { 'User-Agent': UA, Referer: `${VZ}/` },
              rank: 12 + index,
            }));
          if (candidates.length) {
            const checked = await verifyAndFilterCandidatesDetailed(candidates);
            const alive = checked.candidates.filter((candidate) => cachedCandidateEvidence(candidate)?.alive);
            console.log(`    liveness: ${alive.length}/${candidates.length} alive` +
              ` (${candidates.filter((c) => cachedCandidateEvidence(c)?.confirmedDead).length} confirmed dead)`);
            for (const candidate of alive.slice(0, 1)) {
              console.log(`    provenance: ${await provenance(candidate)}`);
            }
          }
        }
      } catch (err) {
        console.log(`- ${server}: error ${err instanceof Error ? err.name : 'unknown'}`);
      }
    }
  }
} catch (err) {
  console.log(`- vidzen page error ${err instanceof Error ? err.name : 'unknown'}`);
}
console.log('');
}

/* ───────────────── adapters end-to-end (the code paths that ship) ───────────────── */

const adapterCases = [
  ['source-14', createSource14Adapter(() => true), { type: 'tv', tmdbId: '1396', season: 1, episode: 1 }],
  ['source-14', createSource14Adapter(() => true), { type: 'movie', tmdbId: '693134' }],
  ['source-14', createSource14Adapter(() => true), { type: 'movie', tmdbId: '913290' }],
  ['source-12', createSource12Adapter(() => true), { type: 'tv', tmdbId: '1396', season: 1, episode: 1 }],
  ['source-12', createSource12Adapter(() => true), { type: 'movie', tmdbId: '872585' }],
];

console.log('## 4. Adapter-level results (what actually ships)');
for (const [id, adapter, query] of adapterCases) {
  const diag = [];
  const started = Date.now();
  let resolved = [];
  try {
    resolved = (await adapter.resolve({ ...query, diag })).candidates;
  } catch (err) {
    console.log(`- ${id} ${query.type}:${query.tmdbId}: error ${err instanceof Error ? err.name : 'unknown'}`);
    continue;
  }
  console.log(`- ${id} ${query.type}:${query.tmdbId}: ${resolved.length} candidate(s) in ${Date.now() - started}ms`);
  if (diag[0]?.detail) console.log(`    diag: ${diag[0].detail}`);
  const languages = new Map();
  for (const candidate of resolved) {
    const key = candidate.claimedAudioLang ?? candidate.audioLang ?? 'unlabelled';
    languages.set(key, (languages.get(key) ?? 0) + 1);
  }
  console.log(`    audio: ${[...languages.entries()].map(([key, count]) => `${key}:${count}`).join(' ')}`);
  const qualities = [...new Set(resolved.map((candidate) => candidate.quality))].join('/');
  console.log(`    quality: ${qualities || 'none'} · hosts: ${[...new Set(resolved.map((c) => hostOf(c.url)))].slice(0, 4).join(',')}`);
}

/* ───────────────── every lane, one title (the honest "will it work" check) ───────────────── */

console.log('## 5. Every registered lane, Breaking Bad S1E1 (tt0903747)');
const probeCfg = loadBackendConfig({ ELFURA_SECRET: 'probe-secret', OPENSUBTITLES_ENABLED: '0' });
const probeRegistry = new SourceRegistry(probeCfg);
const meta = {
  title: 'Breaking Bad',
  rawTitle: 'Breaking Bad',
  year: '2008',
  releaseDate: '2008-01-20',
  latestDate: '2013-09-29',
  originalLanguage: 'en',
  imdbId: 'tt0903747',
};
const laneResults = [];
const laneQueue = [...probeRegistry.adapters];
const laneWorker = async () => {
  while (laneQueue.length) {
    const adapter = laneQueue.shift();
    const started = Date.now();
    let raw = [];
    let error = '';
    try {
      raw = (await adapter.resolve({
        type: 'tv',
        tmdbId: '1396',
        season: 1,
        episode: 1,
        imdbId: 'tt0903747',
        title: meta.title,
        year: meta.year,
        resolveMetaFallback: async () => meta,
        signal: AbortSignal.timeout(20_000),
      })).candidates;
    } catch (err) {
      error = err instanceof Error ? err.name : 'Error';
    }
    // Adapters that verify internally already carry evidence. The rest (1, 2,
    // 3, ...) do not, so an unverified row must not be reported as dead — run
    // the same bounded liveness pass the registry uses before judging it.
    let alive = raw.filter((candidate) => cachedCandidateEvidence(candidate)?.alive).length;
    if (raw.length && alive === 0) {
      try {
        const checked = await verifyAndFilterCandidatesDetailed(raw, AbortSignal.timeout(5_000));
        alive = checked.candidates.filter((candidate) => cachedCandidateEvidence(candidate)?.alive).length;
      } catch {
        alive = 0;
      }
    }
    const hosts = [...new Set(raw.map((candidate) => hostOf(candidate.url)))].slice(0, 3);
    laneResults.push({ id: adapter.id, raw: raw.length, alive, ms: Date.now() - started, error, hosts });
  }
};
await Promise.all([laneWorker(), laneWorker(), laneWorker(), laneWorker()]);
for (const lane of laneResults.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
  const status = lane.error ? `error ${lane.error}` : `${lane.raw} row(s), ${lane.alive} alive`;
  console.log(`- ${lane.id}: ${status} in ${lane.ms}ms${lane.hosts.length ? ` · ${lane.hosts.join(',')}` : ''}`);
}
const producing = laneResults.filter((lane) => lane.raw > 0).length;
console.log(`- summary: ${producing}/${laneResults.length} lanes produced rows for this episode from a US runner`);

/* ───────────────── source 21 (Vidout catalogue) against the live mirrors ───────────────── */

console.log('## 6. Source 21 — Vidout catalogue, live');
for (const [label, query] of [
  ['tv 1396 S1E1', { type: 'tv', tmdbId: '1396', season: 1, episode: 1 }],
  ['tv 1396 S1E4', { type: 'tv', tmdbId: '1396', season: 1, episode: 4 }],
  ['tv 66732 S4E1', { type: 'tv', tmdbId: '66732', season: 4, episode: 1 }],
  ['tv 76479 S1E1', { type: 'tv', tmdbId: '76479', season: 1, episode: 1 }],
  ['movie 10138', { type: 'movie', tmdbId: '10138' }],
  ['movie 27205', { type: 'movie', tmdbId: '27205' }],
]) {
  const started = Date.now();
  try {
    const raw = await fetchFromWatchout(query);
    if (!raw.length) {
      console.log(`- ${label}: no catalogue entry (${Date.now() - started}ms)`);
      continue;
    }
    const checked = await verifyAndFilterCandidatesDetailed(raw, AbortSignal.timeout(9000));
    const alive = checked.candidates.filter((candidate) => cachedCandidateEvidence(candidate)?.alive);
    console.log(`- ${label}: ${raw.length} row(s), ${alive.length} alive in ${Date.now() - started}ms · host ${hostOf(raw[0].url)}`);
    for (const candidate of alive) {
      console.log(`    audio: ${(candidate.availableAudioLangs ?? []).join(',') || 'unlabelled'} · multiAudio=${!!candidate.multiAudio}`);
    }
  } catch (err) {
    console.log(`- ${label}: error ${err instanceof Error ? err.name : 'unknown'}`);
  }
}

/* ───────────────── source 21: why a verified row is not "alive" ───────────────── */

console.log('## 7. Source 21 transport checks (status codes only)');
{
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
  const probe = async (url, headers) => {
    try {
      const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      const body = await res.text().catch(() => '');
      return { status: res.status, ct: (res.headers.get('content-type') || '').split(';')[0], head: body.slice(0, 40).replace(/\n/g, '\\n') };
    } catch (err) {
      const cause = err && typeof err === 'object' ? err.cause : undefined;
      const detail = cause?.code || cause?.message || (err instanceof Error ? err.message : 'Error');
      return { status: 0, ct: '', head: `${err instanceof Error ? err.name : 'Error'}:${String(detail).slice(0, 60)}` };
    }
  };
  const movieRows = await fetchFromWatchout({ type: 'movie', tmdbId: '10138' }).catch(() => []);
  for (const seed of [
    { label: 'tv host', url: (await fetchFromWatchout({ type: 'tv', tmdbId: '1396', season: 1, episode: 1 }).catch(() => []))[0]?.url || '' },
    { label: 'movie host', url: movieRows[0]?.url || '' },
  ]) {
    if (!seed.url) { console.log(`- ${seed.label}: no catalogue row`); continue; }
    const plain = await probe(seed.url, { 'User-Agent': UA });
    console.log(`- ${seed.label} plain: ${plain.status} ${plain.ct} ${plain.head}`);
    const referred = await probe(seed.url, { 'User-Agent': UA, Referer: 'https://vidout.pages.dev/', Origin: 'https://vidout.pages.dev' });
    console.log(`- ${seed.label} referred: ${referred.status} ${referred.ct} ${referred.head}`);
  }
  for (const headers of []) {
    const label = headers.Referer ? 'with vidout referer' : 'plain UA';
    const rows = await fetchFromWatchout({ type: 'tv', tmdbId: '1396', season: 1, episode: 1 });
    if (!rows.length) { console.log(`- ${label}: no catalogue row`); continue; }
    const master = rows[0].url;
    const m = await probe(master, headers);
    console.log(`- ${label}: master ${m.status} ${m.ct} ${m.head}`);
    const variantRel = (await (async () => {
      const res = await fetch(master, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
      const text = res ? await res.text().catch(() => '') : '';
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
      return lines.find((line) => line && !line.startsWith('#') && !line.includes('URI=')) || '';
    })());
    if (!variantRel) { console.log('    (no variant line parsed)'); continue; }
    const variantUrl = new URL(variantRel, master).toString();
    const v = await probe(variantUrl, headers);
    console.log(`    variant ${v.status} ${v.ct} ${v.head.slice(0, 30)}`);
    const segRel = (await (async () => {
      const res = await fetch(variantUrl, { headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
      const text = res ? await res.text().catch(() => '') : '';
      return text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
    })());
    if (segRel) {
      const segUrl = new URL(segRel, variantUrl).toString();
      const seg = await fetch(segUrl, { headers: { ...headers, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      const bytes = seg ? (await seg.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength : 0;
      console.log(`    segment ${seg ? seg.status : 0} ${seg ? (seg.headers.get('content-type') || '').split(';')[0] : ''} ${bytes}b`);
    }
  }
}
