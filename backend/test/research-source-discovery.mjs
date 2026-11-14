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
