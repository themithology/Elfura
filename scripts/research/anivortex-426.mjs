#!/usr/bin/env node
/**
 * Is anivortex's "TV is blocked" verdict a header problem, or does it work?
 *
 * ---------------------------------------------------------------
 * research/anivortex-audit.md concludes:
 *
 *   "TV playback is blocked from datacenter IPs. Episode rows resolve correctly
 *    but their media host sbcdnw.hakunaymatata.com answers HTTP 426 to every
 *    header combination tried. That is an edge/IP gate, not a header bug, so
 *    Source 17 currently contributes movies and dies quietly on TV."
 *
 * But the same report's OWN probe output contradicts the framing. On the movie
 * that worked it recorded NINE rows, of which SIX were manifest-reachable:
 *
 *   DEAD   sbcdnw.hakunaymatata.com   (426 on every header combination)
 *   ALIVE  ok6-13.vkuser.net          manifest=dash
 *   ALIVE  ok6-3.vkuser.net           manifest=dash
 *   ALIVE  vd479.okcdn.ru             manifest=dash
 *
 * So the CDN was not the only upstream. Six rows on a host family nobody
 * flagged were reachable, and TV failed on the one host that was also dead for
 * movies. "TV needs a different upstream lane" was written as if no other lane
 * existed - while the same document had measured two.
 *
 * This probe answers the narrow question: for TV titles, are there reachable
 * rows on hosts OTHER than the 426 one, and can a segment actually be pulled?
 *
 * That matters because those alive rows reported audioRenditions=0. If the only
 * reachable rows are video-only, then "fixing" anivortex would add a lane that
 * plays a picture with no audio, which is worse than an honest gap.
 *
 * Writes research/anivortex-426.json. Registers nothing.
 */
import fs from 'node:fs/promises';

const OUT = 'research/anivortex-426.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

/** The host the audit blamed, and the family it belongs to. */
const BLAMED = /(?:^|\.)hakunaymatata\.com$/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function head(url, headers = {}, timeout = 20_000) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-65535', ...headers },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow',
    });
    let bytes = 0;
    if (response.ok || response.status === 206) {
      try {
        bytes = (await response.arrayBuffer()).byteLength;
      } catch {
        /* body refused after headers */
      }
    }
    await response.body?.cancel().catch(() => {});
    return {
      status: response.status,
      bytes,
      contentType: response.headers.get('content-type')?.slice(0, 60) ?? null,
    };
  } catch (error) {
    return { status: null, error: `${error?.name}: ${error?.message}`.slice(0, 100) };
  }
}

