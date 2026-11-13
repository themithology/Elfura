import type { BackendConfig } from './config.js';
import { isSafeUpstreamUrl } from './security.js';

/** Operator-only website checks. These are not playback or stream tests. */
export function roxySourceWebsites(cfg: BackendConfig) {
  return [
    { id: 'vidbolt', name: 'VidBolt', source: 'Source 1', url: cfg.source1.vidboltOrigin || 'https://vidbolt.xyz', enabled: cfg.source1.enabled },
    { id: 'vidrift', name: 'VidRift', source: 'Source 2', url: cfg.source1.riftOrigin, enabled: cfg.source1.enabled },
    { id: 'vidrock', name: 'VidRock', source: 'Source 2', url: cfg.source1.vidrockOrigin || 'https://vidrock.net', enabled: cfg.source1.enabled },
    ...(cfg.source8?.enabled ? [{ id: 'vidzee', name: 'VidZee', source: 'Source 8', url: 'https://vidzee.wtf', enabled: true }] : []),
    ...(cfg.source14?.enabled ? [{ id: 'citadel', name: 'Rive Citadel', source: 'Source 14', url: 'https://www.rivestream.app', enabled: true }] : []),
    ...(cfg.source18?.enabled ? [{ id: 'embed69', name: 'Embed69', source: 'Source 18', url: 'https://embed69.org', enabled: true }] : []),
    ...(cfg.stremioAddons ?? []).map((url, index) => ({ id: `stremio-${index + 1}`, name: `Stremio add-on ${index + 1}`, source: 'Source 17', url, enabled: true })),
  ];
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
    const e = error as Error & { cause?: { code?: string } };
    const reason = e.name === 'TimeoutError' ? 'Timed out after 8 seconds' : e.cause?.code || e.name || 'Request failed';
    return { id: site.id, error: reason, ms: Date.now() - start };
  }
}
