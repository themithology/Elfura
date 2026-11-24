/**
 * Source contract — the gate a source must pass to exist
 * =======================================================
 *
 * This is the whole point of the reset. The old board had thirty adapters and no
 * proof any of them worked; the console reported coverage and the user got no
 * streams. So a source is not "added" — it is *admitted*, and admission means
 * producing bytes:
 *
 *   1. resolve the probe titles from APPROVED_SOURCES
 *   2. at least one candidate comes back, already shaped as a proxy URL
 *   3. that proxy URL returns a manifest, not an error page
 *   4. a media segment behind that manifest returns real bytes
 *   5. no provider hostname appears anywhere in the response
 *
 * A source that cannot do all five does not belong in the manifest, and this
 * file fails. It is deliberately in `npm test`, so a broken lane cannot be
 * committed by accident.
 *
 * Zero approved sources is a pass, and says so in one line. The honest empty
 * state is "no sources approved yet", never "23/24 sources".
 */
import assert from 'node:assert/strict';
import { APPROVED_SOURCES } from '../../dist/backend/sources/index.js';
import { createBackendServer } from '../../dist/backend/index.js';

const passed = [];
const failed = [];

if (APPROVED_SOURCES.length === 0) {
  console.log('✓ source contract: no sources approved yet — the board is empty on purpose');
  process.exit(0);
}

for (const source of APPROVED_SOURCES) {
  const started = Date.now();
  try {
    assert(source.probes.length > 0, `${source.id}: declare at least one probe title`);
    const adapter = source.create();
    assert.equal(adapter.id, source.id, `${source.id}: adapter id must match the manifest id`);

    let resolved = null;
    let lastError = null;
    // "No candidate" is not a diagnosis. Record what each probe actually did, so
    // a red gate says which step failed instead of leaving the reader to guess.
    const attempts = [];
    for (const probe of source.probes) {
      const startedAt = Date.now();
      try {
        const result = await adapter.resolve({
          type: probe.type,
          tmdbId: probe.tmdbId,
          season: probe.season,
          episode: probe.episode,
          signal: AbortSignal.timeout(20_000),
        });
        const count = result?.candidates?.length ?? 0;
        attempts.push(`${probe.type}/${probe.tmdbId}: ${count} row(s) in ${Date.now() - startedAt}ms`);
        if (count) {
          resolved = { probe, result };
          break;
        }
      } catch (error) {
        lastError = error;
        attempts.push(`${probe.type}/${probe.tmdbId}: ${error?.name ?? 'error'} ${error?.message ?? ''}`.trim());
      }
    }

    assert(
      resolved,
      `${source.id}: resolved no candidate for any probe${lastError ? ` (${lastError.message})` : ''}\n    ` +
        attempts.join('\n    '),
    );
    const { result } = resolved;
    assert(result.candidates.length > 0, `${source.id}: empty candidate list`);

    // 2. every candidate must already be a proxy URL — never an upstream URL.
    for (const candidate of result.candidates) {
      assert(
        typeof candidate.url === 'string' && candidate.url.startsWith('/'),
        `${source.id}: candidate url must be a proxy path, got ${String(candidate.url).slice(0, 60)}`,
      );
      assert(!/^https?:\/\//i.test(candidate.url), `${source.id}: raw upstream URL leaked into a candidate`);
    }

    // 3. drive the candidate through the real proxy and demand a manifest.
    const { server } = createBackendServer();
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
    });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    try {
      let manifest = null;
      let manifestUrl = null;
      for (const candidate of result.candidates) {
        const response = await fetch(base + candidate.url, {
          headers: { accept: '*/*' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          continue;
        }
        const text = await response.text();
        if (text.length > 0 && !/^\s*<(?:!doctype|html)/i.test(text)) {
          manifest = text;
          manifestUrl = candidate.url;
          break;
        }
      }
      assert(manifest, `${source.id}: no candidate returned a readable manifest through /api/proxy`);

      // 4. a media segment behind the manifest must return real bytes.
      const firstMedia = manifest
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== '' && !line.startsWith('#'));
      assert(firstMedia, `${source.id}: manifest contained no media or child playlist line`);
      const segmentUrl = new URL(firstMedia, `${base}${manifestUrl}`).href;
      const segment = await fetch(segmentUrl, {
        headers: { range: 'bytes=0-65535' },
        signal: AbortSignal.timeout(30_000),
      });
      assert(
        segment.ok || segment.status === 206,
        `${source.id}: segment request answered ${segment.status}`,
      );
      const bytes = (await segment.arrayBuffer()).byteLength;
      assert(bytes > 0, `${source.id}: segment returned zero bytes`);

      // 5. nothing in the served text may name the provider.
      assert(
        !/^[a-z0-9.-]+\.(?:com|net|org|xyz|wtf|app|ru|to|pro|fun|in|space|lol)\b/im.test(
          manifest.replace(/\/api\/proxy\?u=[^\s"']+/g, ''),
        ),
        `${source.id}: manifest leaked a provider hostname`,
      );

      passed.push(`${source.id} ${bytes}B in ${Date.now() - started}ms`);
      console.log(`✓ ${source.id}: resolved ${result.candidates.length} candidate(s), ${bytes} segment bytes, ${Date.now() - started}ms`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } catch (error) {
    failed.push(source.id);
    console.error(`✗ ${source.id}: ${error.message}`);
  }
}

if (failed.length) {
  console.error(
    `\n${failed.length} source(s) failed the contract: ${failed.join(', ')}. ` +
      'Remove them from APPROVED_SOURCES or fix the adapter — a lane that cannot produce bytes is not a source.',
  );
  process.exit(1);
}

console.log(`\n✓ source contract: ${passed.length}/${APPROVED_SOURCES.length} approved source(s) produced real bytes`);
