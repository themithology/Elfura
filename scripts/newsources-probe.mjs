#!/usr/bin/env node
/**
 * Live probe for Sources 18-21 (run from CI or any host with egress).
 * ===================================================================
 * Each lane is exercised exactly the way the backend calls it, then the first
 * candidate gets a full playback-path diagnosis (manifest → child playlist →
 * media segment, including PNG-wrapped transport detection).
 *
 *   node scripts/newsources-probe.mjs
 *   node scripts/newsources-probe.mjs 'movie:438631:Dune: Part Two'
 *
 * Nothing sensitive is printed: no credentials, no full upstream URLs (only
 * scheme + host + a short HMAC fingerprint), no headers.
 */

import crypto from 'node:crypto';
import { diagnoseCandidatePlayback, cachedCandidateEvidence, verifyAndFilterCandidatesDetailed } from '../dist/backend/sources/liveness.js';
import { fetchFromSubDub } from '../dist/backend/sources/source18.js';
import { fetchFromDesiDub } from '../dist/backend/sources/source19.js';
import { fetchFromVidora } from '../dist/backend/sources/source20.js';
import { fetchFromKmMovies } from '../dist/backend/sources/source21.js';

const redactUrl = (value) => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/…`;
  } catch {
    return '<invalid>';
  }
};
const fingerprint = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 10);

const DEFAULT_SPECS = [
  // type:tmdbId:title[:season:episode]
  'movie:693134:Dune: Part Two',
  'movie:872585:Oppenheimer',
  'tv:1396:Breaking Bad:1:1',
  'tv:46260:Naruto:1:1',
  'tv:95479:Jujutsu Kaisen:1:1',
  'tv:93405:Squid Game:1:1',
  'movie:913290:Jawan',
];

const specs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SPECS;

const TRACED = new Set(['source-18 SubDubAnime', 'source-21 KMMovies']);
const lanes = [
  ['source-18 SubDubAnime', fetchFromSubDub],
  ['source-19 DesiDubAnime', fetchFromDesiDub],
  ['source-20 Vidora', fetchFromVidora],
  ['source-21 KMMovies', fetchFromKmMovies],
];

console.log(`# Sources 18-21 live probe — ${new Date().toISOString()}`);
console.log(`# node ${process.version}`);
console.log('');

let totalUsable = 0;
let totalChecked = 0;

for (const spec of specs) {
  const [type, tmdbId, ...rest] = spec.split(':');
  const isSeries = type === 'tv' && rest.length >= 2;
  const season = isSeries ? Number(rest[rest.length - 2]) : undefined;
  const episode = isSeries ? Number(rest[rest.length - 1]) : undefined;
  const title = (isSeries ? rest.slice(0, -2) : rest).join(':').trim();
  if (!/^\d{1,12}$/.test(tmdbId) || !['movie', 'tv'].includes(type)) {
    console.log(`## ${spec}\nskipped: malformed spec\n`);
    continue;
  }
  const query = {
    type,
    tmdbId,
    title: title || undefined,
    ...(type === 'tv' ? { season: season || 1, episode: episode || 1 } : {}),
    resolveMetaFallback: async () => ({ title: title || undefined }),
  };
  console.log(`## ${type} ${tmdbId} — ${title || '(no title)'}${type === 'tv' ? ` S${query.season}E${query.episode}` : ''}`);

  for (const [label, lane] of lanes) {
    const started = Date.now();
    let raw = [];
    let error = '';
    const trace = [];
    try {
      raw = TRACED.has(label) ? await lane(query, trace) : await lane(query);
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 120) : 'error';
    }
    const ms = Date.now() - started;
    if (error) {
      console.log(`- ${label}: ${raw.length} candidate(s), ${ms} ms, error=${error}`);
      continue;
    }
    if (raw.length === 0) {
      console.log(`- ${label}: 0 candidates (${ms} ms)${trace.length ? ` — ${trace.join(' ')}` : ''}`);
      continue;
    }
    const verified = await verifyAndFilterCandidatesDetailed(raw);
    totalChecked += raw.length;
    console.log(
      `- ${label}: ${raw.length} candidate(s) → ${verified.candidates.length} kept (${ms} ms)`,
    );
    for (const candidate of raw.slice(0, 4)) {
      const evidence = cachedCandidateEvidence(candidate);
      const details = [
        `type=${candidate.type}`,
        `q=${candidate.quality}`,
        `fp=${fingerprint(candidate.url)}`,
        `host=${redactUrl(candidate.url)}`,
        `audio=${candidate.audioLang ?? candidate.claimedAudioLang ?? '?'}`,
        `multi=${candidate.multiAudio === true}`,
        evidence?.alive ? 'alive' : evidence?.confirmedDead ? 'dead' : 'unknown',
      ];
      if (evidence?.discoveredAudioLangs?.length) details.push(`manifest-audio=${evidence.discoveredAudioLangs.join('+')}`);
      if (evidence?.qualityLadder?.length) details.push(`ladder=${evidence.qualityLadder.slice(0, 4).join('/')}`);
      console.log(`    · ${details.join(' ')}`);
    }
    const first = verified.candidates[0];
    if (first) {
      totalUsable += 1;
      const diagnosis = await diagnoseCandidatePlayback(first).catch(() => null);
      if (diagnosis) {
        const segments = diagnosis.checks.filter((check) => check.stage.startsWith('media'));
        const detail = segments
          .map((check) => `${check.status}${check.httpStatus ? `/${check.httpStatus}` : ''}${check.contentType ? `(${check.contentType})` : ''}${check.mediaEncoding ? `[${check.mediaEncoding}]` : ''}`)
          .join(', ');
        console.log(
          `    ↳ manifest=${diagnosis.manifest.status} media=${diagnosis.media.status} ` +
            `stage=${diagnosis.failureStage ?? 'none'} ${detail}`.trimEnd(),
        );
      }
    }
  }
  console.log('');
}

console.log(`Summary: ${totalUsable} lane(s) produced a usable candidate; ${totalChecked} raw candidate(s) probed.`);
