// Regression coverage for row-level single-language sources. The provider's
// title-wide language inventory must not turn each standalone stream into a
// fake multi-audio row, and the row's claim must survive to the player's picker.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { handleStreamRelay } from '../../dist/backend/relay.js';
import { openStreamTicket } from '../../dist/backend/security.js';
import { greyboxCandidates } from '../../dist/backend/sources/greybox.js';
import { selectPlaybackCandidates } from '../../dist/backend/sources/selection.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { rewriteHlsManifest } from '../../dist/backend/relay.js';

const rows = greyboxCandidates({ sources: [
  { url: '/api/media?fixture=hindi', type: 'hls', language: 'hin', quality: '1080p' },
  { url: '/api/media?fixture=english', type: 'hls', language: 'eng', quality: '1080p' },
  { url: '/api/media?fixture=telugu', type: 'hls', language: 'tel', quality: '720p' },
] });
assert.deepEqual(rows.languages.sort(), ['en', 'hi', 'te']);
assert.deepEqual(rows.candidates.map(row => row.claimedAudioLang), ['hi', 'en', 'te']);
assert(rows.candidates.every(row => !row.availableAudioLangs?.length && !row.multiAudio),
  'title-wide languages must not be attached to individual single-language streams');

const adapter = { id: 'source-2', label: 'Greybox', traits: [] };
const selected = selectPlaybackCandidates(rows.candidates.map(candidate => ({ adapter, candidate })), 'hi');
assert.equal(selected[0].candidate.claimedAudioLang, 'hi', 'the requested solo-language row should rank first');
const untaggedClaim = { ...rows.candidates[0], audioLang: 'und' };
assert.equal(selectPlaybackCandidates([{ adapter, candidate: untaggedClaim }], 'hi')[0].candidate.claimedAudioLang, 'hi',
  'an untagged measured language must not erase the row-level claim');

const cfg = loadBackendConfig({ ELFURA_SECRET: 'solo-language-regression-secret', OPENSUBTITLES_ENABLED: '0' });
const registry = Object.create(SourceRegistry.prototype);
registry.cfg = cfg;
const option = registry.sealCandidate(adapter, { ...rows.candidates[0], audioLang: 'und' }, 1, new Map(), '/api/v1/stream');
assert.equal(option.claimedAudioLang, 'hi', 'the public option must preserve a claim alongside an untagged `und` measurement');
const ticketValue = new URL(option.url, 'https://elfura.test').searchParams.get('t');
const ticket = openStreamTicket(cfg.secret, ticketValue);
assert.equal(ticket?.l, 'hi', 'a standalone provider language claim must reach the manifest rewriter');
assert.equal(ticket?.lang, undefined, 'the ticket uses the relay schema key `l`');
assert.equal(ticket?.k, 'm', 'HLS choices must be marked as manifests so the relay rewrites query-shaped playlists');

// Exercise the exact switching path: the provider URL has no `.m3u8` suffix
// and returns a generic content type. The ticket kind is what lets the relay
// recognize and rewrite it before the browser switches onto the candidate.
{
  const originalFetch = globalThis.fetch;
  const manifest = ['#EXTM3U', '#EXTINF:5,', 'segment.ts', '#EXT-X-ENDLIST'].join('\n');
  const relayServer = createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    void handleStreamRelay(req, res, {
      secret: cfg.secret,
      allowOrigin: '*',
      ticketParam: requestUrl.searchParams.get('t') || '',
      streamPath: '/api/v1/stream',
      relayMode: 'full',
      requireHttpsOffload: false,
    });
  });
  globalThis.fetch = async (input, init) => String(input) === ticket.u
    ? new Response(manifest, { headers: { 'content-type': 'application/octet-stream' } })
    : originalFetch(input, init);
  try {
    await new Promise((resolve, reject) => {
      relayServer.once('error', reject);
      relayServer.listen(0, '127.0.0.1', resolve);
    });
    const address = relayServer.address();
    const response = await originalFetch(`http://127.0.0.1:${address.port}${option.url}`);
    assert.equal(response.status, 200);
    const rewrittenManifest = await response.text();
    assert.match(response.headers.get('content-type') || '', /application\/vnd\.apple\.mpegurl/i);
    assert.match(rewrittenManifest, /\/api\/v1\/stream\?t=/, 'segment URLs must be proxied before switching');
    assert.doesNotMatch(rewrittenManifest, /segment\.ts/, 'the upstream segment path must not leak to the browser');
  } finally {
    globalThis.fetch = originalFetch;
    if (relayServer.listening) {
      await new Promise((resolve) => relayServer.close(resolve));
    }
  }
}

