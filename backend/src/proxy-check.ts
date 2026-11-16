/**
 * Proxy health check for the admin panel
 * ======================================
 * "Is this proxy actually working?" has one honest answer: send a request
 * through it and look at what comes back. The probe uses the same undici
 * ProxyAgent path as discovery, over HTTPS, so a proxy that passes here really
 * does tunnel TLS — the part an authentication error or a dead port breaks.
 *
 * The response body of the probe target is an IP address, so the panel can show
 * which exit address a proxy gives this server. That is the number an operator
 * compares when a source website has decided to refuse one address and not
 * another.
 */
import { loadUndici } from './undici-loader.js';
import type { ProxyEntry } from './proxy-pool.js';

/** A tiny text endpoint that answers with the caller's address. */
export function proxyProbeTarget(): string {
  return (process.env.ELFURA_PROXY_TEST_URL || 'https://api.ipify.org/?format=text').trim();
}

export interface ProxyCheck {
  id: string;
  ok: boolean;
  status: number;
  /** Exit address the target saw, when the target reports one. */
  ip: string;
  ms: number;
  error: string;
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

function readableError(error: unknown): string {
  const e = error as Error & { code?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Timed out';
  if (e?.code === 'UND_ERR_CONNECT_TIMEOUT') return 'Connection timed out';
  if (e?.code === 'UND_ERR_SOCKET') return 'Connection closed by the proxy';
  const cause = e?.cause?.code || e?.cause?.message;
  return (cause || e?.code || e?.message || 'Request failed').replace(/[\r\n]+/g, ' ').slice(0, 160);
}

/**
 * The same request without a proxy. Run alongside a failed proxy test, it
 * separates the two causes a beginner cannot tell apart: "the proxies you
 * uploaded are dead" from "this server has no working internet at all".
 */
export async function checkDirect(timeoutMs = 9000): Promise<{ ok: boolean; status: number; ip: string; ms: number; error: string }> {
  const started = Date.now();
  const undici = await loadUndici();
  if (!undici) return { ok: false, status: 0, ip: '', ms: 0, error: 'undici is unavailable' };
  try {
    const response = await undici.request(proxyProbeTarget(), {
      method: 'GET',
      headers: { accept: 'text/plain', 'user-agent': 'elfura-proxy-check' },
      signal: AbortSignal.timeout(timeoutMs),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const body = (await response.body.text()).trim().slice(0, 120);
    const ip = IPV4.test(body) || IPV6.test(body) ? body : '';
    const ok = response.statusCode >= 200 && response.statusCode < 400;
    return { ok, status: response.statusCode, ip, ms: Date.now() - started, error: ok ? '' : `HTTP ${response.statusCode}` };
  } catch (error) {
    return { ok: false, status: 0, ip: '', ms: Date.now() - started, error: readableError(error) };
  }
}

export async function checkProxy(entry: ProxyEntry, timeoutMs = 9000): Promise<ProxyCheck> {
  const started = Date.now();
  const undici = await loadUndici();
  if (!undici) return { id: entry.id, ok: false, status: 0, ip: '', ms: 0, error: 'undici is unavailable' };

  const target = proxyProbeTarget();
  const agent = new undici.ProxyAgent(entry.url);
  try {
    const response = await undici.request(target, {
      dispatcher: agent,
      method: 'GET',
      headers: { accept: 'text/plain', 'user-agent': 'elfura-proxy-check' },
      signal: AbortSignal.timeout(timeoutMs),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const body = (await response.body.text()).trim().slice(0, 120);
    const ip = IPV4.test(body) || IPV6.test(body) ? body : '';
    const ok = response.statusCode >= 200 && response.statusCode < 400;
    return {
      id: entry.id,
      ok,
      status: response.statusCode,
      ip,
      ms: Date.now() - started,
      error: ok ? '' : `HTTP ${response.statusCode}`,
    };
  } catch (error) {
    return { id: entry.id, ok: false, status: 0, ip: '', ms: Date.now() - started, error: readableError(error) };
  } finally {
    void Promise.resolve(agent.close?.()).catch(() => {});
  }
}

/** Bounded parallel checks so a 100-proxy list cannot stall the panel. */
export async function checkProxies(entries: ProxyEntry[], concurrency = 5): Promise<ProxyCheck[]> {
  const results: ProxyCheck[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (index < entries.length) {
      const entry = entries[index];
      index += 1;
      results.push(await checkProxy(entry));
    }
  });
  await Promise.all(workers);
  const order = new Map(entries.map((entry, position) => [entry.id, position]));
  return results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
