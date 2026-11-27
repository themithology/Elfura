/**
 * Playback timeouts — trait-driven, not id-driven.
 * New adapters set traits (aggregator, animeEpisode, hardSubtitle, slowManifest, hevcFirst)
 * instead of hardcoding provider ids in the player.
 * `slowManifest` / `hevcFirst` are the lanes that need the TGVIDX-length 12s/15s waits.
 */
export function playbackTimeouts(
  traits?: string[] | string,
): { manifest: number; level: number; fragment: number; startup: number } {
  const list = Array.isArray(traits) ? traits : traits ? [traits] : [];
  const slow = list.includes('slowManifest') || list.includes('hevcFirst') || list.includes('source-17');
  return slow
    ? { manifest: 12_000, level: 12_000, fragment: 15_000, startup: 15_000 }
    : { manifest: 5_500, level: 5_500, fragment: 7_000, startup: 10_000 };
}
