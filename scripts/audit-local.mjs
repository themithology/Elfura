#!/usr/bin/env node
/**
 * Run this ON THE VPS. It answers the only question that matters right now:
 * is this machine's own address blocked by the providers, or is discovery
 * broken for some other reason?
 *
 * Why a separate script instead of /api/v1/egress:
 *   that route probes DNS/TCP/TLS to a handful of hosts and tells you a stage,
 *   not whether a provider will actually hand over its catalogue. This asks each
 *   source adapter for two real titles, exactly like a viewer would, and prints
 *   the HTTP status each provider returned. That is the difference between
 *   "connection failed" and "provider said 403 to this IP".
 *
 * Usage (from the zip root, next to index.js):
 *
 *   node scripts/audit-local.mjs
 *
 * Optional: pass a JSON file of custom titles, or set ELFURA_AUDIT_TMDB.
 */
import crypto from 'node:crypto';

const tmdb = [
  { label: 'movie', type: 'movie', tmdbId: process.env.ELFURA_AUDIT_TMDB || '550' },
  { label: 'tv', type: 'tv', tmdbId: '1399', season: 1, episode: 1 },
];

let createBackendServer;
for (const candidate of ['../dist/backend/index.js', '../backend/dist/index.js', '../dist/index.js', './lib/backend/index.js']) {
  try {
    ({ createBackendServer } = await import(new URL(candidate, import.meta.url).href));
    break;
  } catch { /* try the next layout */ }
}
if (!createBackendServer) {
  console.error('[audit] cannot find the built backend. Run this from the zip root after `npm run build`,');
  console.error('[audit] or point Node at the file: node scripts/audit-local.mjs');
  process.exit(1);
}

const secret = crypto.createHash('sha256').update('local-audit').digest();
const { registry } = createBackendServer({
  host: '127.0.0.1',
  port: 0,
  isProd: false,
  secret,
  allowedOrigins: ['*'],
  requireToken: false,
  bindTokenIp: false,
  // Long: a slow-but-working provider must not be reported as blocked.
  resolveTimeoutMs: 25_000,
  rateLimitPerMin: 10_000,
});

const desc = registry.describeSources();
console.log(`[audit] this machine's view — enabled=${desc.enabled.length} disabled=${desc.disabled.length}`);
for (const d of desc.disabled) console.log(`[audit] disabled ${d.id} (${d.flag})`);

const rows = [];
for (const title of tmdb) {
  const started = Date.now();
  const out = await registry.selfTestAll(title);
  console.log(`[audit] ${title.label} done in ${Date.now() - started}ms`);
  for (const r of out) rows.push({ title: title.label, ...r });
}

const ids = [...new Set(rows.map((r) => r.id))].sort(
  (a, b) => (Number(String(a).replace(/\D/g, '')) || 0) - (Number(String(b).replace(/\D/g, '')) || 0),
);

console.log('\n[audit] source   movie  tv   what the provider said');
console.log('[audit] ' + '-'.repeat(78));
for (const id of ids) {
  const m = rows.find((r) => r.id === id && r.title === 'movie');
  const t = rows.find((r) => r.id === id && r.title === 'tv');
  const n = (r) => (r ? String(r.raw) : 'n/a');
  const note = (m?.net || t?.net || 'no network call made').slice(0, 60);
  console.log(`[audit] ${id.padEnd(9)} ${n(m).padStart(5)}  ${n(t).padEnd(4)} ${note}`);
}

const working = ids.filter((id) => rows.some((r) => r.id === id && r.raw > 0));
const said403 = [...new Set(rows.flatMap((r) => (/(^|\D)403(\D|$)/.test(r.net || '') ? [r.id] : [])))];
const said200 = [...new Set(rows.filter((r) => /200/.test(r.net || '')).map((r) => r.id))];

console.log('\n[audit] ' + '-'.repeat(78));
console.log(`[audit] returned results : ${working.length}/${ids.length}  -> ${working.join(', ') || 'none'}`);
console.log(`[audit] provider said 403: ${said403.length}  -> ${said403.join(', ') || 'none'}`);
console.log(`[audit] provider said 200: ${said200.length}  -> ${said200.join(', ') || 'none'}`);

const cleanButEmpty = said200.filter((id) => !working.includes(id));
if (cleanButEmpty.length) {
  console.log(`\n[audit] REACHABLE BUT EMPTY (no proxy or VPN will fix these):`);
  console.log(`[audit]   ${cleanButEmpty.join(', ')}`);
}
if (said403.length) {
  console.log(`\n[audit] REFUSED WITH 403 (this is the class a new IP could fix):`);
  console.log(`[audit]   ${said403.join(', ')}`);
}
