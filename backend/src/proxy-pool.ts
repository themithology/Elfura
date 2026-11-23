import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ProxyMode = 'direct' | 'proxy-pool' | 'hybrid';
export type ProxyKind = 'connect' | 'fetch-api';

export interface ProxyStats {
  requests: number;
  successes: number;
  failures: number;
  status403: number;
  status429: number;
  avgLatencyMs: number;
  lastLatencyMs: number | null;
  lastError: string | null;
  lastCheckedAt: number | null;
  lastEgressIp: string | null;
  healthy: boolean;
}

export interface ProxyEntry {
  id: string;
  kind: ProxyKind;
  label: string;
  url: string;
  apiKey?: string;
  enabled: boolean;
  weight: number;
  createdAt: number;
  stats: ProxyStats;
}

export interface PublicProxyEntry {
  id: string;
  kind: ProxyKind;
  label: string;
  maskedUrl: string;
  enabled: boolean;
  weight: number;
  createdAt: number;
  stats: ProxyStats;
}

interface PersistedProxyPool {
  mode: ProxyMode;
  proxies: Array<{
    id: string;
    kind?: ProxyKind;
    label: string;
    url: string;
    apiKey?: string;
    enabled: boolean;
    weight: number;
    createdAt: number;
  }>;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const POOL_FILE = path.join(DATA_DIR, 'proxies.json');

function defaultStats(): ProxyStats {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    status403: 0,
    status429: 0,
    avgLatencyMs: 0,
    lastLatencyMs: null,
    lastError: null,
    lastCheckedAt: null,
    lastEgressIp: null,
    healthy: true,
  };
}

export function maskProxyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const auth = u.username ? `${u.username}:••••@` : '';
    return `${u.protocol}//${auth}${u.host}`;
  } catch {
    return 'invalid-url';
  }
}

export function validateProxyUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

class ProxyPoolManager {
  private mode: ProxyMode = 'direct';
  private entries: ProxyEntry[] = [];
  private turn = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(POOL_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8')) as Partial<PersistedProxyPool>;
      if (raw.mode === 'direct' || raw.mode === 'proxy-pool' || raw.mode === 'hybrid') {
        this.mode = raw.mode;
      }
      if (Array.isArray(raw.proxies)) {
        this.entries = raw.proxies
          .filter((p) => p && typeof p.url === 'string' && validateProxyUrl(p.url))
          .map((p) => ({
            id: typeof p.id === 'string' && p.id ? p.id : crypto.randomBytes(6).toString('hex'),
            kind: p.kind === 'fetch-api' ? 'fetch-api' : 'connect',
            label: typeof p.label === 'string' && p.label.trim() ? p.label.trim().slice(0, 48) : 'Proxy',
            url: validateProxyUrl(p.url)!,
            ...(typeof p.apiKey === 'string' && p.apiKey ? { apiKey: p.apiKey } : {}),
            enabled: p.enabled !== false,
            weight: Number.isFinite(p.weight) && p.weight > 0 ? Math.min(10, Math.round(p.weight)) : 1,
            createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
            stats: defaultStats(),
          }));
      }
    } catch {
      // Ignore corrupt file; start clean.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const payload: PersistedProxyPool = {
        mode: this.mode,
        proxies: this.entries.map((e) => ({
          id: e.id,
          kind: e.kind,
          label: e.label,
          url: e.url,
          ...(e.apiKey ? { apiKey: e.apiKey } : {}),
          enabled: e.enabled,
          weight: e.weight,
          createdAt: e.createdAt,
        })),
      };
      fs.writeFileSync(POOL_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch {
      // Best-effort persistence.
    }
  }

  getMode(): ProxyMode {
    return this.mode;
  }

  setMode(mode: ProxyMode): ProxyMode {
    this.mode = mode;
    this.save();
    return this.mode;
  }

