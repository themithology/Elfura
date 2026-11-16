/**
 * Operator-uploaded proxy pool
 * ============================
 * Some source websites refuse this server's address. One fixed proxy helps
 * until it is banned too, so the admin panel accepts a whole list instead: the
 * operator uploads the provider's `.txt` export and Elfura rotates through it
 * for discovery requests, with automatic failover and a cooldown for dead
 * entries. Ranged media still leaves directly — see `egress.ts`.
 *
 * Accepted line formats (one proxy per line, CRLF, blanks and `#` comments are
 * fine), which covers every list a provider hands out:
 *
 *   host:port:username:password      <- Webshare export
 *   username:password@host:port
 *   http://username:password@host:port
 *   host:port                        <- open proxy, no credentials
 *   host port username password      <- space or tab separated
 *
 * Nothing here logs or returns a password. The panel shows host, port and a
 * masked username only. The list is persisted to `data/proxies.json` (mode
 * 0600) so it survives a restart, and that directory is already git-ignored.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Providers hand out tens, not thousands; the panel stays usable either way. */
export const MAX_PROXIES = 500;
/** Upload cap, in characters. A 500-line list is well under this. */
export const MAX_PROXY_TEXT_BYTES = 256 * 1024;
/** After this many consecutive transport failures a proxy rests for a minute. */
const MAX_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 60_000;

export interface ProxyEntry {
  /** Stable id derived from the URL; safe to send to the panel. */
  id: string;
  /** Full URL including credentials. Never sent to a browser. */
  url: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

interface ProxyHealth {
  failures: number;
  /** Epoch ms until which this proxy is skipped, 0 when healthy. */
  until: number;
  error: string;
}

const idFor = (url: string): string =>
  crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildEntry(host: string, port: number | string, username = '', password = ''): ProxyEntry | null {
  const bare = String(host ?? '')
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase();
  // Hostnames, IPv4 and IPv6 only: no spaces, slashes, userinfo or ports here.
  if (!bare || bare.length > 255 || !/^[a-z0-9.\-:]+$/i.test(bare)) return null;
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return null;
  const user = String(username ?? '');
  const pass = String(password ?? '');
  if (user.length > 200 || pass.length > 200) return null;
  const auth = user || pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  const hostPart = bare.includes(':') ? `[${bare}]` : bare;
  const url = `http://${auth}${hostPart}:${numericPort}`;
  return { id: idFor(url), url, host: bare, port: numericPort, username: user, password: pass };
}

/** One line of a provider export → one proxy, or null when it is not one. */
export function parseProxyLine(raw: string): ProxyEntry | null {
  let line = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!line || line.startsWith('#') || line.startsWith('//')) return null;
  // Pasted CSV cells often keep their quotes.
  line = line.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
  if (!line) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
    let url: URL;
    try {
      url = new URL(line);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return buildEntry(url.hostname, port, decode(url.username), decode(url.password));
  }

  if (line.includes('@')) {
    let url: URL;
    try {
      url = new URL(`http://${line}`);
    } catch {
      return null;
    }
    if (!url.port) return null; // a proxy without a port cannot be dialled
    return buildEntry(url.hostname, url.port, decode(url.username), decode(url.password));
  }

  if (line.includes(':')) {
    const parts = line.split(':');
    // host:port:user:pass — a password may itself contain colons, so keep the
    // remainder intact instead of dropping everything after the fourth field.
    if (parts.length >= 4) {
      return buildEntry(parts[0], parts[1], parts[2].trim(), parts.slice(3).join(':'));
    }
    if (parts.length === 2) return buildEntry(parts[0], parts[1]);
    return null;
  }

  const fields = line.split(/[\s\t]+/).filter(Boolean);
  if (fields.length === 2) return buildEntry(fields[0], fields[1]);
  if (fields.length >= 4) return buildEntry(fields[0], fields[1], fields[2], fields.slice(3).join(' '));
  return null;
}

/** The whole uploaded document → deduplicated entries plus a rejection count. */
export function parseProxyList(text: string): { entries: ProxyEntry[]; rejected: number } {
  const entries: ProxyEntry[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const entry = parseProxyLine(trimmed);
    if (!entry) {
      rejected += 1;
      continue;
    }
    if (seen.has(entry.url)) continue;
    if (entries.length >= MAX_PROXIES) {
      rejected += 1;
      continue;
    }
    seen.add(entry.url);
    entries.push(entry);
  }
  return { entries, rejected };
}

/** Operator-facing identity of a proxy. Never includes the password. */
function maskUser(username: string): string {
  if (!username) return '';
  return username.length <= 3 ? `${username.slice(0, 1)}…` : `${username.slice(0, 4)}…`;
}

export interface PublicProxy {
  id: string;
  host: string;
  port: number;
  /** Masked username, or '' for an open proxy. */
  user: string;
  auth: boolean;
  state: 'ok' | 'failing' | 'untested';
  failures: number;
  lastError: string;
  cooldownMs: number;
  /** Exit address reported by the last successful probe, or ''. */
  ip: string;
}

export class ProxyPool {
  private entries: ProxyEntry[] = [];
  private health = new Map<string, ProxyHealth>();
  /** Proxies that have answered at least once since the list was uploaded. */
  private verified = new Set<string>();
  /** Exit address each proxy last reported, when the probe could read it. */
  private lastIps = new Map<string, string>();
  private cursor = 0;
  /** Bumped whenever the list changes so cached dispatchers can be released. */
  generation = 0;
  private file: string;
  private storageError = '';

