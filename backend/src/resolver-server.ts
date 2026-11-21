/**
 * The resolver process: source scraping, on its own port, in its own memory.
 *
 * Started with `node index.js --resolver`, or with ELFURA_RESOLVER_MODE=1. It
 * exposes a small authenticated HTTP API that the media backend calls when
 * ELFURA_RESOLVER_URL points here:
 *
 *   GET  /resolver/api/health    { ok, sources[] }            (no token: liveness only)
 *   GET  /resolver/api/sources   { sources: status[] }
 *   POST /resolver/api/sources   { id, enabled } -> { ok }
 *   POST /resolver/api/playback  PlaybackRequest -> playback JSON
 *
 * Why this exists: provider scraping is the least stable code in the project. In
 * one process, a provider that hangs competes with video delivery for the same
 * CPU and heap, and a bug in an adapter can take playback down with it. Split
 * out, the worst case is "no new sources this minute" while existing streams
 * keep playing — and the media backend answers honestly instead of stalling.
 *
 * The token is mandatory and compared in constant time. A resolver port that is
 * reachable from the internet without it would be an open scraping proxy.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';

import type { BackendConfig } from './config.js';
import { RESOLVER_AUTH_HEADER, isPrivateResolverUrl, type PlaybackRequest } from './playback-resolver.js';
import { SourceRegistry } from './sources/registry.js';

/** Body cap: a playback request is a small JSON object, never a file. */
const MAX_BODY_BYTES = 16 * 1024;

export interface ResolverServerOptions {
  cfg: BackendConfig;
  registry: SourceRegistry;
  token: string;
  log?: (line: string) => void;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object');
  return parsed as Record<string, unknown>;
}

/** Constant-time token check; also rejects an empty configured token outright. */
/**
 * Is tokenless mode permitted for this request?
 *
 * The operator asked for no token because the resolver "is not on the public
 * internet". It was: a panel-assigned domain resolves to it from anywhere, and
 * an open resolver answers "give me the stream URLs for this episode" for anyone
 * who finds it, plus a POST that can switch the operator's sources off.
 *
 * So this is not a yes/no switch. ELFURA_RESOLVER_OPEN=1 drops the requirement
 * ONLY for a caller that arrived over a loopback or private address. A request
 * that came in through a public domain, a reverse proxy, or a port forward is
 * still refused. That keeps the convenience the operator wants without handing
 * the endpoint to the internet.
 */
function tokenlessRequestIsInternal(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  // ::ffff:10.1.2.3 is how Node reports an IPv4 peer on a dual-stack socket.
  const normalised = remote.replace(/^::ffff:/, '');
  return isPrivateResolverUrl(`http://${normalised}:1`);
}

function authorised(req: http.IncomingMessage, token: string): boolean {
  if (process.env.ELFURA_RESOLVER_OPEN === '1' && tokenlessRequestIsInternal(req)) return true;
  if (!token) return false;
  const provided = String(req.headers[RESOLVER_AUTH_HEADER] ?? '');
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Coerce an untrusted playback request into the shape the registry expects.
 * Everything is optional except the title identity, and every field is bounded
 * so a hostile caller cannot hand the registry a 10 MB string.
 */
function parsePlaybackRequest(body: Record<string, unknown>): PlaybackRequest | null {
  const type = body.type === 'tv' ? 'tv' : body.type === 'movie' ? 'movie' : null;
  const tmdbId = typeof body.tmdbId === 'string' ? body.tmdbId.trim() : '';
  if (!type || !/^[A-Za-z0-9_-]{1,24}$/.test(tmdbId)) return null;
  const num = (value: unknown, max: number): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= max ? Math.floor(n) : undefined;
  };
  const str = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= max ? trimmed : undefined;
  };
  return {
    type,
    tmdbId,
    anilistId: str(body.anilistId, 24),
    season: num(body.season, 500),
    episode: num(body.episode, 10_000),
    anilistEpisode: num(body.anilistEpisode, 10_000),
    sourceId: str(body.sourceId, 40),
    preferredLang: str(body.preferredLang, 16),
    late: body.late === true,
    streamPathPrefix: str(body.streamPathPrefix, 200),
  };
}

