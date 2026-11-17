#!/usr/bin/env node
/**
 * Does a source that returns candidates actually reach the PLAYER?
 *
 * Every probe so far stopped one layer too early: it printed
 * `adapter.resolve()` candidates and called that "working". A candidate still
 * has to survive the registry's race, the liveness probe, ranking, the seal,
 * and the relay rewrite to appear in what the player reads. The user's point is
 * correct - a source can be perfectly healthy upstream and still be invisible,
 * and only a full-stack test can tell the difference.
 *
 * So this boots the real backend server and calls the real endpoint the player
 * calls, then reports:
 *   adapters that ran  ->  their diag lane results  ->  what was sealed
 *   primary + every option, with source id, quality, type and host
 *
 * Counts and hosts only; never a relay ticket or a raw upstream URL.
 */
import crypto from 'node:crypto';
import { createBackendServer } from '../dist/backend/index.js';

const log = (t, v) => console.log(`[pipe] ${t} :: ${v}`);

const { server } = createBackendServer({
  host: '127.0.0.1',
  port: 0,
  isProd: true,
  secret: crypto.createHash('sha256').update('pipeline-audit-only').digest(),
  allowedOrigins: ['https://audit.elfura.invalid'],
  requireToken: false,
  bindTokenIp: false,
  resolveTimeoutMs: 20_000,
  rateLimitPerMin: 1000,
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
log('server', `listening on 127.0.0.1:${port}`);

const headers = {
  Origin: 'https://audit.elfura.invalid',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: null, text: text.slice(0, 200) };
  }
}

// How many sources does the running process think it has? If this is smaller
// than the board we expect, the problem is registration, not resolution.
try {
  const health = await getJson('/api/v1/health');
  log('health', `HTTP ${health.status} sourceCount=${health.body?.sourceCount ?? '?'} build=${health.body?.build ?? '?'}`);
} catch (error) {
  log('health', `ERR ${error.name}`);
}

// The operator-visible source table: names, ids, enabled flags.
try {
  const sites = await getJson('/roxy/api/source-websites');
  const rows = Array.isArray(sites.body?.sites) ? sites.body.sites : [];
  log('roxy sites', `HTTP ${sites.status} count=${rows.length} ${rows.map((r) => `${r.id}${r.enabled === false ? '(off)' : ''}`).join(',')}`);
} catch (error) {
  log('roxy sites', `ERR ${error.name}`);
}

const CASES = (process.env.PIPE_TITLES || 'tv:71446/1/1,movie:1368337,movie:550,tv:1399/1/1')
  .split(',')
  .map((t) => {
    const [type, rest] = t.trim().split(':');
    return { type, rest };
  });

// Only report domains, never full relay/upstream URLs.
const hostOf = (u) => {
  try {
    const parsed = new URL(u, 'http://local.invalid');
    return parsed.hostname === 'local.invalid' ? 'relay-local' : parsed.hostname;
  } catch {
    return '?';
  }
};

for (const { type, rest } of CASES) {
  const id = rest.split('/')[0];
  const qs = new URLSearchParams({ type, tmdbId: id });
  if (type === 'tv') {
    qs.set('season', rest.split('/')[1] || '1');
    qs.set('episode', rest.split('/')[2] || '1');
  }
  const started = Date.now();
  let out;
  try {
    out = await getJson(`/api/v1/playback?${qs.toString()}`);
  } catch (error) {
    log(`${type}/${rest}`, `THREW ${error.name}`);
    continue;
  }
  const ms = Date.now() - started;
  const body = out.body;
  if (!body) {
    log(`${type}/${rest}`, `HTTP ${out.status} NON-JSON "${out.text || ''}"`);
    continue;
  }
  if (body.ok !== true) {
    log(`${type}/${rest}`, `HTTP ${out.status} ok=${body.ok} error=${body.error || body.reason || '?'}`);
    continue;
  }

  const sources = Array.isArray(body.sources) ? body.sources : [];
  const primary = body.primary;
  const bySource = new Map();
  for (const s of sources) {
    bySource.set(s.sourceId, (bySource.get(s.sourceId) ?? 0) + 1);
  }
  log(
    `${type}/${rest}`,
    `HTTP ${out.status} ok primary=${primary?.sourceId ?? '-'}/${primary?.quality ?? '-'}/${primary?.type ?? '-'} ` +
    `options=${sources.length} ${ms}ms`
  );
  log(
    `  ${type}/${rest} bySource`,
    [...bySource.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || 'NONE — nothing was sealed'
  );
  log(
    `  ${type}/${rest} pending`,
    (body.pendingSources ?? []).join(',') || 'none'
  );
  log(
    `  ${type}/${rest} hosts`,
    [...new Set(sources.map((s) => hostOf(s.url)))].slice(0, 6).join('|') || '-'
  );
  log(
    `  ${type}/${rest} langs`,
    [...new Set(sources.flatMap((s) => s.availableAudioLangs ?? []))].slice(0, 12).join(',') || '-'
  );

  // Per-adapter diag, when the build exposes it. This is the layer where a
  // healthy adapter is most likely to be quietly dropping out.
  const diagQs = new URLSearchParams({ type, tmdb: id });
  if (type === 'tv') { diagQs.set('s', qs.get('season')); diagQs.set('e', qs.get('episode')); }
  const diagRes = await getJson(`/api/v1/diagnostics?${diagQs.toString()}`);
  const entries = Array.isArray(diagRes.body?.playback?.resolution?.adapters)
    ? diagRes.body.playback.resolution.adapters
    : Array.isArray(diagRes.body?.resolution?.adapters)
      ? diagRes.body.resolution.adapters
      : [];
  if (entries.length) {
    for (const e of entries) {
      log(
        `  ${type}/${rest} adapter ${e.adapter ?? e.id}`,
        `ok=${e.ok} candidates=${e.candidates ?? e.candidateCount ?? '?'} ${e.detail ? String(e.detail).slice(0, 90) : ''}`
      );
    }
  } else {
    log(`  ${type}/${rest} diag`, `HTTP ${diagRes.status} no adapter rows`);
  }
}

server.close();
console.log('[pipe:done]');
