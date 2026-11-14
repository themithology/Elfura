import fs from 'node:fs/promises';
import { fetchFromNxsha } from '../../dist/backend/sources/source5.js';
import { createSource7Adapter } from '../../dist/backend/sources/source7.js';
import { verifyAndFilterCandidatesDetailed } from '../../dist/backend/sources/liveness.js';

const type = process.env.MEDIA_TYPE === 'tv' ? 'tv' : 'movie';
const tmdbId = String(process.env.TMDB_ID || '693134');
const season = Number(process.env.SEASON || 1);
const episode = Number(process.env.EPISODE || 1);
const source = process.env.SOURCE === 'screenscape' ? 'screenscape' : 'nxsha';
const outputFile = process.env.OUTPUT_FILE;
if (!/^\d{1,12}$/.test(tmdbId)) throw new Error('TMDB_ID must be a numeric TMDB ID');
if (type === 'tv' && (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || season < 1 || episode < 1)) {
  throw new Error('TV probes require positive SEASON and EPISODE values');
}
if (!outputFile) throw new Error('OUTPUT_FILE is required');

const query = { type, tmdbId, ...(type === 'tv' ? { season, episode } : {}), diag: [] };
const controller = AbortSignal.timeout(20_000);
let candidates = [];
if (source === 'screenscape') {
  const result = await createSource7Adapter(() => true).resolve({ ...query, signal: controller });
  candidates = result.candidates;
} else {
  const raw = await fetchFromNxsha({ ...query, signal: controller });
  candidates = (await verifyAndFilterCandidatesDetailed(raw, controller)).candidates;
}
const selected = candidates.find(candidate => candidate.type === 'hls' && /^https:\/\//i.test(candidate.url));
if (!selected) throw new Error(`No manifest-reachable HLS URL found for ${source}, ${type} TMDB ${tmdbId}`);

// Keep the actual provider URL out of CI logs. The workflow transfers this file
// as a short-lived artifact so the requesting user can retrieve it privately.
await fs.writeFile(outputFile, JSON.stringify({
  source,
  tmdbId,
  type,
  ...(type === 'tv' ? { season, episode } : {}),
  typeOfStream: selected.type,
  url: selected.url,
  headers: selected.headers,
  expiresNote: 'Provider links can be short-lived or require the supplied headers.',
}, null, 2) + '\n', { mode: 0o600 });
console.log(`Resolved a manifest-reachable HLS URL for ${source}; URL saved to the workflow artifact.`);
