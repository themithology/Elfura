import { createBackendServer } from '../../dist/backend/index.js';

const TARGETS = new Set([
  'source-4', 'source-5', 'source-7', 'source-9', 'source-11',
  'source-12', 'source-13', 'source-15', 'source-16',
]);
const type = process.env.PROBE_TYPE === 'tv' ? 'tv' : 'movie';
const tmdbId = process.env.PROBE_TMDB || '693134';
const season = Number(process.env.PROBE_SEASON || 1);
const episode = Number(process.env.PROBE_EPISODE || 1);
const anilistId = process.env.PROBE_ANILIST || undefined;
const anilistEpisode = process.env.PROBE_ANILIST_EPISODE
  ? Number(process.env.PROBE_ANILIST_EPISODE)
  : undefined;

const { registry } = createBackendServer({
  secret: Buffer.from('live-source-discovery-audit-only-secret'),
  requireToken: false,
  bindTokenIp: false,
  resolveTimeoutMs: 20_000,
});
const sourceHosts = new Map([
  ['bingr.one', 'source-4'],
  ['vixsrc.to', 'source-9'],
  ['streamdata.vaplayer.ru', 'source-11'],
  ['vidzen.fun', 'source-12'],
  ['freakyniki.elaxo.lol', 'source-13'],
  ['mapple.fun', 'source-15'],
]);
const network = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input)); }
  catch { return originalFetch(input, init); }
  const source = sourceHosts.get(url.hostname);
  if (!source) return originalFetch(input, init);
  const stage = source === 'source-4'
    ? (url.pathname.startsWith('/watch/') ? 'watch-page' : url.pathname.startsWith('/api/') ? 'sources-api' : 'other')
    : source === 'source-9'
      ? (url.pathname.startsWith('/api/') ? 'title-api' : 'embed-page')
      : source === 'source-11' ? 'title-api'
        : source === 'source-12'
          ? (url.pathname.startsWith('/api/sources') ? 'sources-api' : 'watch-page')
          : source === 'source-13' ? 'title-api'
            : url.pathname.includes('playback-init') ? 'playback-init'
              : url.pathname.includes('encrypt') ? 'encrypt'
                : url.pathname.includes('stream-encrypted') ? 'stream' : 'watch-page';
  const start = Date.now();
  try {
    const response = await originalFetch(input, init);
    network.push({ source, stage, status: response.status, ms: Date.now() - start });
    return response;
  } catch (error) {
    network.push({ source, stage, error: error instanceof Error ? error.name : 'Error', ms: Date.now() - start });
    throw error;
  }
};
const report = await registry.diagnosePlayback({
  type,
  tmdbId,
  season,
  episode,
  ...(anilistId ? { anilistId } : {}),
  ...(anilistEpisode ? { anilistEpisode } : {}),
});
const sources = report.adapters
  .filter((source) => TARGETS.has(source.id))
  .map(({ id, ms, raw, retained, manifestReachable, manifestMultiAudio, types, error }) => ({
    id, ms, raw, retained, manifestReachable, manifestMultiAudio, types, error,
  }));
const lanes = report.lanes
  .filter((lane) => TARGETS.has(lane.adapter))
  .map(({ adapter, lane, ok, ms, detail, candidateCount, manifestReachable, manifestFailed, manifestUnknown }) => ({
    adapter, lane, ok, ms, detail, candidateCount, manifestReachable, manifestFailed, manifestUnknown,
  }));
const result = {
  title: process.env.PROBE_TITLE || `${type} ${tmdbId}`,
  type, tmdbId, season, episode,
  ...(anilistId ? { anilistId, anilistEpisode } : {}),
  sources,
  lanes,
};
console.log(`::notice title=SourceDiscovery::${JSON.stringify(result)}`);
for (const source of TARGETS) {
  const events = network.filter((event) => event.source === source).slice(0, 24);
  if (events.length) console.log(`::notice title=SourceNetwork::${source} ${JSON.stringify(events)}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `## Live source discovery: ${result.title}`,
    '',
    '| Source | Raw candidates | Manifest retained | Reachable | Source detail |',
    '|---|---:|---:|---:|---|',
    ...sources.map((source) => {
      const details = lanes.filter((lane) => lane.adapter === source.id).map((lane) => `${lane.lane}: ${lane.detail}`).join('<br>');
      return `| ${source.id} | ${source.raw} | ${source.retained} | ${source.manifestReachable} | ${details || source.error || ''} |`;
    }),
  ];
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
