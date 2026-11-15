/**
 * Per-adapter network tap
 * =======================
 * When twenty adapters all report `raw=0`, the console says nothing about *why*:
 * a 403 from a challenge page, a DNS failure and a six-second timeout look
 * identical from the outside. This module records every outgoing request an
 * adapter makes, scoped with AsyncLocalStorage, so the resolve log can say
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
const INSTALLED = Symbol.for('elfura.netTap');

type GlobalWithTap = typeof globalThis & { [INSTALLED]?: boolean };

/** Install the wrapper once; safe to call on every boot and in tests. */
export function installNetTap(): void {
  const g = globalThis as GlobalWithTap;
  if (g[INSTALLED]) return;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return;

  const wrapped: typeof fetch = async (input, init) => {
    const bucket = storage.getStore();
    if (!bucket) return original(input, init);
    let host = 'unknown';
    try {
      host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host;
    } catch {
      /* keep 'unknown' */
    }
    const started = Date.now();
    try {
      const response = await original(input, init);
      bucket.push({ host, status: response.status, ms: Date.now() - started });
      return response;
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      bucket.push({
        host,
        error: name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : name,
        ms: Date.now() - started,
      });
      throw err;
    }
  };

  globalThis.fetch = wrapped;
  g[INSTALLED] = true;
}

/** Run `fn` with its own request log. Returns the log alongside the result. */
export async function tapRequests<T>(fn: () => Promise<T>): Promise<{ value: T; net: NetRecord[] }> {
  const bucket: NetRecord[] = [];
  const value = await storage.run(bucket, fn);
  return { value, net: bucket };
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
