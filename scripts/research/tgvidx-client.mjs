#!/usr/bin/env node
/**
 * A minimal TGVIDX client for research probes.
 *
 * The retired adapter at backend/attic/sources/source17.ts implements this, but
 * importing it from a probe fails: attic is not compiled, and its own imports
 * (`../security.js`) were rewritten when the adapter moved there, so the module
 * cannot load. The same trap already cost one runner job on nxsha. Rather than
 * patch retired code to stay loadable, the ~50 lines that matter live here.
 *
 * The protocol is wire obfuscation, not authentication:
 *   POST /_serverFn/<hash>  → a TanStack envelope
 *   → reverse the base64, XOR with a public client constant, parse JSON
 *
 * Both the function hash and the transform can change when the site deploys.
 * When that happens this client returns null rather than inventing rows -- a
 * silent wrong answer is worse than a loud empty one.
 */
const ORIGIN = 'https://tgvidx.lovable.app';
const RPC =
  '/_serverFn/ff183e1ad6d02c4c08e8e73151c60e5dcc23f8f4c9db53eac9d271b87a56e121';
const PUBLIC_TRANSFORM = 'tGfL1x#9vQ';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const MAX_BYTES = 1_000_000;

/** Decode a TGVIDX reply. Exported so a mismatch can be tested without a network. */
export function decode(text) {
  try {
    const envelope = JSON.parse(text);
    const root = envelope?.p;
    if (envelope?.t !== 10 || !Array.isArray(root?.k) || !Array.isArray(root?.v)) return null;
    const result = root.v[root.k.indexOf('result')];
    const nested = result?.p;
    if (result?.t !== 10 || !Array.isArray(nested?.k) || !Array.isArray(nested?.v)) return null;
    const encoded = nested.v[nested.k.indexOf('p')];
    if (encoded?.t !== 1 || typeof encoded?.s !== 'string' || encoded.s.length > MAX_BYTES) return null;
    if (!/^[A-Za-z0-9+/=_-]+$/.test(encoded.s)) return null;
    const bytes = Buffer.from(encoded.s.split('').reverse().join(''), 'base64');
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] ^= PUBLIC_TRANSFORM.charCodeAt(i % PUBLIC_TRANSFORM.length) ^ (i & 255);
    }
    const decoded = JSON.parse(bytes.toString('utf8'));
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Every row TGVIDX lists for one title, before any filtering. */
export async function inventory({ type, tmdbId, season, episode }, { timeout = 20_000 } = {}) {
  const path =
    type === 'movie' ? `/api/m/${tmdbId}` : `/api/tv/${tmdbId}/${season ?? 1}/${episode ?? 1}`;
  const request = {
    t: { t: 10, i: 0, p: { k: ['data'], v: [{ t: 10, i: 1, p: { k: ['path'], v: [{ t: 1, s: path }] }, o: 0 }] }, o: 0 },
    f: 127,
    m: [],
  };
  let response;
  try {
    response = await fetch(ORIGIN + RPC, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-tsr-serverfn': 'true',
        'User-Agent': UA,
        Referer: `${ORIGIN}/`,
        Origin: ORIGIN,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    return { rows: [], error: `${error?.name}: ${error?.message}`.slice(0, 120) };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { rows: [], error: `http=${response.status}` };
  }
  const text = await response.text();
  const data = decode(text);
  if (!data) return { rows: [], error: 'undecodable (the RPC hash or transform may have rotated)' };
  if (data.ok !== true || !Array.isArray(data.links)) {
    return { rows: [], error: `payload ok=${String(data.ok)} links=${Array.isArray(data.links) ? data.links.length : 'none'}` };
  }
  return { rows: data.links, error: null };
}

/** The media URL in a row, or null. */
export function mediaUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
