/** Round-robin source discovery across two to four remote resolvers. */
import type { PlaybackRequest, PlaybackResolution, PlaybackResolver } from './playback-resolver.js';
import { RemotePlaybackResolver, ResolverUnavailableError } from './playback-resolver-remote.js';

const TOTAL_BUDGET_MS = 12_000; // The player waits 15 seconds.
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_CONFIRMATIONS = 2;
const PLAYBACK_FAILURE_THRESHOLD = 2;

function titleHash(request: PlaybackRequest): number {
  const key = `${request.type}:${request.tmdbId}:${request.season ?? ''}:${request.episode ?? ''}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type Node = {
  client: RemotePlaybackResolver;
  available: boolean;
  generation: number;
  goodChecks: number;
  badChecks: number;
  consecutiveFailures: number;
  inFlight: number;
  attempts: number;
  failures: number;
  lastSuccess: number;
};

/**
 * Only authenticated health checks, never playback, are sent to a node marked
 * unavailable. Healthy nodes share requests round-robin; ping time is not a
 * load-balancing signal and no per-node concurrency limit is imposed.
 */
export function createBalancedPlaybackResolver(
  first: RemotePlaybackResolver,
  second: RemotePlaybackResolver,
  options: { additionalClients?: RemotePlaybackResolver[]; healthIntervalMs?: number; budgetMs?: number; log?: (line: string) => void } = {},
): PlaybackResolver {
  const interval = Math.max(10, options.healthIntervalMs ?? HEALTH_INTERVAL_MS);
  const budget = Math.max(1, options.budgetMs ?? TOTAL_BUDGET_MS);
  const log = options.log ?? console.warn;
  const nodes: Node[] = [first, second, ...(options.additionalClients ?? [])].map(client => ({
    client, available: true, generation: 0, goodChecks: 0, badChecks: 0,
    consecutiveFailures: 0, inFlight: 0, attempts: 0, failures: 0, lastSuccess: 0,
  }));
  const affinity = new Map<string, { node: Node; expires: number }>();
  const remember = (key: string, node: Node) => {
    affinity.delete(key);
    affinity.set(key, { node, expires: Date.now() + 60_000 });
    while (affinity.size > 2048) affinity.delete(affinity.keys().next().value!);
  };
  let turn = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const markUnavailable = (node: Node, detail: string) => {
    if (!node.available) return;
    node.available = false;
    node.generation++;
    node.goodChecks = 0;
    node.badChecks = 0;
    log(`[elfura-resolver] ${node.client.label} unavailable (${detail}); playback paused, health checks continue`);
  };
  const checkNode = async (node: Node) => {
    const generation = node.generation;
    // Both endpoints are lightweight; /sources also checks the shared token.
    // Health alone can succeed while a proxy rejects the authenticated API.
    const [health, auth] = await Promise.all([
      node.client.probe().catch(() => ({ reachable: false, detail: 'health check failed' })),
      node.client.authProbe().catch(() => ({ authenticated: false, detail: 'authenticated health check failed' })),
    ]);
    if (stopped || generation !== node.generation) return; // discard stale checks
    if (health.reachable && auth.authenticated) {
      node.badChecks = 0;
      if (!node.available && ++node.goodChecks >= HEALTH_CONFIRMATIONS) {
        node.available = true;
        node.generation++;
        node.goodChecks = 0;
        node.consecutiveFailures = 0;
        log(`[elfura-resolver] ${node.client.label} answering health checks again; playback resumed`);
      }
    } else {
      node.goodChecks = 0;
      if (node.available && ++node.badChecks >= HEALTH_CONFIRMATIONS) {
        markUnavailable(node, !health.reachable ? 'health check failed' : auth.detail);
      }
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void Promise.all(nodes.map(node => checkNode(node).catch(() => {
        // Remote clients normally return a failed probe instead of throwing.
        // An unexpected error must not create an unhandled rejection.
        if (node.available && ++node.badChecks >= HEALTH_CONFIRMATIONS) markUnavailable(node, 'health check failed');
      }))).finally(schedule);
    }, interval);
    timer.unref();
  };
  log('[elfura-resolver] periodic health checks enabled; no speculative hedges');
  schedule();

  return {
    kind: 'remote',
    label: `balanced (${nodes.map(node => node.client.label).join(', ')})`,
    close() { stopped = true; if (timer) clearTimeout(timer); },
    async resolve(request: PlaybackRequest): Promise<PlaybackResolution | null> {
      const key = request.lateAffinityKey?.slice(0, 256);
      // Both late joins and single-source enrichment should reuse the node
      // running this viewer's original discovery. Otherwise each recovery can
      // start the same provider work again on a different resolver and miss the
      // first node's in-flight results and per-node cache.
      let pinned = (request.late || request.sourceId) && key ? affinity.get(key) : undefined;
      if (pinned && pinned.expires <= Date.now()) { affinity.delete(key!); pinned = undefined; }
      const available = nodes.filter(node => node.available);
      if (!available.length) throw new ResolverUnavailableError('no resolver is currently available');
      let order: Node[];
      if (pinned && pinned.node.available) {
        const rest = available.filter(n => n !== pinned!.node);
        order = [pinned.node, ...rest];
      } else {
        const primaryIdx = titleHash(request) % available.length;
        const primaryNode = available[primaryIdx];
        const tieStart = turn++ % available.length;
        order = available
          .map((node, i) => {
            // Prefer the title's stable hash owner when idle, but don't pile
            // concurrent discoveries onto it. RTT must not bias traffic toward
            // one fast node; only current in-flight work affects this order.
            const loadScore = node.inFlight * (available.length + 1) + (node === primaryNode ? 0 : 1);
            const tie = (i - tieStart + available.length) % available.length;
            return { node, loadScore, tie };
          })
          .sort((a, b) => a.loadScore - b.loadScore || a.tie - b.tie)
          .map(x => x.node);
      }
      const deadline = Date.now() + budget;
      let lastError: unknown;
      for (const node of order) {
        // Another concurrent request or health check may have marked it down
        // since this request built its order. Never send playback to it now.
        if (!node.available) continue;
        const remaining = deadline - Date.now();
        // Don't send a healthy peer a token two-second timeout after a stalled
        // first call. The next viewer can use that peer with a full budget.
        if (remaining < budget / 2 && lastError) break;
        if (remaining <= 0) break;
        const generation = node.generation;
        const attempt = ++node.attempts;
        node.inFlight++;
        try {
          const result = await node.client.resolve(request, remaining, true);
          node.consecutiveFailures = 0;
          node.lastSuccess = Math.max(node.lastSuccess, attempt);
          if (key && !request.late && (!request.sourceId || !pinned || !pinned.node.available)) remember(key, node);
          return result; // A valid empty answer is not an outage.
        } catch (error) {
          if (!(error instanceof ResolverUnavailableError)) throw error;
          node.failures++;
          if (node.generation === generation && attempt >= node.lastSuccess && ++node.consecutiveFailures >= PLAYBACK_FAILURE_THRESHOLD) {
            markUnavailable(node, error.message);
          }
          lastError = error;
        } finally {
          node.inFlight = Math.max(0, node.inFlight - 1);
        }
      }
      throw lastError ?? new ResolverUnavailableError('no resolver is currently available');
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
          name, reachable: health.reachable, authenticated: auth.authenticated,
          detail: !health.reachable ? 'health endpoint unreachable' : auth.detail,
          attempts: node.attempts, failures: node.failures, cooldownMs: 0,
          available: node.available,
        })),
      };
    },
    async sourceStatus() {
      // Control-plane status checks are lightweight. Try only usable nodes.
      for (const node of nodes.filter(n => n.available)) {
        const status = await node.client.sourceStatus();
        if (status !== null) return status;
      }
      return null;
    },
    async setSourceEnabled(id, enabled) {
      // Report partial failure rather than sending management writes to a down node.
      const results = await Promise.all(nodes.map(n => n.available ? n.client.setSourceEnabled(id, enabled) : Promise.resolve(false)));
      return results.every(Boolean);
    },
  };
}
