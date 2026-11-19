/**
 * Boot-time source self-test
 * ==========================
 * "Nothing loads and the console only says raw=0" is not a diagnosis. This runs
 * once per boot against a well-known title, asks every adapter directly, and
 * prints what came back — candidate count plus the hosts it talked to and the
 * status each one answered with. Ten seconds of startup traffic buys an instant,
 * legible answer to "which sources are actually working from this machine".
 *
 * Disable with ELFURA_SELF_TEST=0. Title override: ELFURA_SELF_TEST_TMDB=550.
 */
import type { SourceRegistry } from './registry.js';

const DEFAULT_TMDB = '550';

export async function runSourceSelfTest(registry: SourceRegistry): Promise<void> {
  const tmdbId = (process.env.ELFURA_SELF_TEST_TMDB || DEFAULT_TMDB).trim();
  const started = Date.now();
  try {
    const rows = await registry.selfTestAll({ type: 'movie', tmdbId });
    const alive = rows.filter((r) => r.raw > 0);
    console.log(
      `[elfura-selftest] movie/${tmdbId}: ${alive.length}/${rows.length} sources returned candidates ` +
        `in ${Date.now() - started}ms`,
    );
    for (const row of rows) {
      console.log(
        `[elfura-selftest]   ${row.id.padEnd(10)} raw=${String(row.raw).padEnd(3)} ${row.ms}ms :: ${row.net}`,
      );
    }
    if (!alive.length) {
      console.warn(
        '[elfura-selftest] no source returned anything. Every line above shows the host each adapter ' +
          'contacted and how it answered — 403/challenge means the host is blocking this machine\'s IP, ' +
          'timeout/DNS means the host is unreachable from here, HTTP 200 with raw=0 means the source answered ' +
          'but has no row for this title.',
      );
    }
  } catch (err) {
    console.warn(`[elfura-selftest] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
