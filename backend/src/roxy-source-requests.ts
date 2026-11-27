import type { BackendConfig } from './config.js';
import { isSafeUpstreamUrl } from './security.js';
import { describeFailure } from './sources/net-tap.js';
import { APPROVED_SOURCES } from './sources/index.js';

/** Operator-only website checks — one per approved source. Playback is in registry.ts. */
export function roxySourceWebsites(_cfg: BackendConfig) {
  return APPROVED_SOURCES.map((src) => ({
    id: src.id,
    name: src.website.name,
    source: src.id,
    url: src.website.url,
    enabled: src.create().enabled(),
  }));
}

export async function requestSourceWebsite(site: ReturnType<typeof roxySourceWebsites>[number]) {
  const start = Date.now();
  if (!isSafeUpstreamUrl(site.url)) return { id: site.id, error: 'Invalid or unsafe configured URL', ms: 0 };
  try {
    const response = await fetch(site.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Elfura-Roxy/1.0)', Accept: 'text/html,*/*' },
    });
    await response.body?.cancel().catch(() => {});
    return { id: site.id, status: response.status, ms: Date.now() - start };
  } catch (error) {
    const e = error as Error;
    const reason = e.name === 'TimeoutError' ? 'Timed out after 8 seconds' : describeFailure(error);
    return { id: site.id, error: reason, ms: Date.now() - start };
  }
}
