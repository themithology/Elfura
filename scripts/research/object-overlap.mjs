#!/usr/bin/env node
/**
 * Content overlap probe — do two sources offer the SAME media object, or merely
 * the same CDN?
 *
 * ---------------------------------------------------------------
 * The independence probe answers "different host?". For vidlink that came back
 * `hakunaymatata.com`, which is also greybox's absolute-row CDN, so vidlink was
 * refused. But a shared CDN is not a shared catalogue:
 *
 *   - A CDN carries many libraries. Two unrelated aggregators commonly sit on the
 *     same one, because there are only a handful of large ones.
 *   - The real question for a viewer is whether source 3 can play something
 *     source 1 and 2 cannot. That is decided by the media OBJECT — the library
 *     path and the encoded title id inside it — not by the hostname.
 *
 *   sacdn.hakunaymatata.com/dash/4046544153143035520_0_0_1080_h265_235/  (greybox)
 *   bcdn.hakunaymatata.com/dash/9153410288746531891_0_0_.../              (vidlink)
 *
 * Same host family, different object ids. That is two libraries on one CDN, and
 * it is exactly the case the host check cannot tell apart from a re-export.
 *
 * What this probe measures, per title:
 *   1. both adapters' candidate URLs
 *   2. the media OBJECT id in each path (the library's own id, not the TMDB id)
 *   3. whether any object id is shared between the two lanes
 *   4. the CDN domain each object lives on
 *
 * If the object ids are disjoint, the two sources serve different libraries and
 * a shared CDN is not a reason to refuse the third. If they collide, vidlink is
 * a re-export of greybox's library and must not be added.
 *
 * It writes research/object-overlap.json. It registers nothing.
 *
 * Usage:
 *   node scripts/research/object-overlap.mjs
 *   node scripts/research/object-overlap.mjs --out=research/object-overlap.json
 */
import fs from 'node:fs/promises';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const OUT = arg('out', 'research/object-overlap.json');

