import fs from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import { handleStreamRelay } from '../../dist/backend/relay.js';
import { sealStreamTicket } from '../../dist/backend/security.js';
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

// Re-run the real production relay handler against this live candidate. This
// catches the exact failure mode of opening the origin URL without its headers.
const relaySecret = crypto.randomBytes(32);
const relayServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  void handleStreamRelay(req, res, {
    secret: relaySecret,
    allowOrigin: '*',
    ticketParam: requestUrl.searchParams.get('t') || '',
    streamPath: '/api/v1/stream',
    relayMode: 'full',
    requireHttpsOffload: true,
  }).catch(() => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
});
await new Promise((resolve, reject) => {
  relayServer.once('error', reject);
  relayServer.listen(0, '127.0.0.1', resolve);
});
let relayStatus = 0;
try {
  const ticket = sealStreamTicket(relaySecret, { u: selected.url, h: selected.headers, k: 'm' });
  const address = relayServer.address();
  if (!address || typeof address === 'string') throw new Error('Local relay listener failed');
  const relayed = await fetch(`http://127.0.0.1:${address.port}/api/v1/stream?t=${encodeURIComponent(ticket)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/137.0 Safari/537.36' },
    signal: AbortSignal.timeout(15_000),
  });
  relayStatus = relayed.status;
  const body = await relayed.text();
  if (!relayed.ok || !/^\s*#EXTM3U/.test(body)) {
    throw new Error(`Elfura relay failed live HLS verification (HTTP ${relayStatus})`);
  }
} finally {
  relayServer.closeAllConnections?.();
  await new Promise(resolve => relayServer.close(resolve));
}

// Keep the actual provider URL out of CI logs. The workflow transfers this file
// as a short-lived artifact so the requesting user can retrieve it privately.
await fs.writeFile(outputFile, JSON.stringify({
  source,
  tmdbId,
  type,
  ...(type === 'tv' ? { season, episode } : {}),
  typeOfStream: selected.type,
  relayHttpStatus: relayStatus,
  url: selected.url,
  headers: selected.headers,
  expiresNote: 'Provider links can be short-lived or require the supplied headers.',
}, null, 2) + '\n', { mode: 0o600 });
console.log(`Resolved a manifest-reachable HLS URL for ${source}; actual Elfura relay returned HTTP ${relayStatus} and HLS.`);
