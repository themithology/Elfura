// Focused regressions for engine-confirmed audio switching. The media engines
// are small event adapters here; real browser/provider integration is covered
// separately by the opt-in browser diagnostics.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const buildModule = async (entry) => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    external: ['hls.js', 'dashjs'],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
};

const { ElfuraPlayer } = await buildModule('src/core/player.ts');
const { ExternalAudioSync } = await buildModule('src/core/audio.ts');
globalThis.window = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

function makeEventBus() {
  const listeners = new Map();
  return {
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
  };
}

function makePlayer({ audioTracks, hls = null, dash = null, HlsClass = null, DashClass = null }) {
  const player = Object.create(ElfuraPlayer.prototype);
  Object.assign(player, {
    sources: [],
    currentSource: { id: 'fixture-source', sourceId: 'source-1', multiAudio: true },
    currentAudio: audioTracks[0] ?? null,
    audioTracks,
    failedSourceIds: new Set(),
    failedFingerprints: new Set(),
    measuredRttByFp: new Map(),
    desiredAudioLang: null,
    initialAudioApplied: false,
    audioSearchSeq: 0,
    audioRequestSeq: 0,
    activeProbe: null,
    destroyed: false,
    hls,
    dash,
    HlsClass,
    DashClass,
    video: { currentTime: 0, paused: true, readyState: 2, muted: false, volume: 1 },
    shell: { dataset: {} },
    input: { config: { persistAudio: false } },
    externalAudio: { deactivate() {}, muted: false },
    emittedEvents: [],
    emit(event, payload) { this.emittedEvents.push({ event, payload }); },
    reorderSourcesHierarchy() {},
    recordDiscoveredAudioLangs() {},
  });
  return player;
}

// HLS: a property assignment is not success; the engine must emit the matching
// AUDIO_TRACK_SWITCHED event. A missing acknowledgement rolls the index back.
{
  const events = makeEventBus();
  const hls = {
    ...events,
    audioTracks: [
      { id: 0, lang: 'en', name: 'English' },
      { id: 1, lang: 'hi', name: 'Hindi' },
    ],
    _audioTrack: 0,
    suppressSwitch: false,
    get audioTrack() { return this._audioTrack; },
    set audioTrack(id) {
      this._audioTrack = id;
      if (!this.suppressSwitch) queueMicrotask(() => this.emit('audioTrackSwitched', 'audioTrackSwitched', { id }));
    },
  };
  const native = [
    { id: 'native:0', kind: 'native', lang: 'en', label: 'English', ref: 0 },
    { id: 'native:1', kind: 'native', lang: 'hi', label: 'Hindi', ref: 1 },
  ];
  const player = makePlayer({
    audioTracks: native,
    hls,
    HlsClass: { Events: { AUDIO_TRACK_SWITCHED: 'audioTrackSwitched' } },
  });

  assert.equal(await player.setAudio('native:1'), true);
  assert.equal(hls.audioTrack, 1);
  assert.equal(player.currentAudio.lang, 'hi');
  assert.equal(player.emittedEvents.filter(({ event }) => event === 'audioChange').length, 1);

  hls.suppressSwitch = true;
  const requestSeq = player.audioRequestSeq;
  assert.equal(await player.switchHlsAudioTrack(0, requestSeq, 10), false);
  assert.equal(hls.audioTrack, 1, 'failed HLS switch should restore the last confirmed rendition');

  player.switchHlsAudioTrack = async () => false;
  assert.equal(await player.setAudio('native:0'), false, 'an unconfirmed native switch is not reported as successful');
  assert.equal(player.currentAudio.lang, 'hi', 'failed switch preserves the last confirmed selection');
  assert.equal(player.emittedEvents.filter(({ event }) => event === 'audioChange').length, 1, 'failed switch emits no audioChange event');
}

// DASH: use a label when MediaInfo.lang is absent, select the exact track, and
// only resolve once TRACK_CHANGE_RENDERED reports that audio MediaInfo.
{
  const events = makeEventBus();
  const english = { id: 'en-track', index: 0, lang: 'en', labels: [{ text: 'English' }] };
  const hindi = { id: 'hi-track', index: 1, lang: null, labels: [{ text: 'Hindi' }] };
  const dash = {
    ...events,
    tracks: [english, hindi],
    current: english,
    suppressSwitch: false,
    getTracksFor(type) { return type === 'audio' ? this.tracks : []; },
    getCurrentTrackFor(type) { return type === 'audio' ? this.current : null; },
    setCurrentTrack(track) {
      const oldMediaInfo = this.current;
      this.current = track;
      if (!this.suppressSwitch) {
        queueMicrotask(() => this.emit('trackChangeRendered', { mediaType: 'audio', oldMediaInfo, newMediaInfo: track }));
      }
    },
  };
  const native = [
    { id: 'native:0', kind: 'native', lang: 'en', label: 'English', ref: 0 },
    { id: 'native:1', kind: 'native', lang: 'hi', label: 'Hindi', ref: 1 },
  ];
  const player = makePlayer({
    audioTracks: native,
    dash,
    DashClass: { events: { TRACK_CHANGE_RENDERED: 'trackChangeRendered' } },
  });

  const dashResult = await player.setAudio('hi');
  assert.equal(dashResult, true);
  assert.equal(dash.current.id, 'hi-track');
  assert.equal(player.currentAudio.lang, 'hi');
  assert.equal(player.emittedEvents.filter(({ event }) => event === 'audioChange').length, 1);

  dash.suppressSwitch = true;
  assert.equal(await player.switchDashAudioTrack(english, player.audioRequestSeq, 10), false);
  assert.equal(dash.current.id, 'hi-track', 'failed DASH switch should restore the last confirmed rendition');
}

