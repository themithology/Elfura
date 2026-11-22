/** Longer bounded waits for TGVIDX's slower proxied playlists and fragments. */
export function playbackTimeouts(sourceId?: string): { manifest: number; level: number; fragment: number; startup: number } {
  return sourceId === 'source-17'
    ? { manifest: 12_000, level: 12_000, fragment: 15_000, startup: 15_000 }
    : { manifest: 5_500, level: 5_500, fragment: 7_000, startup: 10_000 };
}
