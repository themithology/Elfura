// Test-only HLS adapter used by e2e.mjs through Node's module hooks.
// It exercises ElfuraPlayer's real loadHls()/MANIFEST_PARSED handler while
// reproducing the valid event order that previously lost Hindi:
// MANIFEST_PARSED -> AUDIO_TRACKS_UPDATED -> FRAG_LOADED.
export default class HlsEventOrderMock {
  static Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    FRAG_LOADED: 'hlsFragLoaded',
    BUFFER_APPENDED: 'hlsBufferAppended',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
    SUBTITLE_TRACKS_UPDATED: 'hlsSubtitleTracksUpdated',
    ERROR: 'hlsError',
  };

  static ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
  };

  static isSupported() {
    return true;
  }

  constructor() {
    this.listeners = new Map();
    this.audioTrack = 0;
    this.subtitleTrack = -1;
    this.currentLevel = -1;
    this.autoLevelCapping = -1;
    this.eventLog = [];
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event, data = {}) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(event, data);
    }
  }

  loadSource() {
    const audioTracks = [
      { id: 0, lang: 'eng', name: 'English', default: true },
      { id: 1, lang: 'hin', name: 'Hindi', default: false },
    ];
    queueMicrotask(() => {
      this.eventLog.push('manifest');
      this.emit(HlsEventOrderMock.Events.MANIFEST_PARSED, {
        levels: [{ height: 720, width: 1280, bitrate: 2_000_000, videoCodec: 'avc1.64001f' }],
        audioTracks,
      });
      // Deliberately publish the public/native track list after the manifest.
      setTimeout(() => {
        this.eventLog.push('audioTracks');
        this.emit(HlsEventOrderMock.Events.AUDIO_TRACKS_UPDATED, { audioTracks });
        // Liveness must still be required: manifest metadata alone is not ok.
        setTimeout(() => {
          this.eventLog.push('fragment');
          this.emit(HlsEventOrderMock.Events.FRAG_LOADED, {});
        }, 0);
      }, 0);
    });
  }

  attachMedia() {}
  startLoad() {}
  stopLoad() {}
  recoverMediaError() {}
  destroy() {
    this.listeners.clear();
  }
}
