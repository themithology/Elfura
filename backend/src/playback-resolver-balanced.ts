/** Round-robin discovery across two independent remote resolvers. No media relay
 * or provider work runs here. A single resolver keeps the original no-retry path. */
import type { PlaybackRequest, PlaybackResolution, PlaybackResolver } from './playback-resolver.js';
import { RemotePlaybackResolver, ResolverUnavailableError } from './playback-resolver-remote.js';

const COOLDOWN_MS = 30_000;
// Player aborts after 15 seconds. A single overall budget prevents two slow
// resolver attempts from doubling that timeout. Fast failures leave more time
// for the second attempt; a slow first attempt may leave too little to succeed.
const TOTAL_BUDGET_MS = 12_000;

type Node = { client: RemotePlaybackResolver; retryAt: number; attempts: number; failures: number };

export function createBalancedPlaybackResolver(
  first: RemotePlaybackResolver,
  second: RemotePlaybackResolver,
  options: { now?: () => number; cooldownMs?: number; budgetMs?: number; log?: (line: string) => void } = {},
): PlaybackResolver {
  const now = options.now ?? Date.now;
  const cooldown = options.cooldownMs ?? COOLDOWN_MS;
  const budget = options.budgetMs ?? TOTAL_BUDGET_MS;
  const log = options.log ?? console.warn;
  const nodes: Node[] = [first, second].map(client => ({ client, retryAt: 0, attempts: 0, failures: 0 }));
  // Late results live only on the resolver that did the initial discovery.
  // Bound and expire the media-node routing hints; no candidates or tokens are
  // stored here, and ordinary discovery stays round-robin.
  const affinity = new Map<string, { node: Node; expires: number }>();
  const remember = (key: string, node: Node) => {
    affinity.delete(key);
    affinity.set(key, { node, expires: now() + 60_000 });
    while (affinity.size > 2048) affinity.delete(affinity.keys().next().value!);
  };
  let turn = 0;

  return {
    kind: 'remote',
    label: `balanced (${first.label}, ${second.label})`,
    async resolve(request: PlaybackRequest): Promise<PlaybackResolution | null> {
      const current = now();
      const key = request.lateAffinityKey?.slice(0, 256);
      let pinned = request.late && key ? affinity.get(key) : undefined;
      if (pinned && pinned.expires <= current) { affinity.delete(key!); pinned = undefined; }
      const preferred = pinned ? nodes.indexOf(pinned.node) : turn++ % nodes.length;
      let order = [nodes[preferred], nodes[1 - preferred]].filter(n => n.retryAt <= current);
      // If both are in cooldown, try the one due first rather than going dark.
      if (order.length === 0) order = [...nodes].sort((a, b) => a.retryAt - b.retryAt).slice(0, 1);
      const deadline = now() + budget;
      let lastError: unknown;
      for (const node of order) {
        const remaining = deadline - now();
        if (remaining <= 0) break;
        try {
          node.attempts++;
          const result = await node.client.resolve(request, remaining, true);
          if (node.retryAt) log(`[elfura-resolver] ${node.client.label} recovered`);
          node.retryAt = 0;
          if (result && key && !request.late && !request.sourceId) remember(key, node);
          // An empty result or a rejected request is an answer, not an outage.
          return result;
        } catch (error) {
          if (!(error instanceof ResolverUnavailableError)) throw error;
          node.failures++;
          node.retryAt = now() + cooldown;
          lastError = error;
          log(`[elfura-resolver] ${node.client.label} unavailable (${error.message}); skipping for ${cooldown}ms`);
        }
      }
      throw lastError ?? new ResolverUnavailableError('resolver request budget exhausted');
    },
    async probe() {
      const results = await Promise.all(nodes.map(async (node, i) => {
        const [health, auth] = await Promise.all([node.client.probe(), node.client.authProbe()]);
        return { node, health, auth, name: `Resolver ${i + 1}` };
      }));
      const usable = results.filter(x => x.health.reachable && x.auth.authenticated);
      return {
        reachable: usable.length > 0,
        detail: `resolver pool: ${usable.length}/${nodes.length} reachable and authenticated`,
        ...(usable[0]?.health.sources ? { sources: usable[0].health.sources } : {}),
        nodes: results.map(({ node, health, auth, name }) => ({
          name,
          reachable: health.reachable,
          authenticated: auth.authenticated,
          detail: !health.reachable ? 'health endpoint unreachable' : auth.detail,
          attempts: node.attempts,
          failures: node.failures,
          cooldownMs: Math.max(0, node.retryAt - now()),
        })),
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
