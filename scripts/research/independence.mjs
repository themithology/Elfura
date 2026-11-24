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
      if (row?.type !== 'hls' || typeof row.url !== 'string') return [];
      return sanitize([row.url]);
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
      if (typeof master !== 'string') return [];
      return sanitize([master]);
    },
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */

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
const boardByHost = new Map();
for (const source of board) {
  for (const host of source.hosts) {
    if (!boardByHost.has(host)) boardByHost.set(host, []);
    boardByHost.get(host).push(source.id);
  }
}

console.log('\n— probing candidates');
const candidates = [];
for (const lane of CANDIDATES) {
  if (LANE_FILTER && LANE_FILTER !== lane.id) continue;
  const record = { id: lane.id, label: lane.label, note: lane.note, titles: [] };
  const laneHosts = new Set();
  for (const title of TITLES) {
    const entry = { title: title.key, mediaUrls: 0, bytes: 0, segments: 0, hosts: [], error: null };
    let found = [];
    try {
      found = await lane.discover(title);
    } catch (error) {
      entry.error = error?.name ?? 'discover-failed';
    }
    entry.mediaUrls = found.length;
    if (found.length > 0) {
      // Probe up to two URLs per title; a lane that only has one is still a lane.
      for (const mediaUrl of found.slice(0, 2)) {
        const walk = await walkPlaylist(mediaUrl, ATLANTIC_HEADERS);
        entry.bytes += walk.bytes;
        entry.segments += walk.segments;
        entry.error = entry.error ?? walk.error;
        for (const host of walk.hosts) laneHosts.add(host);
      }
    }
    record.titles.push(entry);
  }

  record.hosts = [...laneHosts];
  record.bytes = record.titles.reduce((sum, t) => sum + t.bytes, 0);
  record.playable = record.bytes > 0;
  record.shared = record.hosts
    .filter((host) => boardByHost.has(host))
    .map((host) => ({ host, withSources: boardByHost.get(host) }));
  record.independent = record.hosts.length > 0 && record.shared.length === 0;
  candidateVerdict(record);
  candidates.push(record);
  console.log(
    `  ${record.id}: ${record.playable ? `${record.bytes}B proven` : 'no bytes'}, ` +
      `${record.hosts.length} host(s), ${record.shared.length} shared -> ${record.verdict}`,
  );
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
  if (record.shared.length === 0) {
    record.verdict = 'INDEPENDENT — no media host shared with any approved source';
    return;
  }
  const names = [...new Set(record.shared.flatMap((s) => s.withSources))].join(', ');
  record.verdict = `NOT independent — shares ${record.shared.length} host(s) with ${names}`;
}

const report = {
  measuredAt: startedAt,
  titles: TITLES.map((t) => t.key),
  board,
  candidates,
};

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
      `${candidate.shared.map((s) => `\`${s.host}\` (${s.withSources.join(',')})`).join('<br>') || '—'} | ${candidate.verdict} |`,
  );
}
lines.push('');
await fs.writeFile('research/independence.md', `${lines.join('\n')}\n`, 'utf8');
console.log('wrote research/independence.md');
