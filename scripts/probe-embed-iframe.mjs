#!/usr/bin/env node
/**
 * Why does the player work on our own page but show "Couldn't find this title"
 * when a third-party site iframes it?
 *
 * The screenshot rules out a few of the obvious causes:
 *   - the iframe itself renders (site chrome, server buttons, poster), so it is
 *     not X-Frame-Options
 *   - the message text is the `resolve-<status>` branch in controls.ts, which
 *     only fires when /api/v1/playback answers NON-OK. So the player loaded,
 *     then its data request was refused.
 *
 * The only difference between "our page" and "their page" is what the browser
 * sends as Referer/Origin and Sec-Fetch-Site, so this reproduces both cases
 * against a real server, with and without a restrictive ALLOWED_ORIGINS.
 *
 * Reports statuses and refusal reasons only.
 */
import crypto from 'node:crypto';
import { createBackendServer } from '../dist/backend/index.js';

const log = (t, v) => console.log(`[ifr] ${t} :: ${v}`);
const PARENT = 'https://some-embedding-site.example';

async function boot(allowedOrigins) {
  const { server } = createBackendServer({
    host: '127.0.0.1',
    port: 0,
    isProd: true,
    secret: crypto.createHash('sha256').update('embed-iframe-audit').digest(),
    allowedOrigins,
    requireToken: false,
    bindTokenIp: false,
    resolveTimeoutMs: 6000,
    rateLimitPerMin: 1000,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

/**
 * Ask the playback endpoint exactly as the embedded player would.
 * `ref`/`origin` describe the caller: our own embed page vs a cross-site frame.
 */
async function playback(port, { ref, origin, label }) {
  const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/137.0' };
  if (ref) headers.Referer = ref;
  if (origin) headers.Origin = origin;
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/playback?type=movie&tmdb=550`,
    { headers, signal: AbortSignal.timeout(30_000) },
  );
  const body = await res.json().catch(() => ({}));
  const info = body?.ok
    ? `ok sources=${body.sources?.length ?? 0}`
    : `error="${body?.error ?? '?'}"`;
  log(label, `HTTP ${res.status} ${info}`);
  return res.status;
}

// ---- Case 1: default config (ALLOWED_ORIGINS unset -> ['*']) ---------------
{
  const { server, port } = await boot(['*']);
  log('--- config', "ALLOWED_ORIGINS unset ('*')");
  await playback(port, { ref: `http://127.0.0.1:${port}/movie/550`, label: 'own page (self referer)' });
  await playback(port, { ref: `${PARENT}/player?id=550`, origin: PARENT, label: 'cross-site iframe (parent origin)' });
  await playback(port, { ref: `${PARENT}/player?id=550`, label: 'cross-site iframe (parent referer only)' });
  server.close();
}

// ---- Case 2: restrictive allowlist, the common VPS hardening --------------
{
  const { server, port } = await boot(['https://elfura.example']);
  log('--- config', 'ALLOWED_ORIGINS=https://elfura.example');
  await playback(port, { ref: 'https://elfura.example/movie/550', label: 'own page on allowed origin' });
  await playback(port, { ref: `${PARENT}/player?id=550`, origin: PARENT, label: 'cross-site iframe (parent origin)' });
  await playback(port, { ref: `${PARENT}/player?id=550`, label: 'cross-site iframe (parent referer only)' });
  // The embed document is OURS, served by us; its own API call carries our host
  // as the referrer even though the top frame is third-party.
  await playback(port, { ref: `http://127.0.0.1:${port}/embed/movie/550`, label: 'our embed page as referer' });
  await playback(port, { ref: `${PARENT}/page`, origin: `http://127.0.0.1:${port}`, label: 'parent referer, our Origin' });
  // The browser's own signal, which cannot be forged by page script.
  {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/playback?type=movie&tmdb=550`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 Chrome/137.0',
        'Sec-Fetch-Site': 'same-origin',
        Referer: `${PARENT}/player?id=550`,
      },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    log('parent referer + Sec-Fetch-Site same-origin', `HTTP ${res?.status ?? 'ERR'}`);
  }
  server.close();
}

// ---- Case 3: does the embed document itself carry a usable token? ---------
{
  const { server, port } = await boot(['https://elfura.example']);
  const res = await fetch(`http://127.0.0.1:${port}/embed/movie/550`, {
    headers: { Referer: `${PARENT}/player?id=550`, 'User-Agent': 'Mozilla/5.0 Chrome/137.0' },
    signal: AbortSignal.timeout(20_000),
  });
  const html = await res.text();
  const token = (html.match(/"pltoken"\s*:\s*"([^"]+)"/) || [])[1] || (html.match(/pltoken["']?\s*[:=]\s*["']([^"']+)/) || [])[1];
  log('--- embed doc', `HTTP ${res.status} bytes=${html.length} pltoken=${token ? 'injected' : 'MISSING'}`);
  if (token) {
    for (const [label, extra] of [
      ['token + parent referer', { Referer: `${PARENT}/player?id=550` }],
      ['token + our embed referer', { Referer: `http://127.0.0.1:${port}/embed/movie/550` }],
      ['token + parent origin', { Referer: `${PARENT}/player?id=550`, Origin: PARENT }],
    ]) {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/playback?type=movie&tmdb=550`, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 Chrome/137.0',
          'X-Playback-Token': token,
          ...extra,
        },
        signal: AbortSignal.timeout(30_000),
      });
      const body = await r.json().catch(() => ({}));
      log(`  ${label}`, `HTTP ${r.status} ${body?.ok ? `ok sources=${body.sources?.length ?? 0}` : `error="${body?.error ?? '?'}"`}`);
    }
  }
  server.close();
}

console.log('[ifr:done]');
