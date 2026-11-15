#!/usr/bin/env node
/**
 * AniVortex feasibility probe (run from CI or any host that can reach the API).
 * ===========================================================================
 *  1. Registers a throwaway installation (or reuses ELFURA_ANIVORTEX_* if set).
 *  2. Calls the signed catalogue routes for one movie and one TV title.
 *  3. Prints a redacted report: status codes, error codes, row counts, audio
 *     labels and manifest URLs reduced to scheme+host+extension.
 *
 * Credentials are never printed. Full upstream URLs are never printed.
 *
 *   node scripts/anivortex-probe.mjs movie:"Dune: Part Two":2024 \
 *                                    tv:"Breaking Bad":2008:1:1
 */

import { readAnivortexCredentials, registerAnivortexInstallation } from '../dist/backend/anivortex-auth.js';
import { fetchFromAnivortex } from '../dist/backend/sources/source17.js';

const redactUrl = (value) => {
  try {
    const url = new URL(value);
    const ext = (url.pathname.split('.').pop() || '').toLowerCase().slice(0, 5);
    return `${url.protocol}//${url.hostname}/…${ext ? `.${ext}` : ''}`;
  } catch {
    return '<invalid>';
  }
};

const args = process.argv.slice(2);
const requests = args.length > 0 ? args : ['movie:Dune: Part Two:2024', 'tv:Breaking Bad:2008:1:1'];

let credentials = readAnivortexCredentials();
if (!credentials) {
  console.log('No ELFURA_ANIVORTEX_* credentials present — registering a throwaway installation.');
  const registration = await registerAnivortexInstallation({}).catch(() => null);
  if (!registration) {
    console.error('Registration failed: the API rejected the challenge/register handshake from this network.');
    process.exit(1);
  }
  credentials = registration.credentials;
  console.log(`Registration succeeded (installation_id length=${credentials.installationId.length}, key_id length=${credentials.keyId.length}).`);
}

for (const spec of requests) {
  // "movie:TITLE:YEAR" or "tv:TITLE:YEAR:SEASON:EPISODE"
  const parts = spec.split(':');
  const type = parts.shift() === 'tv' ? 'tv' : 'movie';
  const episode = type === 'tv' ? parts.pop() : undefined;
  const season = type === 'tv' ? parts.pop() : undefined;
  const year = parts.pop();
  const title = parts.join(':').trim();
  const query = {
    type,
    tmdbId: '1',
    title,
    year,
    ...(type === 'tv' ? { season: Number(season || 1), episode: Number(episode || 1) } : {}),
  };
  const started = Date.now();
  const candidates = await fetchFromAnivortex(query, credentials);
  console.log(`\n[${type}] ${title} (${year}) → ${candidates.length} playback row(s) in ${Date.now() - started}ms`);
  for (const candidate of candidates.slice(0, 6)) {
    console.log(`  - ${candidate.type} ${candidate.quality} ${redactUrl(candidate.url)}` +
      ` | audioLabel=${candidate.audioLabel ?? '-'} claimed=${candidate.claimedAudioLang ?? '-'}` +
      ` | subtitles=${candidate.subtitles?.length ?? 0}`);
  }
  if (candidates.length === 0) {
    console.log('  (no rows: either the title is not in the catalogue, the playback query shape differs,' +
      ' or the installation has no access to that route)');
  }
}
