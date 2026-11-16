/**
 * Source resolution: in-process or over the wire.
 *
 * Provider scraping is the least stable part of this project — a site changes its
 * markup and an adapter starts failing, often slowly, often while holding a
 * connection until a timeout. Keeping that work in the same process as the media
 * server means a bad provider competes with a viewer's playback for the same CPU
 * and the same heap.
 *
 * This module is the seam that lets the two be separated without touching the
 * player: `/api/v1/playback` asks for streams through `PlaybackResolver`, and the
 * implementation is either the registry in this process or an HTTP call to a
 * resolver process. The player, the relay and the stream ticket format are all
 * unchanged either way, and both sides share ELFURA_SECRET so tickets minted by
 * the resolver open in the media server.
 *
 * Configuration:
 *   ELFURA_RESOLVER_URL     base URL of the resolver, e.g. http://127.0.0.1:8790
 *                           unset -> resolve in this process (the default)
 *   ELFURA_RESOLVER_TOKEN   shared secret for the resolver's HTTP API;
 *                           defaults to ELFURA_SECRET so there is one thing to set
 *
 * The media server never calls a resolver over the public internet without a
 * token, and never falls back silently: if a resolver is configured and
 * unreachable, that is an outage to report, not a reason to hammer providers
 * from a process that is supposed to be serving video.
 */

import type { UniformPlaybackResponse } from './sources/types.js';

/** What a caller must supply to resolve streams for one title. */
export interface PlaybackRequest {
  type: 'movie' | 'tv';
  tmdbId: string;
  anilistId?: string;
  season?: number;
  episode?: number;
  anilistEpisode?: number;
  sourceId?: string;
  preferredLang?: string;
  late?: boolean;
  /** Base path the resolver should use when minting stream tickets. */
  streamPathPrefix?: string;
}

/**
 * The resolver's answer. Typed loosely on purpose: the shape is defined by the
 * registry and travels as JSON, and this module must not become a second copy of
 * it that drifts.
 */
export type PlaybackResolution = UniformPlaybackResponse;

export interface PlaybackResolver {
  /** 'local' when this process scrapes, 'remote' when another one does. */
  readonly kind: 'local' | 'remote';
  /** Human-readable identity for logs, e.g. 'local' or 'http://127.0.0.1:8790'. */
  readonly label: string;
  resolve(request: PlaybackRequest): Promise<PlaybackResolution | null>;
  /** Whether the resolver is reachable, for the panel and the health endpoint. */
  probe(): Promise<{ reachable: boolean; detail: string; sources?: string[] }>;
  /** Per-source status, when the resolver can report it. */
  sourceStatus(): Promise<ResolverSourceStatus[] | null>;
  /** Turn a source on or off without a redeploy. */
  setSourceEnabled(id: string, enabled: boolean): Promise<boolean>;
}

export interface ResolverSourceStatus {
  id: string;
  label: string;
  /** Operator turned it off. */
  disabledByOperator: boolean;
  /** Paused automatically after repeated failures; still counted as enabled. */
  paused: boolean;
  consecutiveFailures: number;
  /** Epoch ms of the next attempt, when paused. */
  retryAt: number | null;
  /** Last failure reason, short and safe to show. */
  lastError: string | null;
  /** Resolves this source completed successfully since the counter was reset. */
  successes: number;
  /** Extra context for the operator; never a credential. */
  detail: string;
}

/** Header names for the resolver's HTTP API. Kept in one place on purpose. */
export const RESOLVER_AUTH_HEADER = 'x-elfura-resolver-token';

/**
 * Reads the resolver configuration from the environment.
 *
 * Returns null when this process should resolve locally, which is the default and
 * the only supported mode for a single-container install.
 */
export function resolverConfig(env: NodeJS.ProcessEnv = process.env): { url: string; token: string } | null {
  const url = (env.ELFURA_RESOLVER_URL ?? '').trim();
  if (!url) return null;
  // Both sides must run on the same machine or a private network; a resolver is
  // an internal component, not a service to expose.
  if (!/^https?:\/\//i.test(url)) return null;
  const token = (env.ELFURA_RESOLVER_TOKEN ?? env.ELFURA_SECRET ?? '').trim();
  return { url: url.replace(/\/+$/, ''), token };
}

/**
 * The in-process resolver: calls the registry directly.
 *
 * This is the default and it is not a fallback — a single-container install is a
 * perfectly good deployment. The split exists so an operator who wants provider
 * scraping isolated from video serving can have it without changing the player.
 */
export function createLocalPlaybackResolver(registry: {
  resolvePlayback(params: PlaybackRequest): Promise<PlaybackResolution | null>;
  listPublicSources(): { id: string; label: string }[];
  health: {
    snapshot(known?: { id: string; label: string }[]): ResolverSourceStatus[];
    setEnabled(id: string, enabled: boolean): void;
  };
}): PlaybackResolver {
  return {
    kind: 'local',
    label: 'in-process',
    async resolve(request) {
      return registry.resolvePlayback(request);
    },
    async probe() {
      return { reachable: true, detail: 'resolving in this process', sources: registry.listPublicSources().map((s) => s.id) };
    },
    async sourceStatus() {
      return registry.health.snapshot(registry.listPublicSources());
    },
    async setSourceEnabled(id, enabled) {
      registry.health.setEnabled(id, enabled);
      return true;
    },
  };
}
