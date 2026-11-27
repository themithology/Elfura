// A failed language search must not erase the viewer's preference. Selecting a
// multi-audio server afterwards should retain that language and allow a fresh
// explicit retry of sources that failed transiently on the previous attempt.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

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

const english = {
  id: 'english', sourceId: 'source-1', label: 'Source 1 · English', type: 'mp4',
  url: 'https://media.example/en.mp4', quality: '1080p', audioLang: 'en', audioTracks: [], subtitles: [],
};
const directHindi = {
  id: 'direct-hindi', sourceId: 'source-2', label: 'Source 2 · Hindi', type: 'mp4',
  url: 'https://media.example/hi.mp4', quality: '1080p', audioLang: 'hi', fingerprint: 'fp-hi', audioTracks: [], subtitles: [],
};
const multiAudio = {
  id: 'multi-audio', sourceId: 'source-3', label: 'Source 3 · Multi-Audio', type: 'hls',
  url: 'https://media.example/master.m3u8', quality: '1080p', multiAudio: true,
  availableAudioLangs: ['en', 'hi'], fingerprint: 'fp-multi', audioTracks: [], subtitles: [],
};

const player = Object.create(ElfuraPlayer.prototype);
player.sources = [english, directHindi, multiAudio];
player.currentSource = english;
player.currentAudio = null;
player.audioTracks = [];
player.failedSourceIds = new Set();
player.failedFingerprints = new Set();
player.measuredRttByFp = new Map();
player.desiredAudioLang = null;
player.initialAudioApplied = false;
player.audioSearchSeq = 0;
player.activeProbe = null;
player.destroyed = false;
player.video = { currentTime: 0, paused: true, readyState: 0 };
player.shell = { dataset: {} };
player.input = { config: { persistAudio: false } };
player.emit = () => {};
player.canPreProbeViaFetch = () => false;
player.reorderSourcesHierarchy = () => {};
player.recordDiscoveredAudioLangs = () => {};

let activated = null;
player.activateSourceOption = async (option) => {
  activated = option;
  player.currentSource = option;
};

const attempts = [];
let retrySucceeds = false;
player.probeRawCandidateForLanguage = async (option, lang) => {
  attempts.push({ id: option.id, lang });
  player.currentSource = option;
  return { ok: retrySucceeds && option.id === 'multi-audio', loadFailed: !retrySucceeds };
};

const firstAttempt = await player.setAudio('hi');
assert.equal(firstAttempt, false, 'the first Hindi attempt should exhaust the failing fixture sources');
assert.equal(player.currentSource.id, 'english', 'failed language search restores working playback');
assert.equal(player.desiredAudioLang, 'hi', 'failure must not erase the requested language preference');
assert.deepEqual(attempts.map(({ id }) => id), ['multi-audio', 'direct-hindi']);

// This is the same path used by the Sources tab. It must clear transient
// failure marks and carry Hindi onto the manually selected multi-audio source.
const selected = await player.setSource('multi-audio');
assert.equal(selected, true);
assert.equal(player.currentSource.id, 'multi-audio');
assert.equal(player.desiredAudioLang, 'hi', 'manual multi-audio server selection keeps the failed language request');
assert.equal(player.failedSourceIds.size, 0, 'manual selection gives failed candidates a fresh attempt');
assert.equal(player.failedFingerprints.size, 0, 'manual selection clears stale fingerprint failures');

// A second explicit request retries the same multi-audio source and can now win.
retrySucceeds = true;
const retry = await player.setAudio('hi');
assert.equal(retry, true, 'a fresh user request must retry a source failed on the previous attempt');
assert.equal(player.currentSource.id, 'multi-audio');
assert.equal(player.currentAudio.lang, 'hi');
assert.deepEqual(attempts.map(({ id }) => id), ['multi-audio', 'direct-hindi', 'multi-audio']);

// A manually selected provider family outranks a faster multi-audio option from
// another provider, but only after the candidate is actually verified.
const manualEnglish = { ...english, id: 'manual-english', sourceId: 'manual-provider' };
const manualHindi = { ...directHindi, id: 'manual-hindi', sourceId: 'manual-provider', latencyHintMs: 900 };
const fasterOtherProvider = { ...multiAudio, id: 'faster-other-provider', sourceId: 'other-provider', latencyHintMs: 1 };
const manualPlayer = Object.create(ElfuraPlayer.prototype);
Object.assign(manualPlayer, {
  sources: [manualEnglish, manualHindi, fasterOtherProvider],
  currentSource: null,
  currentAudio: null,
  audioTracks: [],
  failedSourceIds: new Set(),
  failedFingerprints: new Set(),
  measuredRttByFp: new Map(),
  desiredAudioLang: null,
  initialAudioApplied: false,
  audioSearchSeq: 0,
  activeProbe: null,
  destroyed: false,
  video: { currentTime: 0, paused: true, readyState: 0 },
  shell: { dataset: {} },
  input: { config: { persistAudio: false } },
  emit: () => {},
  canPreProbeViaFetch: () => false,
  reorderSourcesHierarchy: () => {},
  recordDiscoveredAudioLangs: () => {},
});
manualPlayer.activateSourceOption = async (option) => { manualPlayer.currentSource = option; };
const manualAttempts = [];
manualPlayer.probeRawCandidateForLanguage = async (option) => {
  manualAttempts.push(option.id);
  manualPlayer.currentSource = option;
  return { ok: option.id === 'manual-hindi' };
};
await manualPlayer.setSource('manual-english');
const manualLanguageSwitch = await manualPlayer.setAudio('hi');
assert.equal(manualLanguageSwitch, true);
assert.equal(manualPlayer.currentSource.id, 'manual-hindi', 'manually selected provider is tried before cross-provider speed ranking');
assert.deepEqual(manualAttempts, ['manual-hindi']);

console.log('Audio preference survives failure; manual source selection and explicit retry are honored.');
