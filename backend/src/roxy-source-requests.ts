import type { BackendConfig } from './config.js';
import { isSafeUpstreamUrl } from './security.js';

/** Operator-only website checks. These are not playback or stream tests. */
export function roxySourceWebsites(cfg: BackendConfig) {
  const citadelEnabled = cfg.source14?.enabled ?? (process.env.ELFURA_RIVE_CITADEL_ENABLED !== '0');
  const mappleEnabled = cfg.source15?.enabled ?? (process.env.ELFURA_MAPPLE_ENABLED !== '0');
  const desiDubEnabled = cfg.source16?.enabled ?? (process.env.ELFURA_DESIDUB_ENABLED !== '0');
  const anikotoEnabled = cfg.source17?.enabled ?? (process.env.ELFURA_ANIKOTO_ENABLED !== '0');
  return [
    { id: 'vidbolt', name: 'VidBolt', source: 'Source 1', url: cfg.source1.vidboltOrigin || 'https://vidbolt.xyz', enabled: cfg.source1.enabled },
    { id: 'vidrift', name: 'VidRift', source: 'Source 2', url: cfg.source1.riftOrigin, enabled: cfg.source1.enabled },
    { id: 'vidrock', name: 'VidRock', source: 'Source 2', url: cfg.source1.vidrockOrigin || 'https://vidrock.net', enabled: cfg.source1.enabled },
    { id: 'vidsync', name: 'VidSync', source: 'Source 3', url: cfg.source3.origin || 'https://vidsync.pro', enabled: cfg.source3.enabled },
    { id: 'bingr', name: 'Bingr', source: 'Source 4', url: 'https://bingr.one', enabled: cfg.source4?.enabled ?? true },
    { id: 'nxsha', name: 'Nxsha', source: 'Source 5', url: 'https://nxsha.space', enabled: cfg.source5?.enabled ?? true },
    ...(cfg.source7?.enabled ? [{ id: 'screenscape', name: 'ScreenScape', source: 'Source 7', url: 'https://screenscape.me', enabled: true }] : []),
    ...(cfg.source8?.enabled ? [{ id: 'vidzee', name: 'VidZee', source: 'Source 8', url: 'https://vidzee.wtf', enabled: true }] : []),
    ...(cfg.source9?.enabled ? [{ id: 'vixsrc', name: 'VixSrc', source: 'Source 9', url: 'https://vixsrc.to', enabled: true }] : []),
    ...(cfg.source10?.enabled ? [{ id: 'vidnest', name: 'VidNest', source: 'Source 10', url: 'https://vidnest.fun', enabled: true }] : []),
    ...(cfg.source11?.enabled ? [{ id: 'vaplayer', name: 'VidAPI.ru', source: 'Source 11', url: 'https://vidapi.ru', enabled: true }] : []),
    ...(citadelEnabled
      ? [{ id: 'citadel', name: 'Rive Citadel', source: 'Source 14', url: 'https://www.rivestream.app', enabled: true }]
      : []),
    ...(mappleEnabled
      ? [{ id: 'mapple', name: 'Mapple', source: 'Source 15', url: 'https://mapple.fun', enabled: true }]
      : []),
    ...(desiDubEnabled
      ? [{ id: 'desidub', name: 'DesiDubAnime', source: 'Source 16', url: 'https://www.desidubanime.me', enabled: true }]
      : []),
    ...(anikotoEnabled
      ? [{ id: 'anikoto', name: 'Anikoto', source: 'Source 17', url: 'https://anikototv.to', enabled: true }]
      : []),
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