// External sidecar readiness and mute semantics: wait for canplay, preserve the
// viewer's mute setting, and fail/restore state on an audio-element error.
class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.readyState = 0;
    this.paused = true;
    this.currentTime = 0;
    this.duration = 600;
    this.volume = 1;
    this.muted = false;
    this._src = '';
    this.playCalls = 0;
  }
  addEventListener(event, fn) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
  }
  removeEventListener(event, fn) { this.listeners.get(event)?.delete(fn); }
  dispatch(event) { for (const fn of [...(this.listeners.get(event) ?? [])]) fn({ type: event }); }
  set src(value) { this._src = value; this.load(); }
  get src() { return this._src; }
  removeAttribute(name) {
    if (name === 'src') {
      this._src = '';
      this.readyState = 0;
    }
  }
  load() {
    if (this._src.includes('audio-error')) queueMicrotask(() => this.dispatch('error'));
  }
  play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

globalThis.Audio = FakeAudio;
function makeVideo() {
  const listeners = new Map();
  return {
    currentTime: 42,
    paused: true,
    muted: false,
    volume: 0.7,
    playbackRate: 1,
    addEventListener(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
    },
    dispatch(event) { for (const fn of [...(listeners.get(event) ?? [])]) fn({ type: event }); },
  };
}

{
  const sync = new ExternalAudioSync();
  const video = makeVideo();
  sync.bind(video);
  let activationSettled = false;
  const activation = sync.activate({
    id: 'external:hi', kind: 'external', lang: 'hi', label: 'Hindi', ref: 'https://media.example/hindi.ogg',
  }).then((result) => {
    activationSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(activationSettled, false, 'load() returning is not sidecar readiness; activation waits for canplay');
  sync.audio.readyState = 3;
  sync.audio.dispatch('loadedmetadata');
  sync.audio.dispatch('canplay');
  const result = await activation;
  assert.equal(result.ok, true);
  assert.equal(sync.activeTrack?.lang, 'hi');
  assert.equal(sync.audio.readyState, 3);
  assert.equal(sync.audio.playCalls, 0, 'a paused video should preload but not start the sidecar');
  assert.equal(video.muted, true, 'the in-band video audio is suppressed while the sidecar is active');
  assert.equal(sync.audio.muted, false, 'forced video mute does not mute the external audio');
  assert.equal(sync.muted, false);

  video.dispatch('volumechange');
  assert.equal(sync.audio.muted, false, 'volumechange must not copy forced video mute to the sidecar');
  assert.equal(sync.audio.volume, 0.7);
  const sidecarController = Object.create(ElfuraPlayer.prototype);
  Object.assign(sidecarController, { video, externalAudio: sync, emittedEvents: [] });
  sidecarController.emit = (event, payload) => sidecarController.emittedEvents.push({ event, payload });
  sidecarController.setMuted(true);
  assert.equal(sync.audio.muted, true);
  assert.equal(sync.muted, true);
  assert.deepEqual(sidecarController.emittedEvents.at(-1), { event: 'volumechange', payload: { volume: 0.7, muted: true } });
  sidecarController.setMuted(false);
  assert.equal(sync.audio.muted, false);
  sync.deactivate();
  assert.equal(video.muted, false, "deactivation restores the user's original mute setting");
  sync.destroy();

  const failing = new ExternalAudioSync();
  const failedVideo = makeVideo();
  failing.bind(failedVideo);
  const failure = await failing.activate({
    id: 'external:hi:error', kind: 'external', lang: 'hi', label: 'Hindi', ref: 'https://media.example/audio-error.ogg',
  });
  assert.equal(failure.ok, false);
  assert.equal(failing.activeTrack, null);
  assert.equal(failedVideo.muted, false, 'load failure restores the original mute state');
  failing.destroy();
}

console.log('HLS, DASH, and sidecar audio selection wait for engine/media confirmation.');
