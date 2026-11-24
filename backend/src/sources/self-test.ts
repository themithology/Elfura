/**
 * Optional boot-time candidate discovery report. A returned candidate is not
 * evidence of working playback, audio language or subtitles.
 * Disable with ELFURA_SELF_TEST=0. The default test is a movie; to run an anime
 * TV episode instead set ELFURA_SELF_TEST_TYPE=tv and ELFURA_SELF_TEST_TMDB,
 * ELFURA_SELF_TEST_SEASON and ELFURA_SELF_TEST_EPISODE.
 */
import type { SourceRegistry } from './registry.js';

export async function runSourceSelfTest(registry: SourceRegistry): Promise<void> {
  const type = process.env.ELFURA_SELF_TEST_TYPE?.trim().toLowerCase() === 'tv' ? 'tv' : 'movie';
  const tmdbId = (process.env.ELFURA_SELF_TEST_TMDB || (type === 'tv' ? '46260' : '550')).trim();
  const positiveInt = (raw: string | undefined) => {
    const n = Number(raw ?? 1);
    return Number.isSafeInteger(n) && n > 0 && n <= 5000 ? n : 1;
  };
  const season = type === 'tv' ? positiveInt(process.env.ELFURA_SELF_TEST_SEASON) : undefined;
  const episode = type === 'tv' ? positiveInt(process.env.ELFURA_SELF_TEST_EPISODE) : undefined;
  const started = Date.now();
  try {
    const rows = await registry.selfTestAll({ type, tmdbId, season, episode });
    const tested = rows.filter(r => !r.skipped);
    const withCandidates = tested.filter(r => r.raw > 0);
    console.log(
      `[elfura-selftest] ${type}/${tmdbId}${type === 'tv' ? `/${season}/${episode}` : ''}: ` +
        `${withCandidates.length}/${tested.length} tested sources returned candidates in ${Date.now() - started}ms ` +
        `(${rows.length - tested.length} not applicable; candidates are not playback verification)`,
    );
    for (const row of rows) {
      console.log(row.skipped
        ? `[elfura-selftest]   ${row.id.padEnd(10)} skipped: ${row.skipped}`
        : `[elfura-selftest]   ${row.id.padEnd(10)} raw=${String(row.raw).padEnd(3)} ${row.ms}ms :: ${row.net}`);
    }
    if (!withCandidates.length) {
      console.warn('[elfura-selftest] no tested source returned candidates. This can mean missing metadata, a provider refusal, a network error, or no matching title; it does not prove playback is broken or working.');
    }
  } catch (err) {
    console.warn(`[elfura-selftest] failed: ${err instanceof Error ? err.name : 'Error'}`);
  }
}
