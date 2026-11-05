// dash.js 5-shaped test adapter. Deliberately does not implement the removed
// getBitrateInfoListFor/setQualityFor methods.
export function MediaPlayer() {
  return { create: () => {
    const handlers = new Map();
    const player = {
      settingsCalls: [], selections: [],
      on(event, fn) { handlers.set(event, fn); },
      initialize() { queueMicrotask(() => handlers.get(MediaPlayer.events.STREAM_INITIALIZED)?.({})); },
      getTracksFor(type) { return type === 'audio' ? [{lang:'ko', labels:[]}] : []; },
      getRepresentationsByType() { return [
        {height:480,width:854,bandwidth:800000},
        {height:720,width:1280,bandwidth:1800000},
        {height:1080,width:1920,bandwidth:4000000},
      ]; },
      updateSettings(value) { this.settingsCalls.push(value); },
      setRepresentationForTypeByIndex(type, index) { this.selections.push({type,index}); },
      emitRendered(height) { handlers.get(MediaPlayer.events.QUALITY_CHANGE_RENDERED)?.({mediaType:'video',newRepresentation:{height}}); },
      reset() {},
    };
    globalThis.__elfuraDashTestPlayer = player;
    return player;
  } };
}
MediaPlayer.events = { STREAM_INITIALIZED:'streamInitialized', QUALITY_CHANGE_RENDERED:'qualityChangeRendered', ERROR:'error' };
