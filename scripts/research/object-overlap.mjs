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
 * The shapes this board has actually seen:
 *   /dash/<19-digit id>_<...>/master.m3u8      hakunaymatata family
 *   /api/media?u=https://.../dash/<id>_.../    greybox's own proxy, upstream in the query
 *   /<something>/index.m3u8
 *
 * The digit run is the id that matters: it is assigned by whichever library
 * encoded the file, so two lanes serving the same object carry the same number
 * and two lanes serving different libraries do not.
 */
const OBJECT_ID = /\/(\d{15,22})_/;

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
    const hit = path.match(OBJECT_ID);
    if (hit) return hit[1];
  }
  // Some rows use a UUID-ish name instead of a digit run.
  const uuid = url.pathname.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i);
  return uuid ? uuid[1].toLowerCase() : null;
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

  let createGreyboxAdapter;
  let createVidlinkAdapter;
  try {
    ({ createGreyboxAdapter } = await import('../../dist/backend/sources/greybox.js'));
    ({ createVidlinkAdapter } = await import('../../dist/backend/sources/vidlink.js'));
  } catch (error) {
    console.error('Build the backend first: npm run build:backend');
    throw error;
  }

  const lanes = {
    'source-2-greybox': createGreyboxAdapter(),
    'source-3-vidlink': createVidlinkAdapter(),
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
    const a = new Set(perLane['source-2-greybox'].objects);
    const b = new Set(perLane['source-3-vidlink'].objects);
    const shared = [...a].filter((id) => b.has(id));
    rows.push({ title: title.key, perLane, sharedObjects: shared });
  }

  // Across every title, is there a single object both lanes serve?
  const allShared = [...new Set(rows.flatMap((row) => row.sharedObjects))];
  const greyboxOnly = [...new Set(rows.flatMap((r) => r.perLane['source-2-greybox'].objects))].filter(
    (id) => !allShared.includes(id),
  );
  const vidlinkOnly = [...new Set(rows.flatMap((r) => r.perLane['source-3-vidlink'].objects))].filter(
    (id) => !allShared.includes(id),
  );

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
      sharedObjects: allShared,
      greyboxOnly: greyboxOnly.length,
      vidlinkOnly: vidlinkOnly.length,
      verdict:
        allShared.length > 0
          ? `SAME LIBRARY — ${allShared.length} media object(s) served by both lanes`
          : greyboxOnly.length + vidlinkOnly.length > 0
            ? 'DIFFERENT LIBRARIES — no media object is served by both lanes'
            : 'NO OBJECT IDS — neither lane named an object; this probe measured nothing',
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
  console.log(
    `objects — shared ${allShared.length}, greybox-only ${report.summary.greyboxOnly}, vidlink-only ${report.summary.vidlinkOnly}`,
  );
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