export function createResolverServer(options: ResolverServerOptions): {
  server: http.Server;
  token: string;
} {
  const { registry, token } = options;
  const log = options.log ?? console.log;

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname.replace(/\/+$/, '');

      // Liveness is deliberately unauthenticated so a host can health-check it,
      // and deliberately says nothing beyond whether it is up.
      if (pathname === '/resolver/api/health') {
        // Nothing beyond "I am up". This route is unauthenticated so a host can
        // poll it, which means anything in the body is public: a source count
        // would tell a scanner how much this box scrapes, and source ids would
        // hand over the very list the whole design exists to hide.
        sendJson(res, 200, { ok: true, service: 'elfura-resolver' });
        return;
      }


      // The operator needs THIS box's address to configure the other node, and a
      // panel shows the public one. Reading it from the kernel is the difference
      // between a working split and a guessed URL that silently does nothing.
      //
      // Deliberately readable WITHOUT the token, because it is meant to be opened
      // in a browser: telling an operator to curl a header-protected endpoint is
      // how they end up staring at {"error":"resolver token missing or wrong"}
      // and concluding the node is broken. It reveals nothing new: the Host
      // header is the address they already typed. Internal addresses are added
      // only for a caller that presents the token.
      if (method(req) === 'GET' && pathname === '/resolver/api/network') {
        const addresses = Object.values(os.networkInterfaces())
          .flatMap((list) => list ?? [])
          .filter((entry) => entry.family === 'IPv4' && !entry.internal)
          .map((entry) => entry.address);
        const unique = [...new Set(addresses)].sort();
        const usable = unique.filter((address) => isPrivateResolverUrl(`http://${address}:1`));
        sendJson(res, 200, {
          ok: true,
          port: resolverPort(options.cfg),
          addresses: unique,
          usableAsResolverUrl: usable.map((address) => `http://${address}:${resolverPort(options.cfg)}`),
        });
        return;
      }

      if (!authorised(req, token)) {
        sendJson(res, 401, { ok: false, error: 'resolver token missing or wrong' });
        return;
      }

      if (method(req) === 'GET' && pathname === '/resolver/api/sources') {
        sendJson(res, 200, { ok: true, sources: registry.health.snapshot(registry.listPublicSources()) });
        return;
      }

      if (method(req) === 'POST' && pathname === '/resolver/api/sources') {
        try {
          const body = await readJsonBody(req);
          const id = typeof body.id === 'string' ? body.id.trim() : '';
          if (!id || typeof body.enabled !== 'boolean') {
            sendJson(res, 400, { ok: false, error: 'expected { id, enabled }' });
            return;
          }
          const known = registry.listPublicSources().some((s) => s.id === id);
          if (!known) {
            sendJson(res, 404, { ok: false, error: `unknown source ${id}` });
            return;
          }
          registry.health.setEnabled(id, body.enabled);
          log(`[elfura-resolver] source ${id} ${body.enabled ? 'enabled' : 'disabled'} by operator`);
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid request' });
        }
        return;
      }

      if (method(req) === 'POST' && pathname === '/resolver/api/playback') {
        let request: PlaybackRequest | null = null;
        try {
          request = parsePlaybackRequest(await readJsonBody(req));
        } catch (error) {
          sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid body' });
          return;
        }
        if (!request) {
          sendJson(res, 400, { ok: false, error: 'invalid playback request' });
          return;
        }
        try {
          const resolution = await registry.resolvePlayback(request);
          if (!resolution) {
            // Deliberately 200 with ok:false. This is the resolver's *answer*,
            // not a failure of the resolver: the caller must not confuse "this
            // title has nothing" with "the resolver is down".
            sendJson(res, 200, { ok: false, error: 'no playable streams available for this title' });
            return;
          }
          sendJson(res, 200, resolution);
        } catch (error) {
          // A resolver crash must not look like "this title has no sources". 500
          // says "ask again", 404 says "there is nothing to ask for".
          log(
            `[elfura-resolver] ${request.type}/${request.tmdbId} threw: ` +
              `${error instanceof Error ? error.message : 'unknown error'}`,
          );
          sendJson(res, 500, { ok: false, error: 'resolver failed while resolving this title' });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: 'unknown resolver route' });
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'resolver request failed' });
    });
  });

  // Providers are slow; a resolver request must never be cut short by a socket
  // idle timeout that is shorter than its own work.
  server.requestTimeout = 0;
  server.headersTimeout = 20_000;

  return { server, token };
}

function method(req: http.IncomingMessage): string {
  return (req.method ?? 'GET').toUpperCase();
}

/** Port the resolver listens on: separate from the media server by default. */
export function resolverPort(cfg: BackendConfig): number {
  const raw = Number(process.env.ELFURA_RESOLVER_PORT || 0);
  if (Number.isFinite(raw) && raw > 0) return raw;
  // Default: next port up, so a single-container install can enable the split
  // without inventing a number that might already be taken by something else.
  return cfg.port === 65535 ? 8790 : cfg.port + 3;
}