  constructor(directory = process.env.ROXY_DATA_DIR || path.join(process.cwd(), 'data')) {
    this.file = path.join(directory, 'proxies.json');
    this.read();
  }

  private read(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { entries?: unknown };
      if (!Array.isArray(raw.entries)) return;
      const entries: ProxyEntry[] = [];
      for (const value of raw.entries) {
        if (typeof value !== 'string') continue;
        const entry = parseProxyLine(value);
        if (entry && !entries.some((e) => e.url === entry.url)) entries.push(entry);
        if (entries.length >= MAX_PROXIES) break;
      }
      this.entries = entries;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.storageError = 'Could not read the saved proxy list';
    }
  }

  private persist(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      const body = JSON.stringify({ version: 1, entries: this.entries.map((e) => e.url) });
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.storageError = '';
      return true;
    } catch {
      this.storageError = 'Could not save the proxy list; it stays active until restart';
      return false;
    }
  }

  /** Replace the pool with what the operator just uploaded. */
  replaceText(text: string): { added: number; rejected: number; persisted: boolean } {
    const parsed = parseProxyList(text);
    this.entries = parsed.entries;
    this.health.clear();
    this.verified.clear();
    this.lastIps.clear();
    this.cursor = 0;
    this.generation += 1;
    const persisted = this.persist();
    return { added: parsed.entries.length, rejected: parsed.rejected, persisted };
  }

  clear(): boolean {
    this.entries = [];
    this.health.clear();
    this.verified.clear();
    this.lastIps.clear();
    this.cursor = 0;
    this.generation += 1;
    return this.persist();
  }

  get size(): number {
    return this.entries.length;
  }

  list(): ProxyEntry[] {
    return [...this.entries];
  }

  find(id: unknown): ProxyEntry | null {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  /**
   * The next proxies for one request: healthy entries only, each request
   * starting one further along.
   *
   * An earlier version fell back to a cooling (already failing) proxy once the
   * healthy ones ran out, on the theory that "a fully dead list should still be
   * attempted rather than silently doing nothing". That is exactly wrong against
   * a metered provider: a list that is dead or rate-limited got dialled on every
   * single request — three dials per source probe, twenty-one sources per
   * resolve — and the operator's account was throttled for "1,000 requests in a
   * second" while nothing was actually working. Cooling now means cooling: the
   * request goes direct, which costs the provider nothing and still lets the
   * source succeed on this server's own address.
   */
  nextCandidates(limit = 3): ProxyEntry[] {
    const total = this.entries.length;
    if (!total) return [];
    const now = Date.now();
    const healthy: ProxyEntry[] = [];
    for (let i = 0; i < total; i += 1) {
      const entry = this.entries[(this.cursor + i) % total];
      const health = this.health.get(entry.id);
      if (!health || health.until <= now) healthy.push(entry);
    }
    this.cursor = (this.cursor + 1) % total;
    return healthy.slice(0, Math.max(1, limit));
  }

  /** True when every entry is resting; the panel uses this to explain the pause. */
  allCooling(): boolean {
    if (!this.entries.length) return false;
    const now = Date.now();
    return this.entries.every((entry) => {
      const health = this.health.get(entry.id);
      return !!health && health.until > now;
    });
  }

  reportSuccess(id: string): void {
    this.health.delete(id);
    this.verified.add(id);
  }

  reportFailure(id: string, error: unknown): void {
    this.verified.delete(id);
    const previous = this.health.get(id);
    const failures = (previous?.failures ?? 0) + 1;
    const message = (error instanceof Error ? error.message : String(error ?? 'Request failed'))
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 160);
    this.health.set(id, {
      failures,
      until: failures >= MAX_CONSECUTIVE_FAILURES ? Date.now() + COOLDOWN_MS : 0,
      error: message,
    });
  }

  /** Remember the exit address a probe saw, so the panel can show it. */
  reportIp(id: string, ip: string): void {
    if (ip) this.lastIps.set(id, ip);
  }

  healthOf(id: string): ProxyHealth | null {
    return this.health.get(id) ?? null;
  }

  snapshot(): {
    count: number;
    limit: number;
    proxies: PublicProxy[];
    storageError: string;
  } {
    const now = Date.now();
    const proxies = this.entries.map((entry) => {
      const health = this.health.get(entry.id);
      const cooling = !!health && health.until > now;
      return {
        id: entry.id,
        host: entry.host,
        port: entry.port,
        user: maskUser(entry.username),
        auth: !!(entry.username || entry.password),
        // A proxy that failed its last attempt is reported as failing even
        // before the cooldown threshold, so the panel does not keep calling a
        // dead endpoint "untested" while every request quietly skips it.
        state: (cooling || (health?.failures ?? 0) > 0
          ? 'failing'
          : this.verified.has(entry.id)
            ? 'ok'
            : 'untested') as PublicProxy['state'],
        failures: health?.failures ?? 0,
        lastError: health?.error ?? '',
        cooldownMs: cooling ? health!.until - now : 0,
        ip: this.lastIps.get(entry.id) ?? '',
      };
    });
    return { count: proxies.length, limit: MAX_PROXIES, proxies, storageError: this.storageError };
  }
}

/** Process-wide pool; the admin panel edits this and egress reads it per request. */
export const proxyPool = new ProxyPool();
