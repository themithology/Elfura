/**
 * Per-adapter network tap
 * =======================
 * When twenty adapters all report `raw=0`, the console says nothing about *why*:
 * a 403 from a challenge page, a DNS failure and a six-second timeout look
 * identical from the outside. This module records every outgoing request an
 * adapter makes through global fetch, scoped with AsyncLocalStorage, so the resolve log can say
 * "source-7: 4 req, cdn.example 403 ×3, api.site timeout ×1".
 *
 * It is diagnostic only: the wrapped fetch behaves exactly like the original,
 * no headers or bodies are inspected, and only `host + status/error` is kept.
 * Hosts are printed to the operator console, never to a browser response.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface NetRecord {
  host: string;
  status?: number;
  error?: string;
  ms: number;
}

const storage = new AsyncLocalStorage<NetRecord[]>();
// A later fetch layer can delegate to an earlier tap (e.g. media requests).
// Only the outermost invocation should record that logical fetch.
const recording = new AsyncLocalStorage<boolean>();
const INSTALLED = Symbol.for('elfura.netTap.wrapper');
type MarkedFetch = typeof fetch & { [INSTALLED]?: boolean };

/** Reattach if another startup layer has replaced global fetch. */
export function installNetTap(): void {
  const original = globalThis.fetch as MarkedFetch;
  if (typeof original !== 'function' || original[INSTALLED]) return;

  const wrapped: typeof fetch = async (input, init) => {
    const bucket = storage.getStore();
    if (!bucket || recording.getStore()) return original(input, init);
    let host = 'unknown';
    try {
      host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host;
    } catch {
      /* keep 'unknown' */
    }
    const started = Date.now();
    try {
      const response = await recording.run(true, () => original(input, init));
      bucket.push({ host, status: response.status, ms: Date.now() - started });
      return response;
    } catch (err) {
      bucket.push({
        host,
        error: describeFailure(err),
        ms: Date.now() - started,
      });
      throw err;
    }
  };

  (wrapped as MarkedFetch)[INSTALLED] = true;
  globalThis.fetch = wrapped;
}

/** Record one outgoing request into the caller's log, if there is one. */
export function recordNetEntry(entry: NetRecord): void {
  const bucket = storage.getStore();
  if (bucket) bucket.push(entry);
}

/**
 * Mark a call as "already being recorded" so a nested tap does not count the
 * same logical request twice. Used when a later fetch layer records on its own
 * because it does not go through this wrapper.
 */
export function withOwnRecording<T>(fn: () => Promise<T>): Promise<T> {
  return recording.run(true, fn);
}

/** Run `fn` with its own request log. Returns the log alongside the result. */
export async function tapRequests<T>(fn: () => Promise<T>): Promise<{ value: T; net: NetRecord[] }> {
  const bucket: NetRecord[] = [];
  const value = await storage.run(bucket, fn);
  return { value, net: bucket };
}

/**
 * Why a request failed, in one word the operator can act on.
 *
 * `fetch` rejects with a bare `TypeError: fetch failed` and puts the real reason
 * on `.cause`. Reporting the outer error meant every distinct network fault —
 * a DNS name that will not resolve, a TLS handshake reset mid-flight, a refused
 * port, a timeout — printed as the same `TypeError`, which is exactly useless
 * when twenty adapters fail at once and the answer is one of those four.
 */
export function describeFailure(err: unknown): string {
  const chain: { code?: string; message?: string; name?: string }[] = [];
  let current = err as { code?: string; message?: string; name?: string; cause?: unknown } | undefined;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    chain.push(current);
    current = current.cause as typeof current;
  }
  for (const link of chain) {
    // DOMException exposes numeric legacy codes (20/23); those are not HTTP
    // statuses and should not be printed as mysterious provider responses.
    if (link?.name === 'AbortError' || link?.name === 'TimeoutError') return 'timeout';
    const code = typeof link?.code === 'string' ? link.code : '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns-fail';
    if (code === 'ECONNREFUSED') return 'refused';
    if (code === 'ECONNRESET' || code === 'EPIPE') return 'tls-reset';
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') return 'timeout';
    if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls-cert';
    if (code) return code;
  }
  const name = err instanceof Error ? err.name : 'Error';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  // Nothing structured: keep the message's first words rather than "TypeError".
  const message = (err instanceof Error ? err.message : String(err ?? '')).trim();
  const cause = (err as { cause?: { message?: string } })?.cause?.message;
  const detail = (cause || message).replace(/\s+/g, ' ').slice(0, 40);
  return detail || name;
}

/** Human-readable one-liner: "4 req · cdn.example 403×3 · api.site timeout×1". */
export function summarizeNet(records: NetRecord[]): string {
  if (!records.length) return '0 req';
  const counts = new Map<string, number>();
  for (const r of records) {
    const key = r.status !== undefined ? `${r.host} ${r.status}` : `${r.host} ${r.error ?? 'error'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key, n]) => `${key}${n > 1 ? `×${n}` : ''}`);
  return `${records.length} req · ${parts.join(' · ')}`;
}