const typedCandidate = {
  ...rows.candidates[0],
  audioTracks: [{ lang: 'en', label: 'English', url: 'https://cdn.example/audio.m4a' }],
};
const mp4Option = registry.sealCandidate(adapter, { ...typedCandidate, type: 'mp4' }, 2, new Map(), '/api/v1/stream');
const mp4Ticket = openStreamTicket(cfg.secret, new URL(mp4Option.url, 'https://elfura.test').searchParams.get('t'));
assert.equal(mp4Ticket?.k, 'a', 'MP4 source choices must be marked as media assets');
const audioTicket = openStreamTicket(cfg.secret, new URL(mp4Option.audioTracks[0].url, 'https://elfura.test').searchParams.get('t'));
assert.equal(audioTicket?.k, 'a', 'external audio tickets must preserve range/asset handling');
const animeAdapter = { id: 'source-29', label: 'Anime', traits: ['animeEpisode'] };
const animeOption = registry.sealCandidate(animeAdapter, {
  ...rows.candidates[0],
  subtitles: [{ lang: 'hi', label: 'Hindi', url: 'https://cdn.example/subtitles.vtt' }],
}, 3, new Map(), '/api/v1/stream');
const subtitleTicket = openStreamTicket(cfg.secret, new URL(animeOption.subtitles[0].url, 'https://elfura.test').searchParams.get('t'));
assert.equal(subtitleTicket?.k, 's', 'subtitle tickets must retain subtitle-specific relay handling');

const singleUntaggedMaster = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,URI="audio.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="audio"',
  'video.m3u8',
].join('\n');
const rewritten = rewriteHlsManifest(singleUntaggedMaster, 'https://cdn.example/master.m3u8', undefined,
  cfg.secret, '/api/v1/stream', ticket.l);
assert.match(rewritten, /LANGUAGE="hi"/i, 'the proxy should annotate its sole untagged rendition with the row language');
assert.match(rewritten, /NAME="Hindi"/i);

