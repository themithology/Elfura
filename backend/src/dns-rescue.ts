/**
 * DNS rescue.
 *
 * A Pterodactyl container resolves names through Docker's embedded DNS at
 * 127.0.0.11, which forwards to whatever the host uses. When that path stops
 * answering, every upstream hostname hangs until the libc resolver gives up:
 * adapters time out one after another, the site reports no sources for every
 * title, and anything that still works (a warm keep-alive socket, a cached
 * metadata response) is a red herring. Nothing in the adapter code can fix it,
 * because the failure happens before a single byte leaves the process.
 *
 * Node cannot be told "use these resolvers" for `fetch` — undici opens sockets
 * through `net.Socket#connect`, which uses the system resolver with no hook. But
 * c-ares (`dns.Resolver` with explicit servers) speaks to DNS servers directly and
 * does not touch 127.0.0.11 at all. So: test the system resolver once at boot, and
 * if it does not answer, route hostname lookups for outgoing sockets through the
 * configured public resolvers instead. Everything above the socket — fetch, TLS,
 * SNI, the adapters — stays exactly as it is.
 *
 * Off switch: ELFURA_DNS_RESCUE=0. Resolvers: ELFURA_DNS_SERVERS (default
 * 1.1.1.1,8.8.8.8). Force the patch even when the system resolver answers:
 * ELFURA_DNS_RESCUE=always (useful for testing).
 */
import dns from 'node:dns';

const CACHE_TTL_MS = 5 * 60_000;
const QUERY_TIMEOUT_MS = 2_500;

type CacheRow = { v4: string[]; v6: string[]; expiresAt: number };
const cache = new Map<string, CacheRow>();

const servers = (): string[] =>
  (process.env.ELFURA_DNS_SERVERS ?? '1.1.1.1,8.8.8.8')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

function makeResolver(): dns.Resolver {
  const resolver = new dns.Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 2 });
  try {
    resolver.setServers(servers());
  } catch {
    /* keep the default servers if the list is unusable */
  }
  return resolver;
}

const resolveFamily = (resolver: dns.Resolver, method: 'resolve4' | 'resolve6', host: string): Promise<string[]> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), QUERY_TIMEOUT_MS);
    try {
      resolver[method](host, (err, addresses) => {
        clearTimeout(timer);
        resolve(err ? [] : (addresses as string[]));
      });
    } catch {
      clearTimeout(timer);
      resolve([]);
    }
  });

/**
 * DNS over HTTPS. UDP/53 to a public resolver is not always allowed out of a
 * container, but port 443 generally is — and 1.1.1.1 answers DoH on an address
 * that needs no lookup to connect to, so this works even when nothing resolves.
 */
