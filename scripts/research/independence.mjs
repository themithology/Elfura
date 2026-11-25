#!/usr/bin/env node
/**
 * Independence probe — is a candidate lane its own source, or a third name for a
 * pipe already on the board?
 *
 * ---------------------------------------------------------------
 * This exists because "it plays" is the wrong question. Greybox and vidora both
 * played, and both resolve through hakunaymatata CDNs and workers.dev bridges:
 * two names, one upstream. Adding the second would have looked like doubling the
 * board and would have changed nothing for the viewer.
 *
 * So a candidate is measured two ways, and the second is the one that decides:
 *
 *   1. PLAYABILITY — does a real segment come back through its manifest?
 *   2. INDEPENDENCE — do the hosts behind its media overlap the hosts behind the
 *      sources already APPROVED? Not just the URL handed out: the probe follows
 *      one hop into the playlist, because a relay front (a workers.dev bridge,
 *      a `/proxy?url=` shim) hides the true CDN exactly one level down.
 *
 * A lane that shares any media host with an approved source is reported as NOT
 * independent, with the shared host named. That is a finding, not a failure: it
 * is how you learn that a "new" source is the same pipe.
 *
 * It never registers anything. It writes research/independence.json and a table.
 *
 * Usage:
 *   node scripts/research/independence.mjs               # all candidates
 *   node scripts/research/independence.mjs --lane=atlantic-vidbox
 */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const LANE_FILTER = arg('lane');
const OUT = arg('out', 'research/independence.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** The titles every lane is asked for. Real ids, two movies and two series. */
const TITLES = [
  { key: 'fight-club', type: 'movie', tmdbId: '550' },
  { key: 'inception', type: 'movie', tmdbId: '27205' },
  { key: 'got-s1e1', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
  { key: 'naruto-s1e1', type: 'tv', tmdbId: '46260', season: 1, episode: 1 },
];

const HASH = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);

/**
 * A host that looks like it is standing in front of somebody else's media.
 *
 * "Independent of the board" is not the same as "its own CDN". `proxy.7movie.ws`
 * is independent of citadel and greybox and is still a proxy — and this board
 * refuses relay fronts, so calling it INDEPENDENT and stopping there would have
 * green-lit exactly the thing the adapters are written to reject.
 */
const RELAY_SHAPED =
  /(?:^|[.-])(?:proxy|relay|transcode|bridge|worker|workers|gateway|mirror|edge)\d*(?:[.-]|$)|workers\.dev$/i;

const relayShaped = (host) => RELAY_SHAPED.test(host);

/**
 * The registrable domain a host belongs to — the unit a CDN actually shares.
 *
 * `sacdn.hakunaymatata.com`, `bcdn.hakunaymatata.com` and
 * `sbcdnw.hakunaymatata.com` are three front-ends for one network. Comparing
 * exact hostnames calls them three independent sources, which is how a candidate
 * "passes" by choosing a subdomain nobody has used yet. The comparison is made
 * on what survives the CDN prefix.
 *
 * A two-label public suffix (`co.uk`, `com.br`) is handled by keeping three
 * labels when the last two are short, which is crude but is the honest direction
 * to be wrong in: it errs toward calling two hosts related.
 */
function registrableDomain(host) {
  const labels = String(host).toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  // country-code second level such as co.uk / com.au / co.jp
  const compound = tld.length === 2 && /^(?:co|com|net|org|gov|edu|ac)$/.test(sld);
  return labels.slice(compound ? -3 : -2).join('.');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Lanes under test.
 *
 * Each `discover(title)` returns the media URLs a real adapter would build a
 * candidate from, or []. The request shapes come from reference code that has
 * been read, not guessed — an invented endpoint measures the inventing.
 * ──────────────────────────────────────────────────────────────────────────── */

const ATLANTIC_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, */*',
  Origin: 'https://atlantic.bz',
  Referer: 'https://atlantic.bz/',
};

function atlanticParams(title) {
  const q = new URLSearchParams({ tmdbId: title.tmdbId, type: title.type });
  if (title.type === 'tv') {
    q.set('seasonId', String(title.season ?? 1));
    q.set('episodeId', String(title.episode ?? 1));
  }
  return q;
}

const CANDIDATES = [
  {
    id: 'atlantic-vidbox',
    label: 'Atlantic · vidbox',
    note: 'stream.hls.lol/vidbox -> sources.Vidbox.url (fmhy-atlantic-research.mjs)',
    async discover(title) {
      const url = `https://stream.hls.lol/vidbox?${atlanticParams(title)}`;
      const response = await fetch(url, {
        headers: ATLANTIC_HEADERS,
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      const text = await boundedText(response, 200_000);
      let body = null;
      try {
        body = JSON.parse(text ?? 'null');
      } catch {
        return [];
      }
      const row = body?.sources?.Vidbox;
      if (row?.type !== 'hls' || typeof row.url !== 'string') {
        // Say what arrived instead of returning a bare []. "no media" with no
        // explanation is the same silence that made greybox look dead.
        reportDiscovery(this.id, title, {
          status: response.status,
          topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 8) : [],
          sourceKeys: body?.sources && typeof body.sources === 'object' ? Object.keys(body.sources).slice(0, 8) : [],
          rowShape: row ? { type: row.type, urlIsString: typeof row.url === 'string' } : null,
        });
        return [];
      }
      return sanitize([row.url]).map((url) => ({ url, headers: ATLANTIC_HEADERS }));
    },
  },
  {
    id: 'atlantic-q62',
    label: 'Atlantic · q62',
    note: 'stream.hls.lol/q62 -> releases[0].master (fmhy-atlantic-research.mjs)',
    async discover(title) {
      const url = `https://stream.hls.lol/q62?${atlanticParams(title)}`;
      const response = await fetch(url, {
        headers: ATLANTIC_HEADERS,
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      const text = await boundedText(response, 200_000);
      let body = null;
      try {
        body = JSON.parse(text ?? 'null');
      } catch {
        return [];
      }
      const master = body?.releases?.[0]?.master;
      if (typeof master !== 'string') {
        reportDiscovery(this.id, title, {
          status: response.status,
          topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 8) : [],
          releases: Array.isArray(body?.releases) ? body.releases.length : null,
        });
        return [];
      }
      return sanitize([master]).map((url) => ({ url, headers: ATLANTIC_HEADERS }));
    },
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** What a lane actually answered when it produced no media. Shapes, not bodies. */
const DISCOVERY_NOTES = new Map();
function reportDiscovery(laneId, title, detail) {
  const key = `${laneId}:${title.key}`;
  DISCOVERY_NOTES.set(key, detail);
}

function sanitize(urls) {
  const out = [];
  for (const raw of urls) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.username || u.password) continue;
      out.push(u.href);
    } catch {
      /* not a URL */
    }
  }
  return [...new Set(out)];
}

