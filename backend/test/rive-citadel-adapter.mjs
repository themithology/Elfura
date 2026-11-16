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
  // A different rendition file is a different lane, even on another mirror.
  { source: 'Citadel', format: 'hls', quality: '720p | Japanese', url: makeUrl('/hls_mps/abc123/720/index_288.m3u8', 'img2.fcxmb.com') },
  // The very same file wearing two language labels: drop both rather than guess.
  { source: 'Citadel', format: 'hls', quality: '720p | Bengali', url: makeUrl('/myhls_mps/2024/Dune2/Mirror_720/index_266.m3u8') },
  { source: 'Citadel', format: 'hls', quality: '720p | Kannada', url: makeUrl('/myhls_mps/2024/Dune2/Mirror_720/index_266.m3u8') },
  { source: 'Citadel', format: 'mp4', quality: '720p | Hindi', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_720/video.mp4') },
  { source: 'Other', format: 'hls', quality: '720p | Hindi', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_720/index_266.m3u8') },
  { source: 'Citadel', format: 'hls', quality: 'Hindi subtitles', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_subs/index_266.m3u8') },
  { source: 'Citadel', format: 'hls', quality: '720p | Hindi', url: makeUrl('/myhls_mps/2024/Dune2/Hindi_720/index_266.m3u8', 'evil.example') },
];
const apiBody = { data: { sources: rows, captions: [
  { language: 'Hindi', type: 'vtt', file: 'https://captions.example/hindi.vtt' },
] } };
const animeApiBody = { data: { sources: [
  { source: 'Citadel', format: 'hls', quality: '720p | Hindi', url: makeUrl('/myhls_mps/2023_10yue/DemonSlayer/index_287.m3u8', 'img1.hscow.com') },
  { source: 'Citadel', format: 'hls', quality: '720p | Japanese', url: makeUrl('/hls_mps/012ba344fd31134a913b4ace2a5f4a64/720/index_287.m3u8', 'img1.hscow.com') },
  { source: 'Citadel', format: 'hls', quality: '480p | Hindi', url: makeUrl('/hls_mps/653c6bb3deb03e1cbb02f896/480/index_287.m3u8', 'img1.hscow.com') },
  { source: 'Citadel', format: 'hls', quality: '480p | Japanese', url: makeUrl('/hls_mps/b5aaa8a49ea8165e423a05c372f492e8/480/index_287.m3u8', 'img1.hscow.com') },
], captions: [{ language: 'English', type: 'vtt', file: 'https://captions.example/english.vtt' }] } };
const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';

// Provider-specific fixtures: the source API answers with a different row shape
// per backend, so the mock must not hand the citadel body to every provider.
const primevidsBody = {
  data: {
    sources: [
      { source: 'PrimeVids', format: 'hls', quality: 'tcloud', url: 'https://cdn.slowcloud.live/tv/Abc123.Xyz789/master.m3u8' },
      // A public CORS relay must never be promoted as a lane.
      { source: 'FlowCast', format: 'mp4', quality: '720p', url: 'https://cors.corsflix.net/proxy?file=x.mp4' },
      // Worker-relay fronts are somebody else's bandwidth.
      { source: 'PrimeVids', format: 'hls', quality: '720p', url: 'https://lucky-sun.workers.dev/x/master.m3u8' },
      { source: 'PrimeVids', format: 'hls', quality: '480p', url: 'http://cdn.slowcloud.live/tv/insecure/master.m3u8' },
    ],
  },
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  requests.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
  if (url.hostname === 'scrapper.rivestream.app') {
    const provider = url.searchParams.get('provider');
    if (provider === 'primevids') return Response.json(primevidsBody);
    if (provider !== 'citadel') return Response.json({ data: { sources: [] } });
    return Response.json(url.searchParams.get('id') === '635302' ? animeApiBody : apiBody);
  }
  if (/\/(?:my)?hls_mps\//.test(url.pathname)) {
    return new Response(hls, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  throw new Error(`Unexpected Citadel request: ${url.href}`);
};

try {
  const parsed = citadelCandidates(apiBody);
  assert.equal(
    parsed.length,
    4,
    'every language rendition is its own lane (hi, ta, en, ja); one file with two labels is dropped',
  );
  assert.deepEqual(new Set(parsed.map(candidate => candidate.audioLang)), new Set(['hi', 'ta', 'en', 'ja']));
  assert(
    parsed.every(candidate => candidate.audioLabel && !candidate.audioLabel.includes('unverified')),
    'the label names the real language, with no "unverified" wording',
  );
  assert(parsed.every(candidate => !['bn', 'kn'].includes(candidate.audioLang ?? '')), 'conflicting mirror labels are dropped');
  assert(parsed.every(candidate => !JSON.stringify(candidate).includes('hindi.vtt')));

  const movie = await fetchFromCitadel({ type: 'movie', tmdbId: '693134' });
  assert.equal(movie.length, 5, 'four citadel language rows plus one PrimeVids CDN row');
  const citadelRequest = requests.find(request => request.url.searchParams.get('provider') === 'citadel');
  assert(citadelRequest, 'the citadel provider is always asked');
  assert.equal(citadelRequest.url.searchParams.get('id'), '693134');
  assert.equal(citadelRequest.redirect, 'error');
  assert.deepEqual(
    new Set(requests.map(request => request.url.searchParams.get('provider'))),
    new Set(['citadel', 'primevids', 'flowcast', 'quasar', 'guru', 'hindicast']),
    'every Rive backend is asked, not just citadel',
  );
  requests.length = 0;
  const tv = await fetchFromCitadel({ type: 'tv', tmdbId: '1396', season: 2, episode: 3 });
  assert.equal(tv.length, 5);
  const tvCitadel = requests.find(request => request.url.searchParams.get('provider') === 'citadel');
  assert.equal(tvCitadel.url.searchParams.get('season'), '2');
  assert.equal(tvCitadel.url.searchParams.get('episode'), '3');

  // Anime fixture: Citadel returns separate provider-labeled Hindi/Japanese
  // HLS rows for a TMDB anime id. The mock manifests below contain no audio
  // renditions, so this proves discovery/label separation only—not audio or playback.
  requests.length = 0;
  const anime = await fetchFromCitadel({ type: 'tv', tmdbId: '635302', season: 1, episode: 1 });
  assert.equal(anime.length, 5, 'four labelled citadel anime rows plus the PrimeVids CDN row');
  assert.deepEqual(
    new Set(anime.map(candidate => candidate.audioLang).filter(Boolean)),
    new Set(['hi', 'ja']),
    'labelled rows stay separated by language; unlabelled PrimeVids rows make no claim',
  );
  const animeCitadel = requests.find(request => request.url.searchParams.get('provider') === 'citadel');
  assert(animeCitadel.url.searchParams.get('id') === '635302');
  assert(animeCitadel.url.searchParams.get('season') === '1');
  assert(animeCitadel.url.searchParams.get('episode') === '1');
  const animeAdapter = createSource14Adapter(() => true);
  const animeResolved = await animeAdapter.resolve({ type: 'tv', tmdbId: '635302', season: 1, episode: 1, diag: [] });
  assert.equal(animeResolved.candidates.length, 4, 'retain reachable anime candidates without promoting source labels to verified audio');
  assert(animeResolved.candidates.every(candidate => candidate.audioLang && candidate.audioLabel));
  assert(animeResolved.candidates.every(candidate => !candidate.audioLabel.includes('unverified')));

  requests.length = 0;
  const adapter = createSource14Adapter(() => true);
  const resolved = await adapter.resolve({ type: 'movie', tmdbId: '693134', diag: [] });
  assert.equal(resolved.candidates.length, 4, 'every living language lane survives the adapter');
  assert(resolved.candidates.every(candidate => candidate.diagnosticLane === 'C'));

  // PrimeVids rows carry no language, publish unsigned CDN URLs, and are merged
  // with citadel rows for the same title without inventing an audio claim.
  requests.length = 0;
  const merged = await fetchFromCitadel({ type: 'movie', tmdbId: '693134' });
  const slowcloud = merged.filter(candidate => candidate.url.includes('slowcloud.live'));
  assert.equal(slowcloud.length, 1, 'the unsigned PrimeVids CDN row survives; insecure and relay rows do not');
  assert.equal(slowcloud[0].audioLang, undefined, 'no audio language is invented for an unlabelled row');
  assert(merged.some(candidate => candidate.audioLang === 'hi'), 'labelled citadel rows are still merged in');
  assert(!merged.some(candidate => /corsflix|workers\.dev/.test(candidate.url)), 'relays and CORS proxies are rejected');

  const enabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'citadel-test-secret', ELFURA_RIVE_CITADEL_ENABLED: '1' }));
  const disabled = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'citadel-test-secret', ELFURA_RIVE_CITADEL_ENABLED: '0' }));
  assert(enabled.listPublicSources().some(source => source.id === 'source-14'));
  assert(!disabled.listPublicSources().some(source => source.id === 'source-14'));
  console.log('✓ Rive lanes: six backends asked, signed citadel HLS, unsigned PrimeVids CDN rows, relay/CORS rejection, language mapping, caption isolation, conflict suppression, manifest check, toggle');
} finally {
  globalThis.fetch = originalFetch;
}