  listPublic(): { mode: ProxyMode; proxies: PublicProxyEntry[]; summary: { total: number; enabled: number; healthy: number; requests: number; successes: number; failures: number; status403: number; status429: number } } {
    let requests = 0;
    let successes = 0;
    let failures = 0;
    let status403 = 0;
    let status429 = 0;
    let enabled = 0;
    let healthy = 0;
    const proxies: PublicProxyEntry[] = this.entries.map((e) => {
      if (e.enabled) enabled++;
      if (e.enabled && e.stats.healthy) healthy++;
      requests += e.stats.requests;
      successes += e.stats.successes;
      failures += e.stats.failures;
      status403 += e.stats.status403;
      status429 += e.stats.status429;
      return {
        id: e.id,
        kind: e.kind,
        label: e.label,
        maskedUrl: maskProxyUrl(e.url),
        enabled: e.enabled,
        weight: e.weight,
        createdAt: e.createdAt,
        stats: { ...e.stats },
      };
    });
    return {
      mode: this.mode,
      proxies,
      summary: { total: this.entries.length, enabled, healthy, requests, successes, failures, status403, status429 },
    };
  }

  add(input: { kind?: ProxyKind; label?: string; url: string; apiKey?: string; weight?: number }): PublicProxyEntry | null {
    const validUrl = validateProxyUrl(input.url);
    if (!validUrl) return null;
    const kind: ProxyKind = input.kind === 'fetch-api' ? 'fetch-api' : 'connect';
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : undefined;
    const entry: ProxyEntry = {
      id: crypto.randomBytes(6).toString('hex'),
      kind,
      label: (input.label || '').trim().slice(0, 48) || `Proxy ${this.entries.length + 1}`,
      url: validUrl,
      ...(apiKey ? { apiKey } : {}),
      enabled: true,
      weight: Number.isFinite(input.weight) && (input.weight ?? 1) > 0 ? Math.min(10, Math.round(input.weight!)) : 1,
      createdAt: Date.now(),
      stats: defaultStats(),
    };
    this.entries.push(entry);
    this.save();
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      maskedUrl: maskProxyUrl(entry.url),
      enabled: entry.enabled,
      weight: entry.weight,
      createdAt: entry.createdAt,
      stats: { ...entry.stats },
    };
  }

  update(id: string, patch: { enabled?: boolean; label?: string; weight?: number }): PublicProxyEntry | null {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    if (typeof patch.enabled === 'boolean') {
      entry.enabled = patch.enabled;
      if (patch.enabled) entry.stats.healthy = true;
    }
    if (typeof patch.label === 'string' && patch.label.trim()) {
      entry.label = patch.label.trim().slice(0, 48);
    }
    if (typeof patch.weight === 'number' && Number.isFinite(patch.weight) && patch.weight > 0) {
      entry.weight = Math.min(10, Math.round(patch.weight));
    }
    this.save();
    return {
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      maskedUrl: maskProxyUrl(entry.url),
      enabled: entry.enabled,
      weight: entry.weight,
      createdAt: entry.createdAt,
      stats: { ...entry.stats },
    };
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  pick(): ProxyEntry | null {
    if (this.mode === 'direct') return null;
    const active = this.entries.filter((e) => e.enabled && e.stats.healthy);
    const pool = active.length > 0 ? active : (this.mode === 'proxy-pool' ? this.entries.filter((e) => e.enabled) : []);
    if (pool.length === 0) return null;
    const chosen = pool[this.turn++ % pool.length];
    return chosen;
  }

  recordOutcome(id: string, outcome: { ok: boolean; status?: number; latencyMs: number; error?: string }): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    const s = entry.stats;
    s.requests++;
    s.lastLatencyMs = Math.max(1, Math.round(outcome.latencyMs));
    s.avgLatencyMs = s.avgLatencyMs === 0 ? s.lastLatencyMs : Math.round(s.avgLatencyMs * 0.75 + s.lastLatencyMs * 0.25);
    if (outcome.status === 403) s.status403++;
    if (outcome.status === 429) s.status429++;
    if (outcome.ok) {
      s.successes++;
      s.healthy = true;
      s.lastError = null;
    } else {
      s.failures++;
      if (outcome.error) s.lastError = outcome.error.slice(0, 120);
      if (s.failures >= 3 && s.successes === 0) s.healthy = false;
    }
  }

  getById(id: string): ProxyEntry | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }
}

export const proxyPool = new ProxyPoolManager();
