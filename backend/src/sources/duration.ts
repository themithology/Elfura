/**
 * Runtime guard.
 *
 * Some sources happily serve a 40-second intro, a trailer, a 12-minute recap or
 * a double-episode bundle for the requested title. They are "alive" and they
 * play — they are just the wrong video. Comparing the measured playlist runtime
 * with the runtime TMDB reports for this exact movie/episode removes them
 * without touching anything that could not be measured.
 *
 * Tolerance: ±20 minutes for a movie, ±5 minutes for one TV episode. Short
 * content (< 10 minutes) gets its own runtime as the window so a genuine 4-minute
 * short is not rejected by a percentage rule.
 */

export const DURATION_TOLERANCE_SEC = { movie: 20 * 60, tv: 5 * 60 } as const;

export function durationToleranceSec(type: 'movie' | 'tv', expectedSec: number | null | undefined): number {
  const base = DURATION_TOLERANCE_SEC[type] ?? DURATION_TOLERANCE_SEC.movie;
  if (!expectedSec || expectedSec <= 0) return base;
  // Short content must not inherit a ±20 min window: half its own runtime, with
  // a 1-minute floor, keeps a 4-minute short judged on a 4-minute scale.
  if (expectedSec < 600) return Math.max(60, Math.round(expectedSec / 2));
  return base;
}

/**
 * `true` means "keep it". An unmeasurable stream (live, MP4, playlist without
 * `#EXT-X-ENDLIST`) or an unknown expected runtime is always kept: the guard may
 * only remove what it can prove is the wrong runtime.
 */
export function durationFits(
  measuredSec: number | null | undefined,
  expectedSec: number | null | undefined,
  toleranceSec: number,
): boolean {
  if (!expectedSec || expectedSec <= 0) return true;
  if (!measuredSec || measuredSec <= 0) return true;
  return Math.abs(measuredSec - expectedSec) <= toleranceSec;
}
