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
/**
 * Why the last resolverConfig() call fell back to local, or '' when it did not.
 *
 * The split between media and resolver used to fail silently: an unset variable,
 * a malformed URL and a refused public URL all produced the same inscrutable
 * `{kind:"local"}` in the panel, and the only symptom was "the split does not
 * help". This records the reason so the panel and the boot log can say which.
 */
let lastFallbackReason = '';

export function resolverFallbackReason(): string {
  return lastFallbackReason;
}

export function resolverConfig(env: NodeJS.ProcessEnv = process.env): { url: string; token: string } | null {
  lastFallbackReason = '';
  const url = (env.ELFURA_RESOLVER_URL ?? '').trim();
  if (!url) {
    // Not an error: this is the documented single-container default. But when the
    // operator has clearly meant to split (a token or an autostart is set) it is
    // almost certainly a mistake, so say so loudly.
    lastFallbackReason = 'ELFURA_RESOLVER_URL is not set';
    if ((env.ELFURA_RESOLVER_TOKEN ?? '').trim() || env.ELFURA_RESOLVER_AUTOSTART === '1') {
      console.error(
        '[elfura-resolver] ELFURA_RESOLVER_URL is NOT set, but ELFURA_RESOLVER_TOKEN/autostart is. ' +
          'This process will resolve sources locally and the resolver node will sit idle. ' +
          'Set ELFURA_RESOLVER_URL=http://<resolver-ip>:<port>.',
      );
    }
    return null;
  }
  if (!/^https?:\/\//i.test(url)) {
    lastFallbackReason = `ELFURA_RESOLVER_URL is not an http(s) URL: ${url}`;
    console.error(`[elfura-resolver] ${lastFallbackReason} - resolving locally instead.`);
    return null;
  }
  const token = (env.ELFURA_RESOLVER_TOKEN ?? env.ELFURA_SECRET ?? '').trim();
  const clean = url.replace(/\/+$/, '');
  // A resolver is an internal component. Over the open internet, the token is
  // transmitted on every call, and the responses name sources and hand back
  // stream URLs — so a public resolver URL means leaking exactly what the design
  // hides. Addresses that are obviously private (localhost, RFC1918, WireGuard
  // ranges, *.internal / *.local) need no ceremony; anything else must be an
  // explicit decision by the operator.
  if (!isPrivateResolverUrl(clean) && env.ELFURA_RESOLVER_ALLOW_PUBLIC !== '1') {
    console.error(
      `[elfura-resolver] refusing to use a public resolver URL (${clean}): it would send the ` +
        'shared token and receive source names over the internet. Use a private address ' +
        '(127.0.0.1, 10.x, 172.16-31.x, 192.168.x, 100.64-127.x, *.internal), or set ' +
        'ELFURA_RESOLVER_ALLOW_PUBLIC=1 if you have a TLS-protected private link you trust.',
    );
    lastFallbackReason = `refused public resolver URL: ${clean}`;
    return null;
  }
  return { url: clean, token };
}

/** True for addresses that only make sense on a private network. */
export function isPrivateResolverUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1') return true;
  if (host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.lan')) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
  // Carrier-grade NAT, which is what most WireGuard/Tailscale setups land in.
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(host)) return true;
  return false;
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
