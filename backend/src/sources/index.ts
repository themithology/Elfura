/**
 * The source manifest — the only door into the registry
 * =====================================================
 *
 * A source exists in two places and nowhere else:
 *
 *   1. a module under ./sources/ that exports a `SourceAdapter` factory
 *   2. one entry in APPROVED_SOURCES below
 *
 * Nothing else may import a source module. The registry builds its adapter list
 * from this array and from nothing else, so an entry that is not here cannot
 * serve traffic — and an entry that is here is exercised by
 * `backend/test/source-contract.mjs`, which resolves real titles, fetches a real
 * manifest and pulls real segment bytes. If a source cannot do that, the suite
 * fails and the entry does not belong here.
 *
 * That is the whole lesson of the previous board: thirty adapters, most of which
 * answered nothing, and a console that reported coverage instead of streams.
 * Fewer lanes, each one proven. An empty array is a valid, honest state — the
 * service boots, the proxy works, and /api/v1/playback says plainly that no
 * source is configured rather than pretending otherwise.
 *
 * Adding one, in order:
 *
 *   1. Write the adapter module. It reads its own settings from the environment
 *      (see `sourceEnv` below) so config.ts stays free of per-source keys.
 *   2. Add the entry here with the titles the contract test must resolve.
 *   3. `npm run build && node backend/test/source-contract.mjs` — it must print
 *      the manifest and the segment byte count for your source, not a timeout.
 *   4. Only then commit.
 *
 * If the lane needs different behaviour from the player, set a `SourceTrait` on
 * the adapter (`aggregator`, `animeEpisode`, `hardSubtitle`, `slowManifest`,
 * `hevcFirst`) instead of adding a provider id to a list in `src/`. The traits
 * travel to the client with each option, and `backend/test/standing-rules.mjs`
 * fails the build if a concrete adapter import or a second source table comes
 * back into the registry or config.
 */

import type { SourceAdapter } from './types.js';
import { createCitadelAdapter } from './citadel.js';

/**
 * What a source may read: `process.env`, already carrying the `.env` overlay.
 * `hydrateProcessEnvFromDotEnv()` runs before any adapter is constructed
 * (backend/src/index.ts), and it never overwrites a real environment variable,
 * so this is the same precedence the rest of the app uses. Sources read their
 * own settings from here instead of growing a key per lane in BackendConfig.
 */
export function sourceEnv(): Record<string, string | undefined> {
  return process.env as Record<string, string | undefined>;
}

export interface SourceDefinition {
  /** Stable id. This is what the panel, the logs and the contract test use. */
  id: string;
  /**
   * Environment variable that switches the lane off when set to "0".
   * Omit for a lane with no operator switch.
   */
  envFlag?: string;
  /** Builds the adapter. Called once, at registry construction. */
  create: () => SourceAdapter;
  /**
   * Operator-only "is this site up" check for the panel. Optional: a lane that
   * fronts several hosts, or none of its own, simply omits it. This is never a
   * playback test and must not be presented as one.
   */
  website?: { name: string; url: string };
  /**
   * Titles the contract test must resolve into playable bytes.
   * Pick titles you have confirmed exist upstream; a probe that 404s everywhere
   * proves nothing either way.
   */
  probes: Array<{ type: 'movie' | 'tv'; tmdbId: string; season?: number; episode?: number }>;
}

/**
 * Approved sources. Empty on purpose: the board starts at zero and every entry
 * has to earn its place through source-contract.mjs.
 */
export const APPROVED_SOURCES: SourceDefinition[] = [
  {
    id: 'source-1',
    envFlag: 'ELFURA_CITADEL_ENABLED',
    create: () => createCitadelAdapter(),
    website: { name: 'RiveStream', url: 'https://www.rivestream.app' },
    // Probed on GitHub runners on 2026-11-24: both titles resolved and both
    // returned real segment bytes, twice, with no browser involved. They are the
    // titles the contract test must keep reproducing.
    probes: [
      { type: 'movie', tmdbId: '550' },
      { type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
    ],
  },
];

/** Ids of the approved sources, for logs and for the contract test. */
export function approvedSourceIds(): string[] {
  return APPROVED_SOURCES.map((source) => source.id);
}
