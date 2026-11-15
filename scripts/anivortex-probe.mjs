#!/usr/bin/env node
/**
 * AniVortex feasibility probe (run from CI or any host that can reach the API).
 * ===========================================================================
 * Registers a throwaway installation (or reuses ELFURA_ANIVORTEX_* if set) and
 * then walks one title step by step, printing status codes, JSON key shapes and
 * error codes so a failed shape can be diagnosed without guessing.
 *
 * Credentials are never printed. Full upstream media URLs are never printed.
 *
 *   node scripts/anivortex-probe.mjs 'movie:Dune: Part Two:2024' 'tv:Breaking Bad:2008:1:1'
 */

import { anivortexRequest, readAnivortexCredentials, registerAnivortexInstallation } from '../dist/backend/anivortex-auth.js';
import { pickBestTitle } from '../dist/backend/sources/source17.js';

const redactUrl = (value) => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/…`;
  } catch {
    return '<invalid>';
  }
};

const describe = (json) => {
  if (json === null || json === undefined) return 'null';
  if (Array.isArray(json)) return `array(${json.length})`;
  if (typeof json !== 'object') return typeof json;
  return `object{${Object.keys(json).slice(0, 12).join(',')}}`;
};

const errorOf = (json) => {
  const error = json?.error;
  if (!error) return '';
  return ` error=${typeof error === 'string' ? error : `${error.code ?? '?'}:${String(error.message ?? '').slice(0, 140)}`}`;
};

const args = process.argv.slice(2);
const specs = args.length > 0 ? args : ['movie:Dune: Part Two:2024', 'tv:Breaking Bad:2008:1:1'];

let credentials = readAnivortexCredentials();
if (!credentials) {
  console.log('No ELFURA_ANIVORTEX_* credentials present — registering a throwaway installation.');
  const registration = await registerAnivortexInstallation({}).catch(() => null);
  if (!registration) {
    console.error('Registration failed: the API rejected the challenge/register handshake from this network.');
    process.exit(1);
  }
  credentials = registration.credentials;
  console.log(`Registration succeeded (installation_id length=${credentials.installationId.length}, key_id length=${credentials.keyId.length}).`);
}

const call = async (path, query = {}, body) => {
  const started = Date.now();
  try {
    const result = await anivortexRequest(
      credentials,
      { method: body ? 'POST' : 'GET', path, query, body },
      { signal: AbortSignal.timeout(12_000) },
    );
    return { ...result, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: 0, json: null, ms: Date.now() - started, threw: String(error?.message ?? error) };
  }
};

const report = (label, path, result) => {
  const status = result.threw ? `threw ${result.threw}` : `HTTP ${result.status}`;
  console.log(`  ${label} ${path} → ${status} in ${result.ms}ms ${describe(result.json)}${errorOf(result.json)}`);
};

for (const spec of specs) {
  const parts = spec.split(':');
  const type = parts.shift() === 'tv' ? 'tv' : 'movie';
  const episode = type === 'tv' ? parts.pop() : undefined;
  const season = type === 'tv' ? parts.pop() : undefined;
  const year = parts.pop();
  const title = parts.join(':').trim();
  console.log(`\n=== ${type}: ${title} (${year})`);

  const search = await call('/api/v1/search', { q: title });
  report('search', '/api/v1/search?q=', search);
  const items = Array.isArray(search.json?.results)
    ? search.json.results
    : Array.isArray(search.json?.items)
      ? search.json.items
      : Array.isArray(search.json?.titles)
        ? search.json.titles
        : [];
  if (items.length > 0) {
    console.log(`  first item keys: ${describe(items[0])}`);
    console.log(`  first three: ${items.slice(0, 3).map((item) => `${item?.title ?? '?'} (${item?.release_year ?? '?'}) [${item?.content_type ?? '?'}] id=${item?.id ?? '?'}`).join(' | ')}`);
  }
  const match = pickBestTitle(
    items.map((item) => ({
      id: String(item?.id ?? ''),
      title: String(item?.title ?? ''),
      originalTitle: String(item?.original_title ?? item?.originalTitle ?? ''),
      contentType: String(item?.content_type ?? item?.contentType ?? '').toLowerCase(),
      releaseYear: Number(item?.release_year ?? item?.releaseYear) || null,
    })).filter((item) => /^\d+$/.test(item.id) && item.title),
    { type, title, year },
  );
  console.log(`  matched title id: ${match ? `${match.id} (${match.title})` : 'NONE — search shape or scoring mismatch'}`);
  if (!match) continue;

  const detail = await call(`/api/v1/titles/${match.id}`);
  report('detail', `/api/v1/titles/${match.id}`, detail);
  if (detail.json && typeof detail.json === 'object') {
    console.log(`  detail keys: ${describe(detail.json)}`);
    for (const key of ['seasons', 'episodes', 'is_movie', 'content_type']) {
      if (key in detail.json) console.log(`    ${key}=${JSON.stringify(detail.json[key]).slice(0, 180)}`);
    }
  }

  if (type === 'tv') {
    const watch = await call(`/api/v1/titles/${match.id}/watch`);
    report('watch', `/api/v1/titles/${match.id}/watch`, watch);
  }

  const attempts = type === 'movie'
    ? [{}, { season: '1', episode: '1' }]
    : [{ season: String(season || 1), episode: String(episode || 1) }, {}, { episode: String(episode || 1) }];
  for (const attempt of attempts) {
    const playback = await call(`/api/v1/titles/${match.id}/playback`, attempt);
    report('playback', `/api/v1/titles/${match.id}/playback?${new URLSearchParams(attempt)}`, playback);
    const json = playback.json;
    if (!json || typeof json !== 'object') continue;
    if (json.error) continue;
    const server = json.server ?? json.data?.server;
    const servers = server?.languages ? [server] : [];
    if (Array.isArray(json.server_options)) console.log(`  server_options=${json.server_options.length}: ${json.server_options.slice(0, 5).map((option) => option?.key ?? option).join(',')}`);
    for (const entry of servers) {
      console.log(`  server=${entry.key ?? '?'} languages=${(entry.languages ?? []).length}`);
      for (const language of (entry.languages ?? []).slice(0, 4)) {
        const qualities = language?.playback?.qualities ?? [];
        console.log(`    lang=${language.code ?? '?'}/${language.name ?? '?'} qualities=${qualities.length}` +
          (qualities[0] ? ` first=${qualities[0].quality ?? '?'}/${qualities[0].type ?? '?'} ${qualities[0].url ? redactUrl(qualities[0].url) : 'no-url'}` : ''));
      }
    }
    if (servers.length > 0) break;
  }
}
