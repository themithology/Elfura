/**
 * Playback timeouts are trait-driven, not provider-id-driven. Adapters can
 * declare `slowManifest` or `hevcFirst`; otherwise the player uses its normal
 * bounded startup and segment deadlines.
 */
export function playbackTimeouts(
  traits?: string[] | string,
): { manifest: number; level: number; fragment: number; startup: number } {
  const list = Array.isArray(traits) ? traits : traits ? [traits] : [];
  const slow = list.includes('slowManifest') || list.includes('hevcFirst');
  return slow
    ? { manifest: 12_000, level: 12_000, fragment: 15_000, startup: 15_000 }
    : { manifest: 5_500, level: 5_500, fragment: 7_000, startup: 10_000 };
}
