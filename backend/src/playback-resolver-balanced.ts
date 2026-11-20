/** Round-robin discovery across two independent remote resolvers. No media relay
 * or provider work runs here. A single resolver keeps the original no-retry path. */
import type { PlaybackRequest, PlaybackResolution, PlaybackResolver } from './playback-resolver.js';
import { RemotePlaybackResolver, ResolverUnavailableError } from './playback-resolver-remote.js';

const COOLDOWN_MS = 30_000;
// Player aborts after 15 seconds. A single overall budget prevents two slow
// resolver attempts from doubling that timeout. Fast failures leave more time
// for the second attempt; a slow first attempt may leave too little to succeed.
const TOTAL_BUDGET_MS = 12_000;

type Node = { client: RemotePlaybackResolver; retryAt: number };

export function createBalancedPlaybackResolver(
  first: RemotePlaybackResolver,
  second: RemotePlaybackResolver,
  options: { now?: () => number; cooldownMs?: number; budgetMs?: number; log?: (line: string) => void } = {},
): PlaybackResolver {
  const now = options.now ?? Date.now;
  const cooldown = options.cooldownMs ?? COOLDOWN_MS;
  const budget = options.budgetMs ?? TOTAL_BUDGET_MS;
  const log = options.log ?? console.warn;
  const nodes: Node[] = [{ client: first, retryAt: 0 }, { client: second, retryAt: 0 }];
  let turn = 0;

  return {
    kind: 'remote',
    label: `balanced (${first.label}, ${second.label})`,
    async resolve(request: PlaybackRequest): Promise<PlaybackResolution | null> {
      const preferred = turn++ % nodes.length;
      const current = now();
      let order = [nodes[preferred], nodes[1 - preferred]].filter(n => n.retryAt <= current);
      // If both are in cooldown, try the one due first rather than going dark.
      if (order.length === 0) order = [...nodes].sort((a, b) => a.retryAt - b.retryAt).slice(0, 1);
      const deadline = now() + budget;
      let lastError: unknown;
      for (const node of order) {
        const remaining = deadline - now();
        if (remaining <= 0) break;
        try {
          const result = await node.client.resolve(request, remaining);
          if (node.retryAt) log(`[elfura-resolver] ${node.client.label} recovered`);
          node.retryAt = 0;
          // An empty result or a rejected request is an answer, not an outage.
          return result;
        } catch (error) {
          if (!(error instanceof ResolverUnavailableError)) throw error;
          node.retryAt = now() + cooldown;
          lastError = error;
          log(`[elfura-resolver] ${node.client.label} unavailable; skipping for ${cooldown}ms`);
        }
      }
      throw lastError ?? new ResolverUnavailableError('resolver request budget exhausted');
    },
    async probe() {
      const results = await Promise.all(nodes.map(async n => ({ node: n, result: await n.client.probe() })));
      const live = results.filter(x => x.result.reachable);
      return {
        reachable: live.length > 0,
        detail: `resolver pool: ${live.length}/${nodes.length} reachable`,
        ...(live[0]?.result.sources ? { sources: live[0].result.sources } : {}),
      };
    },
    async sourceStatus() {
      // These counters are per resolver, not cluster-wide; use the first that
      // answers and keep switching independent from the playback round robin.
      for (const node of nodes) {
        const status = await node.client.sourceStatus();
        if (status !== null) return status;
      }
      return null;
    },
    async setSourceEnabled(id, enabled) {
      // The resolver processes do not share their operator switches. Broadcast
      // and report partial failure rather than pretend both changed.
      const results = await Promise.all(nodes.map(n => n.client.setSourceEnabled(id, enabled)));
      return results.every(Boolean);
    },
  };
}
