/** Capacity-aware discovery across remote resolvers. The media node never scrapes. */
import { ResolverBusyError, type PlaybackRequest, type PlaybackResolution, type PlaybackResolver } from './playback-resolver.js';
import { RemotePlaybackResolver, ResolverUnavailableError } from './playback-resolver-remote.js';

const COOLDOWN_MS = 30_000;
const BUSY_COOLDOWN_MS = 5_000;
const TOTAL_BUDGET_MS = 12_000; // The player waits 15 seconds.
const HEDGE_DELAY_MS = 4_000;
const HEDGE_EVERY = 20; // At most one extra speculative request per 20 searches, plus one initial token.
// A hardware-independent cap is not a capacity estimate. Limits are opt-in.
const DEFAULT_MAX_INFLIGHT = 0;

type Circuit = 'closed' | 'open' | 'half-open';
type Node = {
  client: RemotePlaybackResolver;
  circuit: Circuit;
  retryAt: number;
  generation: number;
  consecutiveOpens: number;
  openReason: 'busy' | 'unavailable';
  attempts: number;
  failures: number;
  active: number;
};

function boundedInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function createBalancedPlaybackResolver(
  first: RemotePlaybackResolver,
  second: RemotePlaybackResolver,
  options: {
    now?: () => number; random?: () => number; cooldownMs?: number; busyCooldownMs?: number;
    budgetMs?: number; hedgeDelayMs?: number; hedgeEvery?: number; maxInFlight?: number;
    log?: (line: string) => void; additionalClients?: RemotePlaybackResolver[];
  } = {},
): PlaybackResolver {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const cooldown = Math.max(1, options.cooldownMs ?? COOLDOWN_MS);
  const busyCooldown = Math.max(1, options.busyCooldownMs ?? BUSY_COOLDOWN_MS);
  const budget = Math.max(1, options.budgetMs ?? TOTAL_BUDGET_MS);
  const hedgeDelay = Math.max(1, Math.min(options.hedgeDelayMs ?? HEDGE_DELAY_MS, budget / 3));
  const hedgeEvery = Math.max(1, options.hedgeEvery ?? HEDGE_EVERY);
  const maxInFlight = boundedInt(options.maxInFlight ?? process.env.ELFURA_RESOLVER_NODE_MAX_INFLIGHT, DEFAULT_MAX_INFLIGHT, 0, 1000);
  const hasCapacity = (node: Node) => maxInFlight === 0 || node.active < maxInFlight;
  const log = options.log ?? console.warn;
  const nodes: Node[] = [first, second, ...(options.additionalClients ?? [])].map(client => ({
    client, circuit: 'closed', retryAt: 0, generation: 0, consecutiveOpens: 0,
    openReason: 'unavailable', attempts: 0, failures: 0, active: 0,
  }));
  const affinity = new Map<string, { node: Node; expires: number }>();
  const remember = (key: string, node: Node) => {
    affinity.delete(key);
    affinity.set(key, { node, expires: now() + 60_000 });
    while (affinity.size > 2048) affinity.delete(affinity.keys().next().value!);
  };
  let turn = 0;
  // A tiny per-process retry budget and concurrency cap prevent a slow scan
  // from fanning out for every viewer. Tokens are spent only on hedges, not on
  // an immediate retry after a real error. At most one hedge is in flight.
  let hedgeTokens = 1;
  let hedgesInFlight = 0;

  function opened(node: Node, generation: number, error: ResolverUnavailableError | ResolverBusyError, probe: boolean) {
    if (node.generation !== generation || (probe ? node.circuit !== 'half-open' : node.circuit !== 'closed')) return;
    node.failures++;
    node.openReason = error instanceof ResolverBusyError ? 'busy' : 'unavailable';
    node.consecutiveOpens++;
    const base = node.openReason === 'busy' ? busyCooldown : cooldown;
    const backoff = Math.min(300_000, base * 2 ** Math.min(node.consecutiveOpens - 1, 10));
    const delay = Math.max(1, Math.round(backoff * (0.8 + Math.max(0, Math.min(1, random())) * 0.4)));
    node.retryAt = now() + delay;
    node.circuit = 'open';
    node.generation++;
    log(`[elfura-resolver] ${node.client.label} ${node.openReason} (${error.message}); circuit open for ${delay}ms`);
  }

  function answered(node: Node, generation: number, probe: boolean) {
    if (node.generation !== generation) return;
    if (probe && node.circuit === 'half-open') {
      node.circuit = 'closed'; node.retryAt = 0; node.consecutiveOpens = 0;
      log(`[elfura-resolver] ${node.client.label} recovered; circuit closed`);
    } else if (!probe && node.circuit === 'closed') {
      node.consecutiveOpens = 0;
    }
  }

  return {
    kind: 'remote',
    label: `balanced (${nodes.map(node => node.client.label).join(', ')})`,
    async resolve(request: PlaybackRequest): Promise<PlaybackResolution | null> {
      const current = now();
      const key = request.lateAffinityKey?.slice(0, 256);
      let pinned = request.late && key ? affinity.get(key) : undefined;
      if (pinned && pinned.expires <= current) { affinity.delete(key!); pinned = undefined; }
      const offset = pinned ? nodes.indexOf(pinned.node) : turn++ % nodes.length;
      const order = nodes.map((_, i) => nodes[(offset + i) % nodes.length]);
      const deadline = Date.now() + budget;
      hedgeTokens = Math.min(1, hedgeTokens + 1 / hedgeEvery);

      return new Promise<PlaybackResolution | null>((resolve, reject) => {
        let settled = false;
        let inFlight = 0;
        let hadAnswer = false;
        let hitBusy = false;
        let lastError: unknown;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const attempted = new Set<Node>();
        const finish = (result: PlaybackResolution | null, node?: Node) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (result && node && key && !request.late && !request.sourceId) remember(key, node);
          resolve(result);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(error);
        };
        const pick = (allowProbe: boolean): Node | undefined => {
          const t = now();
          // Only one actual playback request may test an expired open circuit.
          // Late stash affinity wins when its owner is healthy.
          if (pinned && !attempted.has(pinned.node) && pinned.node.circuit === 'closed' && hasCapacity(pinned.node)) return pinned.node;
          if (allowProbe) {
            const candidate = order.find(n => !attempted.has(n) && n.circuit === 'open' && n.retryAt <= t && n.active === 0);
            if (candidate) return candidate;
          }
          return order.filter(n => !attempted.has(n) && n.circuit === 'closed' && hasCapacity(n))
            .sort((a, b) => a.active - b.active)[0];
        };
        const unavailable = () => {
          if (hitBusy || nodes.some(n => n.circuit === 'half-open' || (n.circuit === 'closed' && !hasCapacity(n)) || (n.circuit === 'open' && n.openReason === 'busy'))) {
            return new ResolverBusyError();
          }
          return lastError ?? new ResolverUnavailableError('all resolver circuits are open');
        };
        const launch = (node: Node, hedge = false) => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) { fail(lastError ?? new ResolverUnavailableError('resolver request budget exhausted')); return; }
          const probe = node.circuit === 'open';
          if (probe) node.circuit = 'half-open';
          const generation = node.generation;
          attempted.add(node);
          node.active++; node.attempts++; inFlight++;
          if (hedge) hedgesInFlight++;
          void (async () => {
            let result: PlaybackResolution | null = null;
            let gotAnswer = false;
            let unexpected: unknown;
            try {
              result = await node.client.resolve(request, remaining, true);
              answered(node, generation, probe);
              gotAnswer = true;
            } catch (error) {
              if (!(error instanceof ResolverUnavailableError) && !(error instanceof ResolverBusyError)) unexpected = error;
              else {
                if (error instanceof ResolverBusyError) hitBusy = true;
                // A timeout with an unfairly short remaining request budget is
                // not evidence the peer is down.
                if (!(error instanceof ResolverUnavailableError && error.timedOut && remaining < budget / 2)) opened(node, generation, error, probe);
                else if (probe && node.generation === generation && node.circuit === 'half-open') node.circuit = 'open';
                lastError = error;
              }
            } finally {
              node.active--; inFlight--;
              if (hedge) hedgesInFlight--;
            }
            if (settled) return;
            if (unexpected) { fail(unexpected); return; }
            if (gotAnswer) {
              if (result) { finish(result, node); return; }
              hadAnswer = true;
            }
            if (inFlight > 0) return;
            if (hadAnswer) { finish(null); return; }
            // A fast failure may try another node, but never an open circuit
            // before its single allowed recovery trial is due.
            const next = pick(true);
            if (next && deadline - Date.now() >= budget / 2) launch(next);
            else fail(unavailable());
          })();
        };
        // A saturated stash owner is not a missing stash. Do not misroute a
        // late pass to another node just because the owner is at capacity.
        if (pinned && pinned.node.circuit === 'closed' && !hasCapacity(pinned.node)) {
          fail(new ResolverBusyError());
          return;
        }
        const firstNode = pick(true);
        if (!firstNode) { fail(unavailable()); return; }
        launch(firstNode);
        if (!request.late) timer = setTimeout(() => {
          if (settled || inFlight !== 1 || hedgeTokens < 1 || hedgesInFlight >= 1) return;
          // Hedge only to another CLOSED node with spare capacity. Never use a
          // recovery probe as a speculative request, or fan out to all peers.
          const peer = pick(false);
          if (!peer) return;
          hedgeTokens -= 1;
          launch(peer, true);
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
          name, reachable: health.reachable, authenticated: auth.authenticated,
          detail: !health.reachable ? 'health endpoint unreachable' : auth.detail,
          attempts: node.attempts, failures: node.failures,
          cooldownMs: Math.max(0, node.retryAt - now()),
          circuit: node.circuit, active: node.active, maxInFlight,
        })),
      };
    },
    async sourceStatus() {
      for (const node of nodes) {
        const status = await node.client.sourceStatus();
        if (status !== null) return status;
      }
      return null;
    },
    async setSourceEnabled(id, enabled) {
      const results = await Promise.all(nodes.map(n => n.client.setSourceEnabled(id, enabled)));
      return results.every(Boolean);
    },
  };
}
