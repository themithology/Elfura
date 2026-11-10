import assert from 'node:assert/strict';
import { fetchFromCitadel, citadelCandidates, createSource14Adapter } from '../../dist/backend/sources/source14.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

const originalFetch = globalThis.fetch;
const requests = [];
const exp = Math.floor(Date.now() / 1000) + 3600;
const makeUrl = (path, host = 'img1.fcxmb.com') => {
  const url = new URL(`https://${host}${path}`);
  url.searchParams.set('Expires', String(exp));
  url.searchParams.set('KeyName', 'Signature');
  url.searchParams.set('Signature', 'signed_fixture_signature_1234567890==');
  return url.href;
};
const rows = [
  { source: 'Citadel', format: 'hls', quality: '720p | Hindi', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_720/index_266.m3u8') },
  { source: 'Citadel', format: 'hls', quality: '720p | Tamil', url: makeUrl('/myhls_mps/2024/Dune2/Tamil_720/index_266.m3u8') },
  { source: 'Citadel', format: 'hls', quality: '720p | English', url: makeUrl('/hls_mps/abc123/720/index_287.m3u8', 'img1.hscow.com') },
  // Same path on a mirror but conflicting language claims: drop both rather than guess.
  { source: 'Citadel', format: 'hls', quality: '720p | Japanese', url: makeUrl('/hls_mps/abc123/720/index_288.m3u8', 'img2.fcxmb.com') },
  { source: 'Citadel', format: 'mp4', quality: '720p | Hindi', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_720/video.mp4') },
  { source: 'Other', format: 'hls', quality: '720p | Hindi', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_720/index_266.m3u8') },
  { source: 'Citadel', format: 'hls', quality: 'Hindi subtitles', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_subs/index_266.m3u8') },
  { source: 'Citadel', format: 'hls', quality: '720p | Hindi', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_720/index_266.m3u8', 'evil.example') },
];
const apiBody = { data: { sources: rows, captions: [
  { language: 'Hindi', type: 'vtt', file: 'https://captions.example/hindi.vtt' },
] } };
const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
  if (url.hostname === 'scrapper.rivestream.app') return Response.json(apiBody);
  if (/\/(?:my)?hls_mps\//.test(url.pathname)) {
    return new Response(hls, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  throw new Error(`Unexpected Citadel request: ${url.href}`);
};

try {
  const parsed = citadelCandidates(apiBody);
  assert.equal(parsed.length, 2, 'keep distinct Hindi/Tamil streams, drop conflicting mirrored labels and captions');
  assert.deepEqual(new Set(parsed.map(candidate => candidate.audioLang)), new Set(['hi', 'ta']));
  assert(parsed.every(candidate => candidate.audioLabel.endsWith('Citadel label')));
  assert(parsed.every(candidate => !JSON.stringify(candidate).includes('hindi.vtt')));

  const movie = await fetchFromCitadel({ type: 'movie', tmdbId: '693134' });
  assert.equal(movie.length, 2);
  assert.equal(requests[0].url.searchParams.get('provider'), 'citadel');
  assert.equal(requests[0].url.searchParams.get('id'), '693134');
  assert.equal(requests[0].redirect, 'error');
  requests.length = 0;
  const tv = await fetchFromCitadel({ type: 'tv', tmdbId: '1396', season: 2, episode: 3 });
  assert.equal(tv.length, 2);
  assert.equal(requests[0].url.searchParams.get('season'), '2');
  assert.equal(requests[0].url.searchParams.get('episode'), '3');

  requests.length = 0;
  const adapter = createSource14Adapter(() => true);
  const resolved = await adapter.resolve({ type: 'movie', tmdbId: '693134', diag: [] });
  assert.equal(resolved.candidates.length, 2, 'HLS manifest-reachable language streams should be retained');
  assert(resolved.candidates.every(candidate => candidate.diagnosticLane === 'C'));

  const enabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'citadel-test-secret', ELFURA_RIVE_CITADEL_ENABLED: '1' }));
  const disabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'citadel-test-secret', ELFURA_RIVE_CITADEL_ENABLED: '0' }));
  assert(enabled.listPublicSources().some(source => source.id === 'source-14'));
  assert(!disabled.listPublicSources().some(source => source.id === 'source-14'));
  console.log('✓ Citadel signed HLS filtering, separate-language mapping, caption isolation, conflict suppression, episode params, manifest check, and toggle');
} finally {
  globalThis.fetch = originalFetch;
}