const TITLES = [
  { key: 'fight-club', type: 'movie', tmdbId: '550' },
  { key: 'inception', type: 'movie', tmdbId: '27205' },
  { key: 'got-s1e1', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
  { key: 'naruto-s1e1', type: 'tv', tmdbId: '46260', season: 1, episode: 1 },
];

/**
 * The library's own object id, pulled out of a media path.
 *
 * These are the shapes the two live lanes ACTUALLY hand out, read off a run
 * rather than assumed. The first version of this probe guessed a
 * `/dash/<19 digits>_.../` shape and matched nothing at all, then reported
 * "no object ids" as if that were a finding about the sources.
 *
 *   hakunaymatata (vidlink today)
 *     /bt/<32 hex>.mp4
 *     /resource/h265/<32 hex>.mp4
 *     /tran-audio/<date>/<32 hex>.mp4
 *   hscow (citadel, and greybox's river rows)
 *     /hls/<8-10 digit title id>/<height>/index_<n>.m3u8
 *     /hls_mps/<id>/<height>/index_<n>.m3u8
 *
 * Two different id spaces, which is itself the finding: these are not one
 * library reached two ways.
 */
const HEX_OBJECT = /\/(?:[a-z0-9-]+\/)?(?:[a-z0-9-]+\/)?([0-9a-f]{32})\.(?:mp4|m3u8|mpd)(?:[?#]|$)/i;
const HSC_TITLE = /\/hls(?:_mps)?\/(\d{6,12})\//i;

function objectId(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // A proxy names its upstream in a query parameter; the object id is there,
  // not in the proxy's own path. Check both, path first.
  const candidates = [url.pathname];
  for (const value of url.searchParams.values()) {
    try {
      candidates.push(new URL(value).pathname);
    } catch {
      /* not a URL parameter */
    }
  }
  for (const path of candidates) {
    const hex = path.match(HEX_OBJECT);
    if (hex) return `hex:${hex[1].toLowerCase()}`;
    const hsc = path.match(HSC_TITLE);
    if (hsc) return `hsc:${hsc[1]}`;
    const uuid = path.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
    if (uuid) return `uuid:${uuid[1].toLowerCase()}`;
  }
  return null;
}

function mediaDomain(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    const labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return host;
    const tld = labels[labels.length - 1];
    const sld = labels[labels.length - 2];
    const compound = tld.length === 2 && /^(?:co|com|net|org|gov|edu|ac)$/.test(sld);
    return labels.slice(compound ? -3 : -2).join('.');
  } catch {
    return null;
  }
}

/** Every URL a proxy row actually points at, so the upstream is not missed. */
function unwrap(rawUrl) {
  const out = [rawUrl];
  try {
    const url = new URL(rawUrl);
    for (const value of url.searchParams.values()) {
      if (/^https?:\/\//i.test(value)) out.push(value);
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function runway(adapter, title) {
  let result;
  try {
    result = await adapter.resolve({
      type: title.type,
      tmdbId: title.tmdbId,
      season: title.season,
      episode: title.episode,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    return { error: error?.message ?? String(error), urls: [], objects: [], domains: [] };
  }
  const candidates = result?.candidates ?? [];
  const urls = [];
  for (const candidate of candidates) {
    for (const one of unwrap(candidate.url)) urls.push(one);
  }
  const objects = [...new Set(urls.map(objectId).filter(Boolean))];
  const domains = [...new Set(urls.map(mediaDomain).filter(Boolean))];
  return {
    error: null,
    candidateCount: candidates.length,
    urls: [...new Set(urls)],
    objects,
    domains,
  };
}

async function main() {
  console.log('object overlap probe,', new Date().toISOString());

  let createCitadelAdapter;
  let createGreyboxAdapter;
  // nxsha is NOT approved, so it is reached through this repo's probe client
  // rather than an adapter: measuring a candidate must not require shipping it.
  let nxsha;
  try {
    ({ createCitadelAdapter } = await import('../../dist/backend/sources/citadel.js'));
    ({ createGreyboxAdapter } = await import('../../dist/backend/sources/greybox.js'));
    nxsha = await import('./nxsha-client.mjs');
  } catch (error) {
    console.error('Build the backend first: npm run build:backend');
    throw error;
  }

  // The two approved sources. The board's own internal
  // overlap matters as much as a candidate's: if source-1 and source-2 serve the
  // same object, the board is smaller than it says it is.
  const lanes = {
    'source-1-citadel': createCitadelAdapter(),
    'source-2-greybox': createGreyboxAdapter(),
    // Same interface, so it is measured by exactly the same code. nxsha fans out
    // across ~25 of its own scrapers; two are enough to establish whether their
    // media objects overlap the board, and more would just multiply requests.
    'candidate-nxsha': {
      id: 'candidate-nxsha',
      resolve: async (query) => {
        const listed = await nxsha.scrapers(query);
        if (listed.error) return { candidates: [] };
        const own = listed.names.filter((name) => !/^rive-/i.test(name)).slice(0, 3);
        const candidates = [];
        for (const lane of own) {
          const { rows } = await nxsha.laneSources(query, lane);
          for (const row of rows) candidates.push({ ...row, diagnosticLane: lane });
        }
        return { candidates };
      },
    },
  };

  const rows = [];
  for (const title of TITLES) {
    const perLane = {};
    for (const [id, adapter] of Object.entries(lanes)) {
      perLane[id] = await runway(adapter, title);
      const summary = perLane[id].error
        ? `error: ${perLane[id].error.slice(0, 60)}`
        : `${perLane[id].candidateCount} candidate(s), ${perLane[id].objects.length} object id(s), ${perLane[id].domains.join(',') || 'no domain'}`;
      console.log(`  ${title.key} ${id}: ${summary}`);
    }
    const laneIds = Object.keys(lanes);
    const pairs = {};
    for (let i = 0; i < laneIds.length; i += 1) {
      for (let j = i + 1; j < laneIds.length; j += 1) {
        const a = new Set(perLane[laneIds[i]].objects);
        const b = new Set(perLane[laneIds[j]].objects);
        const shared = [...a].filter((id) => b.has(id));
        if (shared.length > 0) pairs[`${laneIds[i]} & ${laneIds[j]}`] = shared;
      }
    }
    rows.push({ title: title.key, perLane, pairs });
  }

  // Across every title, which lane pairs serve a byte-identical object?
  const byPair = {};
  for (const row of rows) {
    for (const [pair, ids] of Object.entries(row.pairs)) {
      byPair[pair] ??= { objects: new Set(), titles: new Set() };
      for (const id of ids) byPair[pair].objects.add(id);
      byPair[pair].titles.add(row.title);
    }
  }
  const pairSummary = Object.fromEntries(
    Object.entries(byPair).map(([pair, data]) => [
      pair,
      { sharedObjects: [...data.objects], titles: [...data.titles] },
    ]),
  );

  // How opaque was each lane? Greybox hands out `?u=m1.<base64>` rows whose
  // upstream cannot be read from the URL at all - those rows hide their object,
  // which caps what this probe can conclude about them.
  const opacity = {};
  for (const laneId of Object.keys(lanes)) {
    let total = 0;
    let named = 0;
    for (const row of rows) {
      total += row.perLane[laneId].urls.length;
      named += row.perLane[laneId].objects.length;
    }
    opacity[laneId] = { urls: total, distinctObjects: named };
  }

  const domainsSeen = {};
  for (const row of rows) {
    for (const [lane, data] of Object.entries(row.perLane)) {
      for (const domain of data.domains) {
        domainsSeen[domain] ??= new Set();
        domainsSeen[domain].add(lane);
      }
    }
  }

  const report = {
    measuredAt: new Date().toISOString(),
    titles: TITLES.map((t) => t.key),
    rows,
    summary: {
      pairs: pairSummary,
      opacity,
      verdict:
        Object.keys(pairSummary).length > 0
          ? `OVERLAP — ${Object.keys(pairSummary)
              .map((pair) => `${pair} share ${pairSummary[pair].sharedObjects.length} object(s)`)
              .join('; ')}`
          : 'NO SHARED OBJECTS — no lane pair served a byte-identical media object',
      caveat: Object.values(pairSummary).length === 0
        ? 'Absence of a shared id is not proof of different libraries: a lane whose rows are opaque (?u=m1.…) hides its object, and that lane could still be serving what another lane names.'
        : null,
      domains: Object.fromEntries(
        Object.entries(domainsSeen).map(([domain, set]) => [domain, [...set].sort()]),
      ),
    },
  };

  const measured = rows.some((row) => Object.values(row.perLane).some((d) => d.urls.length > 0));
  if (!measured) {
    console.error('\nrefusing to write a report: neither lane returned a URL. No egress, or both are down.');
    process.exit(2);
  }

  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
  console.log(`verdict: ${report.summary.verdict}`);
  for (const [pair, data] of Object.entries(report.summary.pairs)) {
    console.log(`  ${pair}: ${data.sharedObjects.length} shared object(s) on ${data.titles.join(',')}`);
    for (const id of data.sharedObjects) console.log(`     ${id}`);
  }
  for (const [laneId, counts] of Object.entries(report.summary.opacity)) {
    console.log(`  ${laneId}: ${counts.urls} url(s), ${counts.distinctObjects} named object(s)`);
  }
  if (report.summary.caveat) console.log(`  caveat: ${report.summary.caveat}`);
  console.log(
    `domains — ${Object.entries(report.summary.domains)
      .map(([d, lanes]) => `${d}:${lanes.join('+')}`)
      .join(', ')}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
