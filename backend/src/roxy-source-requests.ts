import type { BackendConfig } from './config.js';
import { isSafeUpstreamUrl } from './security.js';
import { describeFailure } from './sources/net-tap.js';
import { APPROVED_SOURCES } from './sources/index.js';

/**
 * Operator-only website checks. These are not playback or stream tests.
 *
 * The rows come from the source manifest, so a provider that is not mounted
 * cannot appear here — the list used to be hand-written, which is how the panel
 * ended up offering checks for sources that had been removed months earlier.
 */
export function roxySourceWebsites(_cfg: BackendConfig) {
  return APPROVED_SOURCES.flatMap((source) =>
    source.website
      ? [{ id: source.id, name: source.website.name, source: source.id, url: source.website.url, enabled: true }]
      : [],
  );
}

export async function requestSourceWebsite(site: ReturnType<typeof roxySourceWebsites>[number]) {
  const start = Date.now();
  // Only configured, public HTTP(S) URLs are allowed; never follow redirects.
  if (!isSafeUpstreamUrl(site.url)) return { id: site.id, error: 'Invalid or unsafe configured URL', ms: 0 };
  try {
    const response = await fetch(site.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Elfura-Roxy/1.0)', Accept: 'text/html,*/*' } });
    await response.body?.cancel().catch(() => {});
    return { id: site.id, status: response.status, ms: Date.now() - start };
  } catch (error) {
    // Same vocabulary as the resolve log: a bare "TypeError" hides which of DNS,
    // TCP, TLS or the challenge page actually failed, and those need different
    // answers. `describeFailure` walks the .cause chain for the real code.
    const e = error as Error;
    const reason = e.name === 'TimeoutError' ? 'Timed out after 8 seconds' : describeFailure(error);
    return { id: site.id, error: reason, ms: Date.now() - start };
  }
}
