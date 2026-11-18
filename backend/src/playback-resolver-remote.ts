/**
 * A PlaybackResolver that talks to a separate resolver process over HTTP.
 *
 * Used by the media backend when ELFURA_RESOLVER_URL is set. Design rules:
 *
 *  - The media server's own responsiveness always wins. Every call is bounded,
 *    and a resolver that is down produces a clean error in a couple of seconds
 *    rather than a hung request.
 *  - Failures are not retried from here. Retrying provider scraping from the
 *    process that serves video is exactly the coupling this exists to remove,
 *    and the resolver already retries what is worth retrying.
 *  - The token is required for everything except the health probe, so an exposed
 *    resolver port cannot be used to scrape through your host.
 */

import {
  RESOLVER_AUTH_HEADER,
  type PlaybackRequest,
  type PlaybackResolution,
  type PlaybackResolver,
  type ResolverSourceStatus,
} from './playback-resolver.js';

/** A resolver call that is slow is worse than one that fails: give up early. */
const RESOLVE_TIMEOUT_MS = Number(process.env.ELFURA_RESOLVER_TIMEOUT_MS || 30_000);
/** Control-plane calls (status, toggles) should be instant. */
const CONTROL_TIMEOUT_MS = 5_000;

export class RemotePlaybackResolver implements PlaybackResolver {
  readonly kind = 'remote' as const;
  readonly label: string;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly log: (line: string) => void = console.log,
  ) {
    this.label = baseUrl;
  }

  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? CONTROL_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          [RESOLVER_AUTH_HEADER]: this.token,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* a non-JSON body from a healthy resolver means a proxy sat in the way */
      }
      if (!response.ok) {
        const detail =
          (parsed as { error?: string } | null)?.error ?? `resolver answered HTTP ${response.status}`;
        // 4xx is the resolver judging a request, and it is alive: that is not an
        // outage. 5xx and transport errors are.
        if (response.status < 500) throw new InvalidRequestError(detail, response.status);
        throw new Error(detail);
      }
      if (parsed === null) throw new Error('resolver returned a non-JSON body');
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async resolve(request: PlaybackRequest): Promise<PlaybackResolution | null> {
    try {
      const body = await this.call<PlaybackResolution | { ok: false; error?: string }>(
        '/resolver/api/playback',
        { method: 'POST', body: request, timeoutMs: RESOLVE_TIMEOUT_MS },
      );
      if (!body || (body as { ok?: boolean }).ok !== true) return null;
      return body as PlaybackResolution;
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        this.log(`[elfura-resolver-client] ${request.type}/${request.tmdbId} rejected: ${error.message}`);
        return null;
      }
      const detail = error instanceof Error ? error.message : 'resolver call failed';
      // One line, not a stack: the interesting part of a provider outage is that
      // it happened at all, and the resolver keeps its own detailed log.
      this.log(`[elfura-resolver-client] ${request.type}/${request.tmdbId} failed: ${detail}`);
      throw new ResolverUnavailableError(detail);
    }
  }

  async probe(): Promise<{ reachable: boolean; detail: string; sources?: string[] }> {
    try {
      const body = await this.call<{ ok: boolean; sources?: string[] }>('/resolver/api/health');
      return { reachable: body.ok === true, detail: 'resolver answered', sources: body.sources };
    } catch (error) {
      return {
        reachable: false,
        detail: error instanceof Error ? error.message : 'resolver unreachable',
      };
    }
  }

  async sourceStatus(): Promise<ResolverSourceStatus[] | null> {
    try {
      const body = await this.call<{ sources?: ResolverSourceStatus[] }>('/resolver/api/sources');
      return Array.isArray(body.sources) ? body.sources : null;
    } catch {
      return null;
    }
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<boolean> {
    try {
      await this.call('/resolver/api/sources', { method: 'POST', body: { id, enabled } });
      return true;
    } catch {
      return false;
    }
  }
}

/** Thrown when the resolver cannot be reached, so callers can answer honestly. */
/** The resolver answered, and said no. Not an outage. */
export class InvalidRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export class ResolverUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ResolverUnavailableError';
  }
}
