/**
 * Bounded waits for playlist and fragment fetching.
 *
 * The long budget belongs to a lane that says it is slow (`slowManifest`), not
 * to a provider by name: the first board hardcoded `source-17` here, so the
 * player had to be edited before any other aggregator could be added.
 */
export interface PlaybackTimeouts {
  manifest: number;
  level: number;
  fragment: number;
  startup: number;
}

const STANDARD: PlaybackTimeouts = { manifest: 5_500, level: 5_500, fragment: 7_000, startup: 10_000 };
const SLOW: PlaybackTimeouts = { manifest: 12_000, level: 12_000, fragment: 15_000, startup: 15_000 };

export function playbackTimeouts(traits?: readonly string[]): PlaybackTimeouts {
  return traits?.includes('slowManifest') ? SLOW : STANDARD;
}