async function dohQuery(host: string, type: 'A' | 'AAAA'): Promise<string[]> {
  try {
    const res = await fetch(
      `https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(3_500) },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { Answer?: { data?: string; type?: number }[] };
    const wanted = type === 'A' ? 1 : 28;
    return (body.Answer ?? [])
      .filter((row) => row.type === wanted && typeof row.data === 'string')
      .map((row) => String(row.data));
  } catch {
    return [];
  }
}

async function resolveHost(host: string): Promise<{ v4: string[]; v6: string[] }> {
  const hit = cache.get(host);
  if (hit && hit.expiresAt > Date.now()) return hit;
  const resolver = makeResolver();
  const [first4, first6] = await Promise.all([
    resolveFamily(resolver, 'resolve4', host),
    resolveFamily(resolver, 'resolve6', host),
  ]);
  // Fall back to DoH when the plain-DNS path is blocked rather than wrong.
  const [v4, v6] =
    first4.length || first6.length
      ? [first4, first6]
      : await Promise.all([dohQuery(host, 'A'), dohQuery(host, 'AAAA')]);
  // Cache successes for a while; retry failures on the next connection rather
  // than remembering an outage.
  if (v4.length || v6.length) cache.set(host, { v4, v6, expiresAt: Date.now() + CACHE_TTL_MS });
  return { v4, v6 };
}

type LookupOptions = { family?: number; all?: boolean; hints?: number };
type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | { address: string; family: number }[], family?: number) => void;

function rescuedLookup(hostname: string, options: LookupOptions | LookupCallback, callback?: LookupCallback): void {
  const opts: LookupOptions = typeof options === 'function' ? {} : (options ?? {});
  const done: LookupCallback = typeof options === 'function' ? options : (callback as LookupCallback);

  resolveHost(hostname).then(({ v4, v6 }) => {
    const wanted = opts.family === 6 ? v6 : opts.family === 4 ? v4 : [...v4, ...v6];
    if (!wanted.length) {
      const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      done(err);
      return;
    }
    if (opts.all) {
      done(null, wanted.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
      return;
    }
    const address = wanted[0];
    done(null, address, address.includes(':') ? 6 : 4);
  });
}

/** Is the system resolver answering at all? One lookup, hard ceiling. */
async function systemResolverAnswers(): Promise<boolean> {
  const probe = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2_000);
    dns.lookup('one.one.one.one', (err) => {
      clearTimeout(timer);
      resolve(!err);
    });
  });
  return probe;
}

/**
 * Turn whatever a caller passed to fetch into (url, init) that another fetch can
 * accept: adapters build `new Request(...)` objects and pass those directly, and a
 * Request from one implementation is not accepted by the other.
 */
function normalizeFetchInput(input: unknown, init?: unknown): { url: string; init: Record<string, unknown> } {
  const merged: Record<string, unknown> = { ...(init as Record<string, unknown> | undefined) };
  if (typeof input === 'string') return { url: input, init: merged };
  if (input instanceof URL) return { url: input.href, init: merged };

  const request = input as {
    url?: string;
    method?: string;
    headers?: unknown;
    body?: unknown;
    signal?: unknown;
    redirect?: string;
    mode?: string;
    credentials?: string;
    cache?: string;
    referrer?: string;
    integrity?: string;
  };
  if (request && typeof request.url === 'string') {
    const url = request.url;
    if (merged.method === undefined && request.method) merged.method = request.method;
    if (merged.headers === undefined && request.headers) merged.headers = request.headers;
    if (merged.body === undefined && request.body) merged.body = request.body;
    if (merged.signal === undefined && request.signal) merged.signal = request.signal;
    if (merged.redirect === undefined && request.redirect) merged.redirect = request.redirect;
    // Another implementation's body is a stream; undici requires this flag.
    if (merged.body && typeof merged.body === 'object' && merged.duplex === undefined) merged.duplex = 'half';
    return { url, init: merged };
  }
  return { url: String(input), init: merged };
}

let installed = false;

/**
 * Installs the patch when it is needed (or when forced) and reports what it did.
 * Safe to call once at boot; every later call is a no-op.
 */
export async function installDnsRescue(log: (line: string) => void = console.log): Promise<boolean> {
  if (installed) return true;
  const mode = (process.env.ELFURA_DNS_RESCUE ?? 'auto').toLowerCase();
  if (mode === '0' || mode === 'off' || mode === 'false') {
    log('[elfura-dns] rescue disabled by ELFURA_DNS_RESCUE');
    return false;
  }

  let needed = mode === 'always' || mode === '1';
  if (!needed) {
    needed = !(await systemResolverAnswers());
    if (!needed) {
      log(`[elfura-dns] system resolver answers; leaving name resolution alone`);
      return false;
    }
    log('[elfura-dns] system resolver is not answering — testing public resolvers');
  }

  // Prove the public resolvers work before taking over lookups: a broken patch
  // would be worse than the thing it replaces.
  const proof = await resolveHost('api.themoviedb.org');
  if (!proof.v4.length && !proof.v6.length) {
    log(
      `[elfura-dns] neither UDP/53 to ${servers().join(', ')} nor DNS-over-HTTPS answered — ` +
        `nothing to rescue with; fix this container's resolver instead`,
    );
    return false;
  }

  // Node's bundled fetch gives no hook for the resolver: patching dns.lookup,
  // net.connect or the global dispatcher symbol all leave it resolving through
  // the system. The supported seam is undici's own fetch with an Agent whose
  // `connect.lookup` is ours, so that is what gets installed — only here, only
  // after the system resolver has been proven dead and the public ones proven
  // alive, and only when an Agent can actually be built.
  const undici = await import('undici').catch(() => null);
  if (!undici) {
    log('[elfura-dns] undici is not installed, so lookups cannot be rescued; fix this container\'s resolver');
    return false;
  }

  const agent = new undici.Agent({
    connect: { lookup: rescuedLookup as unknown as (hostname: string) => never },
    keepAliveTimeout: 10_000,
  });
  undici.setGlobalDispatcher(agent);
  const rescuedFetch = (async (input: unknown, init?: unknown) => {
    const normalized = normalizeFetchInput(input, init);
    return undici.fetch(normalized.url, normalized.init as never);
  }) as typeof fetch;
  globalThis.fetch = rescuedFetch;

  installed = true;
  log(
    `[elfura-dns] outgoing hostname lookups now use ${servers().join(', ')} ` +
      `(proved with api.themoviedb.org -> ${proof.v4[0] ?? proof.v6[0]})`,
  );
  return true;
}

/** Test hook: resolve through the rescue path without patching anything. */
export async function rescueResolve(host: string): Promise<{ v4: string[]; v6: string[] }> {
  return resolveHost(host);
}
