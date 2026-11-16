/**
 * Upstream JSON fetch for adapters.
 *
 * Why this exists
 * ---------------
 * Adapters used `redirect: 'error'` to avoid being bounced to an unvetted host.
 * That is the right instinct, but it has a sharp edge that cost us real sources:
 *
 *   window.fetch with redirect:'error' does not *return* the 3xx — undici turns it
 *   into `TypeError: fetch failed` before the adapter sees a status. So a provider
 *   that 302s `/api/getAllAnime.php` to `https://www.blakiteapi.xyz/...` looked
 *   exactly like a dead host. source-18 reported `net=TypeError base=0
 *   catalog=unavailable` for that reason and the SubDub lane produced zero rows.
 *
 * The fix keeps the security property and drops the false negative: follow a
 * redirect only if the destination is a URL we would have been willing to fetch
 * directly, and never follow a hop that changes origin while we are carrying an
 * auth header. Anything else is still refused, and refused with a reason instead
 * of a bare TypeError, so the panel can say *why* a lane is empty.
 *
 * One behaviour worth stating plainly: this does not make a refused host work.
 * A 403 is returned as a 403 to the caller. Only the redirect case changes.
 */

/** Outcome of reading a bounded JSON body. Never throws for upstream conditions. */
export interface UpstreamJsonResult {
  /** Parsed body, or null when anything went wrong. */
  body: unknown;
  /** HTTP status of the final hop (0 when no response was received). */
  status: number;
  /** Short, log-safe reason. Present only when `body` is null. */
  reason?: string;
}

export interface UpstreamJsonOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Hard cap on the body. Default 1 MiB. */
  maxBytes?: number;
  /** Redirect hops allowed. Default 3. */
  maxRedirects?: number;
  /** Present an origin on the first hop only (see note below). */
  origin?: string;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/** Headers that must not cross an origin boundary. */
const AUTH_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'x-auth-token']);

function hasAuthHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => AUTH_HEADERS.has(key.toLowerCase()));
}

/**
 * Read a response body with a byte cap. Returns null if over budget instead of
 * buffering it — an oversized body is a failure, not something to parse.
 */
export async function readBoundedText(
  response: Response,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<string | null> {
  if (!response.body) return null;
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Fetch JSON from an upstream, following only vetted redirects.
 *
 * Deliberately returns a result object rather than throwing: an adapter's job is
 * to report what happened, and a thrown TypeError is what hid this bug for weeks.
 */
export async function fetchUpstreamJson(
  url: string,
  options: UpstreamJsonOptions = {},
): Promise<UpstreamJsonResult> {
  const {
    headers = {},
    signal,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    // Some gateways (`blakiteapi` among them) answer 403 unless the request
    // presents their own origin. Only the caller knows that, so it is explicit.
    origin,
  } = options;

  const { isSafeUpstreamUrl } = await import('../security.js');
  let current = url;
  let carriedAuth = hasAuthHeader(headers);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSafeUpstreamUrl(current)) return { body: null, status: 0, reason: 'unsafe-url' };

    let response: Response;
    try {
      response = await fetch(current, {
        // `manual` so we decide, hop by hop, instead of undici turning a 3xx into
        // a TypeError (the bug) or following it blindly (the hole).
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          ...headers,
          ...(origin ? { Referer: `${origin}/`, Origin: origin } : {}),
        },
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      return {
        body: null,
        status: 0,
        reason: `${name}${cause ? `/${cause}` : ''}`,
      };
    }

    // ---- Redirect ---------------------------------------------------------
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) return { body: null, status: response.status, reason: 'redirect-without-location' };
      if (hop === maxRedirects) return { body: null, status: response.status, reason: 'redirect-limit' };

      let next: string;
      try {
        next = new URL(location, current).href;
      } catch {
        return { body: null, status: response.status, reason: 'bad-redirect-target' };
      }
      if (!isSafeUpstreamUrl(next)) {
        return { body: null, status: response.status, reason: 'blocked-redirect-target' };
      }
      // Credentials must not silently travel to another origin.
      if (carriedAuth) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(next).origin === new URL(current).origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          return { body: null, status: response.status, reason: 'blocked-auth-redirect' };
        }
      }
      current = next;
      continue;
    }

    // ---- Terminal response ------------------------------------------------
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { body: null, status: response.status, reason: `http=${response.status}` };
    }

    const text = await readBoundedText(response, maxBytes);
    if (text === null) return { body: null, status: response.status, reason: 'oversized-or-empty' };
    try {
      return { body: JSON.parse(text) as unknown, status: response.status };
    } catch {
      return {
        body: null,
        status: response.status,
        // A non-JSON body from a host that promised JSON is almost always an
        // HTML challenge page; keeping a few bytes makes that obvious in a trace.
        reason: `not-json:${text.slice(0, 24).replace(/\s+/g, ' ')}`,
      };
    }
  }
  return { body: null, status: 0, reason: 'redirect-limit' };
}