/** Ask a DASH manifest what it actually contains. */
async function inspectDash(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { status: response.status, error: `http=${response.status}` };
    const text = await response.text();
    const adaptationSets = (text.match(/<AdaptationSet/gi) ?? []).length;
    const audioSets = (text.match(/<AdaptationSet[^>]*contentType="audio"/gi) ?? []).length;
    const videoSets = (text.match(/<AdaptationSet[^>]*contentType="video"/gi) ?? []).length;
    const langs = [...new Set([...text.matchAll(/<AdaptationSet[^>]*\blang="([^"]+)"/gi)].map((m) => m[1]))];
    return {
      status: response.status,
      bytes: text.length,
      adaptationSets,
      audioSets,
      videoSets,
      langs,
      // The question the audit asked and could not answer: is there audio at all?
      hasAudio: audioSets > 0 || langs.length > 0,
    };
  } catch (error) {
    return { status: null, error: `${error?.name}: ${error?.message}`.slice(0, 100) };
  }
}

async function main() {
  console.log('anivortex 426 probe,', new Date().toISOString());

  let anivortex;
  try {
    // The adapter is in attic: this measures what it WOULD return without
    // registering it. Built on demand, the same way the vidlink re-test does it,
    // because attic is deliberately not part of the shipped build.
    const { createSource17Adapter } = await import('../../dist/attic/source17.js').catch(async () => {
      const { execFileSync } = await import('node:child_process');
      console.log('retired adapter not built — compiling it for this run');
      execFileSync(
        'npx',
        [
          'tsc',
          'backend/attic/sources/source17.ts',
          '--outDir', 'dist/attic',
          '--module', 'NodeNext',
          '--moduleResolution', 'NodeNext',
          '--target', 'ES2022',
          '--skipLibCheck',
          '--esModuleInterop',
        ],
        { stdio: 'inherit' },
      );
      return import('../../dist/attic/source17.js');
    });
    const adapter = createSource17Adapter(() => true);
    anivortex = async (query) => (await adapter.resolve(query)).candidates;
  } catch (error) {
    console.error(`cannot load the retired adapter: ${error?.message ?? error}`);
    process.exit(2);
  }

  const titles = [
    { key: 'breaking-bad-s1e1', type: 'tv', tmdbId: '1396', season: 1, episode: 1 },
    { key: 'got-s1e1', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
    { key: 'naruto-s1e1', type: 'tv', tmdbId: '46260', season: 1, episode: 1 },
  ];

  const rows = [];
  for (const title of titles) {
    await sleep(4000);
    let candidates = [];
    try {
      candidates = (await anivortex({ ...title })) ?? [];
    } catch (error) {
      rows.push({ title: title.key, error: String(error?.message ?? error).slice(0, 120) });
      continue;
    }
    const perHost = {};
    for (const candidate of candidates) {
      let host;
      try {
        host = new URL(candidate.url).hostname.toLowerCase();
      } catch {
        continue;
      }
      perHost[host] ??= { rows: 0, blamed: BLAMED.test(host), probes: [] };
      perHost[host].rows += 1;
      if (perHost[host].probes.length >= 2) continue;
      const probe =
        /\.mpd(?:[?#]|$)/i.test(candidate.url) || candidate.type === 'dash'
          ? await inspectDash(candidate.url)
          : await head(candidate.url, candidate.headers ?? {});
      perHost[host].probes.push({ url: candidate.url.slice(0, 120), ...probe });
    }
    rows.push({ title: title.key, candidates: candidates.length, perHost });
    const hosts = Object.keys(perHost);
    console.log(
      `  ${title.key.padEnd(18)} ${candidates.length} row(s) on ${hosts.length} host(s): ` +
        hosts.map((h) => `${h}${perHost[h].blamed ? '*' : ''}`).join(', '),
    );
    for (const [host, data] of Object.entries(perHost)) {
      const p = data.probes[0] ?? {};
      console.log(
        `      ${data.blamed ? 'BLAMED ' : 'OTHER  '} ${host.padEnd(34)} ` +
          `${p.status ?? p.error ?? '-'} ${p.bytes ? `${p.bytes}B` : ''} ` +
          `${p.hasAudio === undefined ? '' : p.hasAudio ? 'HAS-AUDIO' : 'NO-AUDIO'}`,
      );
    }
  }

  const otherHosts = new Set();
  const reachableElsewhere = [];
  for (const row of rows) {
    for (const [host, data] of Object.entries(row.perHost ?? {})) {
      if (data.blamed) continue;
      otherHosts.add(host);
      if (data.probes.some((p) => (p.status === 200 || p.status === 206) && p.bytes > 0)) {
        reachableElsewhere.push({ title: row.title, host });
      }
    }
  }
  const audioAnywhere = rows.some((r) =>
    Object.values(r.perHost ?? {}).some((d) => d.probes.some((p) => p.hasAudio)),
  );

  const report = {
    measuredAt: new Date().toISOString(),
    rows,
    summary: {
      otherHosts: [...otherHosts],
      reachableOutsideBlamedHost: reachableElsewhere,
      audioFound: audioAnywhere,
      verdict:
        reachableElsewhere.length === 0
          ? 'TV really is dead: nothing reachable on any host'
          : audioAnywhere
            ? 'TV PLAYS: reachable rows exist outside the 426 host, and at least one manifest declares audio'
            : 'TV rows are reachable outside the 426 host but declare NO audio — a picture with no sound is not a fix',
    },
  };

  const touched = rows.some((r) => r.candidates > 0);
  if (!touched) {
    console.error('\nrefusing to write a report: the adapter returned no rows on any TV title.');
    process.exit(2);
  }
  await fs.writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nwrote ${OUT}`);
  console.log(`verdict: ${report.summary.verdict}`);
  console.log(`hosts other than the blamed one: ${[...otherHosts].join(', ') || 'none'}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