async function boundedText(response, max) {
  if (!response?.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Walk a playlist one hop and collect every host involved.
 *
 * The host of the URL handed out is the least interesting one. What matters is
 * what the playlist points at: a master names child playlists, a child names
 * segments, and those two are where a relay's true upstream shows itself. Key
 * and init-section URLs are included because a shared key server is a shared
 * dependency just as much as a shared CDN.
 */
async function walkPlaylist(mediaUrl, headers, depth = 0, seen = new Set()) {
  const hosts = new Set();
  if (depth > 2 || seen.has(mediaUrl)) return { hosts, bytes: 0, segments: 0, error: null };
  seen.add(mediaUrl);
  let url;
  try {
    url = new URL(mediaUrl);
  } catch {
    return { hosts, bytes: 0, segments: 0, error: 'not-a-url' };
  }
  hosts.add(url.hostname);

  let response;
  try {
    response = await fetch(mediaUrl, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { hosts, bytes: 0, segments: 0, error: error?.name ?? 'fetch-failed' };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { hosts, bytes: 0, segments: 0, error: `http=${response.status}` };
  }
  const text = await boundedText(response, 4_000_000);
  if (!text) return { hosts, bytes: 0, segments: 0, error: 'unreadable-body' };

  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const childPlaylists = [];
  const segments = [];
  let keyHosts = 0;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#')) {
      // Key and map URIs are dependencies too.
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (uri) {
        try {
          const u = new URL(uri, mediaUrl);
          hosts.add(u.hostname);
          keyHosts += 1;
        } catch {
          /* ignore */
        }
      }
      continue;
    }
    let resolved;
    try {
      resolved = new URL(line, mediaUrl);
    } catch {
      continue;
    }
    hosts.add(resolved.hostname);
    if (/\.m3u8(?:[?#]|$)/i.test(resolved.pathname) || /mpegurl/i.test(resolved.pathname)) {
      childPlaylists.push(resolved.href);
    } else {
      segments.push(resolved.href);
    }
  }

  // Follow one child to reach the segments behind a master.
  if (childPlaylists.length > 0 && segments.length === 0 && depth < 2) {
    const child = await walkPlaylist(childPlaylists[0], headers, depth + 1, seen);
    for (const host of child.hosts) hosts.add(host);
    return { hosts, bytes: child.bytes, segments: child.segments, error: child.error, keyHosts: keyHosts + (child.keyHosts ?? 0) };
  }

  // Fetch real bytes from the first segment. This is the playability proof.
  if (segments.length === 0) return { hosts, bytes: 0, segments: 0, error: 'no-segment-line', keyHosts };
  let bytes = 0;
  let error = null;
  try {
    const segment = await fetch(segments[0], {
      headers: { ...headers, Range: 'bytes=0-131071' },
      signal: AbortSignal.timeout(15_000),
    });
    if (segment.ok || segment.status === 206) {
      bytes = (await segment.arrayBuffer()).byteLength;
    } else {
      error = `segment http=${segment.status}`;
    }
    await segment.body?.cancel().catch(() => {});
  } catch (failure) {
    error = failure?.name ?? 'segment-failed';
  }
  return { hosts, bytes, segments: segments.length, error, keyHosts };
}

/**
 * Media families this repo has already identified, whether or not they are on
 * the board right now.
 *
 * The board alone is not enough: greybox serves its relative rows through its
 * own origin, so `hakunaymatata` does not appear in its media hosts — and a
 * candidate on that family would then look independent. This list is the memory
 * the probe needs, and every entry here is backed by a measurement recorded in
 * research/.
 */
const KNOWN_FAMILIES = [
  {
    domain: 'hakunaymatata.com',
    hosts: ['sacdn.hakunaymatata.com', 'bcdn.hakunaymatata.com', 'bcdnt.hakunaymatata.com', 'sbcdnw.hakunaymatata.com'],
    behind: ['greybox (absolute rows)', 'vidora', 'vidlink', 'AniVortex'],
    evidence: 'research/measurements.md, research/anivortex-audit.md, research/independence.md',
  },
  {
    domain: 'hscow.com',
    hosts: ['img1.hscow.com', 'img.hscow.com'],
    behind: ['citadel (source-1, on the board)'],
    evidence: 'research/measurements.md',
  },
  {
    domain: 'fcxmb.com',
    hosts: ['img1.fcxmb.com', 'img.fcxmb.com'],
    behind: ['citadel (source-1, on the board)'],
    evidence: 'research/measurements.md',
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * The board: what the approved sources actually resolve to, today.
 * ──────────────────────────────────────────────────────────────────────────── */

async function boardHosts() {
  const board = [];
  let approved;
  try {
    ({ APPROVED_SOURCES: approved } = await import('../../dist/backend/sources/index.js'));
  } catch (error) {
    console.error('Build the backend first: npm run build:backend');
    throw error;
  }
  for (const source of approved) {
    const adapter = source.create();
    const hosts = new Set();
    const rows = [];
    for (const title of TITLES) {
      try {
        const result = await adapter.resolve({
          type: title.type,
          tmdbId: title.tmdbId,
          season: title.season,
          episode: title.episode,
          signal: AbortSignal.timeout(45_000),
        });
        const candidates = (result?.candidates ?? []).slice(0, 3);
        rows.push({ title: title.key, candidates: candidates.length });
        for (const candidate of candidates) {
          const walk = await walkPlaylist(candidate.url, candidate.headers ?? { 'User-Agent': UA });
          for (const host of walk.hosts) hosts.add(host);
        }
      } catch (error) {
        rows.push({ title: title.key, candidates: 0, error: error?.name ?? 'error' });
      }
    }
    board.push({ id: source.id, hosts: [...hosts], rows });
  }
  return board;
}

/* ──────────────────────────────────────────────────────────────────────────── */

const startedAt = new Date().toISOString();
console.log(`independence probe ${startedAt}\n`);

console.log('— reading the board');
const board = await boardHosts();
for (const source of board) {
  console.log(`  ${source.id}: ${source.hosts.length} media host(s) :: ${source.hosts.join(', ') || 'none'}`);
}
// Indexed by REGISTRABLE DOMAIN, because that is the unit a CDN shares.
const boardByDomain = new Map();
// Known families first: they count as "already spoken for" even when nothing on
// the board currently resolves to them.
for (const family of KNOWN_FAMILIES) {
  const entry = { sources: family.behind, hosts: family.hosts, knownFamily: true, evidence: family.evidence };
  boardByDomain.set(family.domain, entry);
}
for (const source of board) {
  for (const host of source.hosts) {
    const domain = registrableDomain(host);
    if (!boardByDomain.has(domain)) boardByDomain.set(domain, { sources: [], hosts: [] });
    const entry = boardByDomain.get(domain);
    if (!entry.sources.includes(source.id)) entry.sources.push(source.id);
    if (!entry.hosts.includes(host)) entry.hosts.push(host);
  }
}

console.log('\n— probing candidates');
const candidates = [];
const asked = [];
for (const lane of CANDIDATES) {
  if (LANE_FILTER && LANE_FILTER !== lane.id) continue;
  asked.push(lane.id);
  const record = { id: lane.id, label: lane.label, note: lane.note, titles: [] };
  try {
  const laneHosts = new Set();
  for (const title of TITLES) {
    const entry = { title: title.key, mediaUrls: 0, bytes: 0, segments: 0, hosts: [], error: null };
    let found = [];
    try {
      found = await lane.discover(title);
    } catch (error) {
      entry.error = error?.name ?? 'discover-failed';
    }
    // A lane may return bare URL strings or {url, headers} pairs. The headers
    // matter: a CDN that requires a Referer refuses a probe that forgets it, and
    // that refusal looks exactly like a dead stream.
    found = found
      .map((item) => (typeof item === 'string' ? { url: item, headers: null } : item))
      .filter((item) => typeof item?.url === 'string');
    entry.mediaUrls = found.length;
    if (found.length > 0) {
      const titleHosts = new Set();
      for (const media of found.slice(0, 3)) {
        const mediaUrl = media.url;
        const walk = await walkPlaylist(mediaUrl, media.headers ?? ATLANTIC_HEADERS);
        entry.bytes += walk.bytes;
        entry.segments += walk.segments;
        entry.error = entry.error ?? walk.error;
        for (const host of walk.hosts) {
          laneHosts.add(host);
          titleHosts.add(host);
        }
      }
      // This field existed and was never assigned, so every title reported an
      // empty host list while the lane total reported one — a contradiction
      // that hid where the media actually lived.
      entry.hosts = [...titleHosts];
    }
    record.titles.push(entry);
  }

  record.hosts = [...laneHosts];
  record.bytes = record.titles.reduce((sum, t) => sum + t.bytes, 0);
  record.playable = record.bytes > 0;
  // A DOMAIN match is the real finding. A hostname-only match is reported too,
  // so an exact collision is never hidden by the coarser check.
  record.shared = record.hosts
    .filter((host) => boardByDomain.has(registrableDomain(host)))
    .map((host) => {
      const entry = boardByDomain.get(registrableDomain(host));
      return {
        host,
        domain: registrableDomain(host),
        exactHostMatch: entry.hosts.includes(host),
        knownFamily: entry.knownFamily === true,
        withSources: entry.sources,
        boardHosts: entry.hosts,
      };
    });
  record.independent = record.hosts.length > 0 && record.shared.length === 0;
  candidateVerdict(record);
  candidates.push(record);
  console.log(
    `  ${record.id}: ${record.playable ? `${record.bytes}B proven` : 'no bytes'}, ` +
      `${record.hosts.length} host(s), ${record.shared.length} shared -> ${record.verdict}`,
  );
  } catch (error) {
    // One candidate crashing must not lose every other candidate's result, and
    // it must not look like "no media". It is a defect in the probe.
    record.verdict = `probe error: ${error?.message ?? error}`;
    record.probeError = String(error?.stack ?? error).slice(0, 800);
    candidates.push(record);
    console.log(`  ${record.id}: PROBE ERROR -> ${record.verdict}`);
  }
}

function candidateVerdict(record) {
  if (!record.playable && record.hosts.length === 0) {
    record.verdict = 'no media at all — not a source yet';
    return;
  }
  if (!record.playable) {
    record.verdict = `media found but no bytes (${record.titles.map((t) => t.error).filter(Boolean).slice(0, 2).join(', ')})`;
    return;
  }
  const parts = [];
  if (record.shared.length > 0) {
    const names = [...new Set(record.shared.flatMap((s) => s.withSources))].join(', ');
    const domains = [...new Set(record.shared.map((s) => s.domain))].join(', ');
    const exact = record.shared.some((s) => s.exactHostMatch);
    const known = record.shared.some((s) => s.knownFamily);
    parts.push(
      `NOT independent — its media sits on ${domains}, the same CDN ${known ? 'family' : 'domain'} as ${names}` +
        (exact ? ' (exact host match)' : ' (different subdomain, same network)'),
    );
  } else {
    parts.push('independent of the board');
  }
  // Independence answers "is it a third name for the same pipe". It does not
  // answer "is this its own CDN", and a relay front passes the first test while
  // failing the second.
  const relays = record.hosts.filter(relayShaped);
  parts.push(
    relays.length === 0
      ? 'own-CDN shaped'
      : `RELAY-SHAPED host(s): ${relays.join(', ')} — the board refuses relay fronts`,
  );
  record.relayShaped = relays;
  record.verdict = parts.join('; ');
}

const report = {
  measuredAt: startedAt,
  titles: TITLES.map((t) => t.key),
  // A candidate silently missing from `candidates` is how the first vidlink run
  // appeared to have "no result" when it had simply never been recorded.
  asked,
  answered: candidates.map((c) => c.id),
  board,
  candidates,
  // Why a lane produced nothing, per title. Shapes and status codes only; never
  // a response body, which may carry a signed URL.
  discoveryNotes: Object.fromEntries(DISCOVERY_NOTES),
};

// Refuse to publish a report that measured nothing. A sandbox with no egress
// produces exactly that, and writing it would overwrite the last good verdict
// with a file that says every source has no media hosts.
const measuredSomething =
  board.some((source) => source.hosts.length > 0) ||
  candidates.some((candidate) => candidate.hosts.length > 0);
if (!measuredSomething) {
  console.error(
    '\nrefusing to write a report: nothing was reachable. This machine has no egress, ' +
      'or every lane is down. The last committed verdict is left untouched.',
  );
  process.exit(2);
}

await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nwrote ${OUT}`);

/* A markdown table for the committed evidence trail. */
const lines = [
  '# Is it a new source, or the same pipe?',
  '',
  `Measured ${startedAt}. Raw rows in [independence.json](independence.json).`,
  '',
  'A candidate is independent when **none of the hosts behind its media** — the URL it',
  'hands out, the child playlists, the segments, the key URIs — appear in the media',
  'hosts behind the approved sources. A shared host is a shared dependency, however',
  'different the URL looks.',
  '',
  '## The board, as measured',
  '',
  '| source | media hosts |',
  '| --- | --- |',
];
for (const source of board) {
  lines.push(`| ${source.id} | ${source.hosts.map((h) => `\`${h}\``).join(', ') || '_none_'} |`);
}
lines.push('', '## Candidates', '', '| candidate | playable | hosts | shared with board | verdict |', '| --- | --- | --- | --- | --- |');
for (const candidate of candidates) {
  lines.push(
    `| ${candidate.id} | ${candidate.playable ? `yes, ${candidate.bytes}B` : 'no'} | ${candidate.hosts.length} | ` +
      `${candidate.shared.map((s) => `\`${s.host}\` → \`${s.domain}\` (${s.withSources.join(',')})`).join('<br>') || '—'} | ${candidate.verdict} |`,
  );
}
const missing = asked.filter((id) => !candidates.some((c) => c.id === id));
if (missing.length > 0) {
  lines.push('', `**WARNING: ${missing.join(', ')} was asked for and produced no record at all.**`);
}
if (DISCOVERY_NOTES.size > 0) {
  lines.push('', '## Why a lane produced nothing', '', '| lane / title | what arrived |', '| --- | --- |');
  for (const [key, detail] of DISCOVERY_NOTES) {
    const shape =
      detail.rowShape
        ? `row type=${detail.rowShape.type}, url is a string: ${detail.rowShape.urlIsString}`
        : `status ${detail.status}; top-level keys [${(detail.topLevelKeys ?? []).join(', ')}]` +
          (detail.sourceKeys ? `; sources keys [${detail.sourceKeys.join(', ')}]` : '') +
          (detail.releases !== null && detail.releases !== undefined ? `; releases ${detail.releases}` : '');
    lines.push(`| ${key} | ${shape} |`);
  }
}
lines.push('');
await fs.writeFile('research/independence.md', `${lines.join('\n')}\n`, 'utf8');
console.log('wrote research/independence.md');
