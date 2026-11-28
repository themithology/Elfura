import assert from 'node:assert/strict';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { APPROVED_SOURCES, approvedSourceIds } from '../../dist/backend/sources/index.js';
import { citadelCandidates } from '../../dist/backend/sources/citadel.js';
import { greyboxCandidates } from '../../dist/backend/sources/greybox.js';
import { nxCandidates } from '../../dist/backend/sources/nxsha.js';
import { vidlyCandidates, createVidlyAdapter } from '../../dist/backend/sources/vidly.js';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { openStreamTicket } from '../../dist/backend/security.js';
import { rewriteHlsManifest } from '../../dist/backend/relay.js';

assert.deepEqual(approvedSourceIds(), ['source-1', 'source-2', 'source-3', 'source-4']);
assert.deepEqual(APPROVED_SOURCES.map(source => source.website.name), ['RiveStream', 'Greybox', 'Nxsha', 'Vidly']);
assert.equal(new Set(APPROVED_SOURCES.map(source => source.id)).size, 4);

const expires = Math.floor(Date.now() / 1000) + 3600;
const signedManifest = new URL('https://img1.fcxmb.com/hls_mps/movie/index_266.m3u8');
signedManifest.searchParams.set('Expires', String(expires));
signedManifest.searchParams.set('KeyName', 'Signature');
signedManifest.searchParams.set('Signature', 'signed_fixture_signature_1234567890==');
const source1 = citadelCandidates({ data: { sources: [
  { format: 'hls', quality: '720p Hindi', url: signedManifest.href },
] } });
assert.equal(source1.length, 1);
assert.equal(source1[0].claimedAudioLang, 'hi');

const source2 = greyboxCandidates({ sources: [
  { url: '/api/media?fixture=hindi', type: 'hls', language: 'hin', quality: '1080p' },
] });
assert.equal(source2.candidates.length, 1);
assert.equal(source2.candidates[0].claimedAudioLang, 'hi');

const source3 = nxCandidates({ sources: [
  { url: 'https://catflix.nxstreamhub.workers.dev/hls/fixture/master.m3u8', type: 'hls', label: '1080p | Hindi' },
] });
assert.equal(source3.length, 1);
assert.equal(source3[0].claimedAudioLang, 'hi');

const pageUrl = 'https://vidly.pro/watch/movie/550';
const page = [
  'https://img.rousav.tech/hls/film/1080p/master.m3u8',
  'https://gzip.rousav.tech/hls/film/720p/master.m3u8',
  'https://evil.example/film/master.m3u8',
  'https://dash-hls-bridge.john1mc.workers.dev/film/master.m3u8',
  'http://img.rousav.tech/hls/film/insecure/master.m3u8',
].join('\n');
const vidlyRows = vidlyCandidates(page, pageUrl);
assert.equal(vidlyRows.length, 2, 'Vidly keeps only the two measured HTTPS media hosts');
assert.deepEqual(vidlyRows.map(row => row.restrictedOrigin), [
  'https://img.rousav.tech',
  'https://gzip.rousav.tech',
]);

let requestedPage = '';
const vidly = createVidlyAdapter({
  fetchImpl: async (input, init) => {
    requestedPage = String(input);
    assert.equal(init.redirect, 'follow');
    return new Response(page, { headers: { 'content-type': 'text/html' } });
  },
});
const fetched = await vidly.resolve({ type: 'tv', tmdbId: '1399', season: 2, episode: 3 });
assert.equal(requestedPage, 'https://vidly.pro/watch/tv/1399/2/3');
assert.equal(fetched.candidates.length, 2);

const cfg = loadBackendConfig({ ELFURA_SECRET: 'four-source-contract-secret', OPENSUBTITLES_ENABLED: '0' });
const registry = new SourceRegistry(cfg);
const sealed = registry.sealCandidate(vidly, fetched.candidates[0], 1, new Map(), '/api/v1/stream');
const token = new URL(sealed.url, 'https://elfura.test').searchParams.get('t');
const ticket = openStreamTicket(cfg.secret, token);
assert.equal(ticket?.ro, 'https://img.rousav.tech', 'Vidly origin scope must survive ticket minting');
assert.equal(ticket?.k, 'm');

const restrictedManifest = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1000000',
  '/hls/film/1080p/child.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000',
  'https://evil.example/steal.m3u8',
].join('\n');
const rewritten = rewriteHlsManifest(
  restrictedManifest,
  'https://img.rousav.tech/hls/film/1080p/master.m3u8',
  fetched.candidates[0].headers,
  cfg.secret,
  '/api/v1/stream',
  undefined,
  { forceProxy: true, restrictedOrigin: ticket.ro, restrictedExpiry: ticket.exp },
);
assert.doesNotMatch(rewritten, /evil\.example/);
const childPath = rewritten.split('\n').find(line => line.startsWith('/api/v1/stream?'));
assert(childPath, 'same-origin HLS child is rewritten to a sealed stream ticket');
const childToken = new URL(childPath, 'https://elfura.test').searchParams.get('t');
const childTicket = openStreamTicket(cfg.secret, childToken);
assert.equal(childTicket?.u, 'https://img.rousav.tech/hls/film/1080p/child.m3u8');
assert.equal(childTicket?.ro, ticket.ro, 'restricted origin scope follows every child ticket');
assert.equal(childTicket?.fp, 1, 'restricted media stays on the backend relay');

console.log('✓ four-source manifest, adapter parsing, Vidly origin-scoped tickets, and playback relay policy');