const bundled = await build({
  entryPoints: ['src/core/player.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  external: ['hls.js', 'dashjs'],
});
const { ElfuraPlayer } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`,
);
const player = Object.create(ElfuraPlayer.prototype);
const soloHindi = {
  ...rows.candidates[0], id: 'solo-hi', sourceId: 'source-2', label: 'Greybox', type: 'hls', audioLang: 'und',
  quality: '1080p', audioTracks: [], subtitles: [], availableAudioLangs: ['hi', 'en'],
};
player.sources = [soloHindi];
player.currentSource = soloHindi;
player.currentAudio = null;
player.audioTracks = [];
player.failedSourceIds = new Set();
player.failedFingerprints = new Set();
player.measuredRttByFp = new Map();
player.desiredAudioLang = 'hi';
player.input = { config: { audioTracks: [], persistAudio: false } };
player.activeProbe = null;
player.emit = () => {};
player.applyInitialAudio = () => {};
player.isCandidateFailed = () => false;
player.mergeNativeAudio([{ id: 0, lang: 'und', label: 'Audio', default: true }]);
assert.equal(player.audioTracks[0]?.lang, 'hi', 'an active solo-language claim should label its untagged native track');

const tracks = [{ id: 0, lang: 'und', name: 'Audio' }];
assert.equal(player.applyHlsProbeAudioSelection(
  { targetLang: 'hi', opt: soloHindi }, tracks, { audioTrack: -1 },
), true, 'a solo Hindi row remains selectable even if stale title-wide metadata lists other languages');
assert.equal(player.applyHlsProbeAudioSelection(
  { targetLang: 'hi', opt: soloHindi }, [{ id: 0, lang: 'en', name: 'English' }], { audioTrack: -1 },
), false, 'an explicit conflicting manifest language must still override a provider claim');
assert.equal(player.applyHlsProbeAudioSelection(
  { targetLang: 'hi', opt: { ...soloHindi, multiAudio: true } }, tracks, { audioTrack: -1 },
), false, 'a genuine multi-audio claim still requires manifest evidence');

const attempts = [];
const searchPlayer = Object.create(ElfuraPlayer.prototype);
Object.assign(searchPlayer, {
  sources: [soloHindi], currentSource: null, currentAudio: null, audioTracks: [],
  failedSourceIds: new Set(), failedFingerprints: new Set(), measuredRttByFp: new Map(),
  desiredAudioLang: null, initialAudioApplied: false, audioSearchSeq: 0, activeProbe: null,
  destroyed: false, video: { currentTime: 0, paused: true, readyState: 0 }, shell: { dataset: {} },
  input: { config: { persistAudio: false } }, emit: () => {}, canPreProbeViaFetch: () => false,
  reorderSourcesHierarchy: () => {}, recordDiscoveredAudioLangs: () => {},
});
searchPlayer.probeRawCandidateForLanguage = async (candidate, lang) => {
  attempts.push([candidate.id, lang]);
  searchPlayer.currentSource = candidate;
  return { ok: true };
};
searchPlayer.activateSourceOption = async candidate => { searchPlayer.currentSource = candidate; };
assert.equal(await searchPlayer.setAudio('hi'), true, 'selecting the claimed solo language should succeed');
assert.deepEqual(attempts, [['solo-hi', 'hi']], 'the language switch must not fall through to another language row');

// A prewarmed episode must pick a claimed-language row over the backend's
// fastest fallback even when no manifest inventory has been measured yet.
const claimedOnlyHindi = { ...soloHindi, availableAudioLangs: [] };
const fastestEnglish = {
  ...soloHindi, id: 'fast-en', sourceId: 'source-3', audioLang: 'en', claimedAudioLang: undefined,
  availableAudioLangs: [],
};
const prewarmedPlayer = Object.create(ElfuraPlayer.prototype);
const prewarmedConfig = { mediaType: 'tv', season: 1, episode: 1, tmdb: '123', lang: undefined };
let prewarmedChoice = null;
Object.assign(prewarmedPlayer, {
  input: { config: prewarmedConfig }, destroyed: false, episodeGeneration: 0,
  resolveGeneration: 0, resolveAbort: null, lateHydrationToken: 0, audioSearchSeq: 0,
  activeProbe: null, engineLoadSeq: 0, desiredAudioLang: 'hi', mediaInfo: null,
  sources: [], pendingSourceGroups: [], failedSourceIds: new Set(), failedFingerprints: new Set(),
  prewarmedKeyTriggered: '',
  prewarmedNext: {
    season: 1, episode: 2, sources: [fastestEnglish, claimedOnlyHindi],
    fastest: fastestEnglish,
  },
  video: { pause() {}, removeAttribute() {}, load() {} },
  emit: () => {}, recomputeNextEpisodeTarget: () => {}, teardownEngine: () => {},
  fetchSeasonEpisodes: () => {}, reorderSourcesHierarchy: () => {},
  scheduleLateSourceHydration: () => {}, resolveBackendMediaUrl: value => value,
  activateSourceOption: async candidate => { prewarmedChoice = candidate; },
  playSelectedEpisode: () => {},
});
const previousWindow = globalThis.window;
globalThis.window = { location: { pathname: '/watch' } };
try {
  await prewarmedPlayer.loadEpisode(1, 2);
  assert.equal(prewarmedChoice?.id, 'solo-hi', 'prewarmed episode should match claimedAudioLang, not fall back to a different language');
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

console.log('✓ Solo-language rows remain selectable, correctly labeled and fast; conflicting manifests are still rejected.');
