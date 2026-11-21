/** Round-robin discovery across independent remote resolvers. No media relay
 * or provider work runs here. A single resolver keeps the original no-retry path. */
import type { PlaybackRequest, PlaybackResolution, PlaybackResolver } from './playback-resolver.js';
import { RemotePlaybackResolver, ResolverUnavailableError } from './playback-resolver-remote.js';

const COOLDOWN_MS = 30_000;
// Player aborts after 15 seconds. A stalled first resolver must not consume
// almost the entire budget before the other one gets a chance to answer.
const TOTAL_BUDGET_MS = 12_000;
const HEDGE_DELAY_MS = 2_500;

type Node = {
  client: RemotePlaybackResolver; retryAt: number; attempts: number; failures: number;
  slowInFlight: number; lastSuccess: number; lastFailure: number;
};

export function createBalancedPlaybackResolver(
  first: RemotePlaybackResolver,
  second: RemotePlaybackResolver,
  options: { now?: () => number; cooldownMs?: number; budgetMs?: number; hedgeDelayMs?: number; log?: (line: string) => void; additionalClients?: RemotePlaybackResolver[] } = {},
): PlaybackResolver {
  const now = options.now ?? Date.now;
  const cooldown = options.cooldownMs ?? COOLDOWN_MS;
  const budget = Math.max(1, options.budgetMs ?? TOTAL_BUDGET_MS);
  const hedgeDelay = Math.max(0, Math.min(options.hedgeDelayMs ?? HEDGE_DELAY_MS, budget / 4));
  const log = options.log ?? console.warn;
  const nodes: Node[] = [first, second, ...(options.additionalClients ?? [])].map(client => ({ client, retryAt: 0, attempts: 0, failures: 0, slowInFlight: 0, lastSuccess: 0, lastFailure: 0 }));
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
    label: `balanced (${nodes.map(node => node.client.label).join(', ')})`,
    async resolve(request: PlaybackRequest): Promise<PlaybackResolution | null> {
      const current = now();
      const key = request.lateAffinityKey?.slice(0, 256);
      let pinned = request.late && key ? affinity.get(key) : undefined;
      if (pinned && pinned.expires <= current) { affinity.delete(key!); pinned = undefined; }
      const preferred = pinned ? nodes.indexOf(pinned.node) : turn++ % nodes.length;
      const order = nodes.map((_, i) => nodes[(preferred + i) % nodes.length]);
      // Prefer a node that is not cooling down or already holding a stalled
      // request. Keep the other as a last resort even if both are in cooldown:
      // it may have recovered since its last failed request.
      order.sort((a, b) =>
        Number(a.retryAt > current) - Number(b.retryAt > current) ||
        (pinned ? Number(a !== pinned.node) - Number(b !== pinned.node) : 0) ||
        Number(a.slowInFlight > 0) - Number(b.slowInFlight > 0) ||
        (a.retryAt > current && b.retryAt > current ? a.retryAt - b.retryAt : 0),
      );
      const deadline = Date.now() + budget;
      return new Promise<PlaybackResolution | null>((resolve, reject) => {
        let settled = false;
        let started = 0;
        let finished = 0;
        let hadAnswer = false;
        let next = 0;
        let lastError: unknown;
        let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
        let slowNode: Node | undefined;
        // A late request belongs to its original resolver's in-memory stash.
        // A peer response is only useful if that owner fails, not if it is
        // merely slower than the peer's unrelated (often empty) late result.
        const pinnedOwner = pinned && order[0] === pinned.node ? pinned.node : undefined;
        let peerAnswer: { result: PlaybackResolution | null; node: Node } | undefined;
        let ownerFailed = false;

        const finish = (result: PlaybackResolution | null, node?: Node) => {
          if (settled) return;
          settled = true;
          if (hedgeTimer) clearTimeout(hedgeTimer);
          if (result && node && key && !request.late && !request.sourceId) remember(key, node);
          resolve(result);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          if (hedgeTimer) clearTimeout(hedgeTimer);
          reject(error);
        };
        const launch = (node: Node) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            if (hadAnswer) finish(null);
            else fail(lastError ?? new ResolverUnavailableError('resolver request budget exhausted'));
            return;
          }
          started++;
          let unavailable = false;
          const attempt = ++node.attempts;
          void node.client.resolve(request, remaining, true).then(result => {
            node.lastSuccess = Math.max(node.lastSuccess, attempt);
            if (attempt >= node.lastFailure) {
              if (node.retryAt) log(`[elfura-resolver] ${node.client.label} recovered`);
              node.retryAt = 0;
            }
            if (pinnedOwner && node !== pinnedOwner && !ownerFailed) {
              // Retain a useful result in preference to an empty peer answer.
              if (!peerAnswer?.result || result) peerAnswer = { result, node };
              return;
            }
            if (result) finish(result, node);
            else hadAnswer = true;
          }).catch(error => {
            if (!(error instanceof ResolverUnavailableError)) { fail(error); return; }
            unavailable = true;
            if (node === pinnedOwner) {
              ownerFailed = true;
              if (peerAnswer) {
                if (peerAnswer.result) finish(peerAnswer.result, peerAnswer.node);
                else hadAnswer = true;
              }
            }
            // A peer launched close to the shared deadline may have too little
            // time to answer. Do not declare it unhealthy on that timeout.
            const starvedTimeout = error.timedOut && remaining < budget / 2;
            if (!starvedTimeout) {
              node.failures++;
              node.lastFailure = Math.max(node.lastFailure, attempt);
              if (attempt >= node.lastSuccess) {
                node.retryAt = now() + cooldown;
                log(`[elfura-resolver] ${node.client.label} unavailable (${error.message}); skipping for ${cooldown}ms`);
              }
            } else {
              log(`[elfura-resolver] ${node.client.label} timed out with only ${remaining}ms of request budget; not marking it unavailable`);
            }
            lastError = error;
          }).finally(() => {
            finished++;
            if (slowNode === node) { node.slowInFlight--; slowNode = undefined; }
            if (settled) return;
            // Immediate failures advance to the next node without waiting for
            // the hedge timer. An ordinary empty answer is not an outage.
            if (unavailable && !hadAnswer && next < order.length) launchNext();
            if (settled || finished !== started) return;
            if (hadAnswer) finish(null);
            else if (next >= order.length) fail(lastError ?? new ResolverUnavailableError('resolver request budget exhausted'));
          });
        };
        const launchNext = () => {
          if (!settled && next < order.length) launch(order[next++]);
        };
        launchNext();
        hedgeTimer = setTimeout(() => {
          if (settled || finished === started || next >= order.length) return;
          // All remaining peers get enough of the shared budget even if two
          // nodes are blackholed. This costs at most one call per node.
          // Mark the original as slow without declaring it down; the request
          // remains alive until its real outcome or timeout.
          if (finished === 0) { slowNode = order[0]; slowNode.slowInFlight++; }
          while (!settled && next < order.length) launchNext();
        }, hedgeDelay);
      });
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
