/**
 * Elfura Backend — Source 23 Adapter (browser-rendered capture)
 * =============================================================
 * Why this exists
 * ---------------
 * Several upstreams serve a working player to a real browser and nothing to a
 * backend. Measured, not assumed: on the same GitHub runner, with the same
 * source IP, `sacdn.hakunaymatata.com` returned HTTP 200 + real DASH inside
 * Chromium, and `TypeError` to a plain `fetch`. Mirroring UA, Referer, Origin
 * and every Sec-Fetch-* header made no difference — the refusal is at the TLS
 * fingerprint, which no header set can fix.
 *
 * TG FROST plays those streams fine, for exactly that reason. It is not that it
 * has better sources; it is that it *is a browser*. So the only way to depend on
 * the backend rather than on TG FROST is to run the backend in a browser, read
 * the manifest URL the player itself requests, and then hand that URL to the
 * normal pipeline.
 *
 * What this is NOT
 * ----------------
 * It is not a proxy of TG FROST and it does not embed their player. Nothing here
 * relies on their API, their relay subdomains or their availability: the page is
 * used only as a way to make the first HTTPS request from a browser context, and
 * what comes back is a plain upstream manifest we then own. If TG FROST changes
 * its embed path, this adapter returns [] at once and costs one line to fix.
 *
 * Cost and gating
 * ---------------
 * A browser process is expensive (hundreds of MB), so this lane is OFF unless
 * explicitly switched on with ELFURA_BROWSER_LANE=1. It is not in the default
 * board and it never slows a normal resolve.
 *
 * Dependencies (`playwright-core`, `@sparticuz/chromium`) are optional: they are
 * imported lazily, so a deployment that does not want this lane does not need
 * them and will not fail to boot without them.
 */

import type { BackendConfig } from '../config.js';
import { isSafeUpstreamUrl } from '../security.js';
import type { RawSourceResult, RawStreamCandidate, SourceAdapter, SourceQuery } from './types.js';

/**
 * Minimal structural types for the optional browser packages.
 *
 * They are declared here rather than imported from the packages on purpose:
 * `playwright-core` and `@sparticuz/chromium` are optional dependencies, so a
 * deployment that does not enable this lane must not have them, and the build
 * must not fail when their type declarations are absent. Only the handful of
 * members used below is described.
 */
interface BrowserResponse {
  url(): string;
  headers(): Record<string, string>;
  text(): Promise<string>;
}
interface BrowserRequest {
  url(): string;
}
interface BrowserPage {
  on(event: 'response', handler: (res: BrowserResponse) => void): void;
  on(event: 'request', handler: (req: BrowserRequest) => void): void;
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
}
interface BrowserInstance {
  newPage(options?: { userAgent?: string }): Promise<BrowserPage>;
  close(): Promise<void>;
}
interface ChromiumLauncher {
  launch(options: { executablePath: string; args: string[] }): Promise<BrowserInstance>;
}

/** Manifest URLs we are willing to lift out of a captured network call. */
const MEDIA_MANIFEST_RE = /\.(?:m3u8|mpd)(?:[?#]|$)/i;
/** A DASH/HLS playlist body must start with one of these to be worth keeping. */
const PLAYLIST_HEAD_RE = /^\s*(?:#EXTM3U|<\?xml|<MPD[\s>])/i;

/** The embed paths this lane knows how to drive. Add one line per upstream. */
const BROWSER_TARGETS: {
  id: string;
  /** Returns the page URL to open for this query, or null if not applicable. */
  url: (query: SourceQuery, base: string) => string | null;
  /** Referer that page expects when it fetches its own media. */
  referer: (base: string) => string;
}[] = [
  {
    id: 'tgfrost',
    url: (query, base) =>
      query.type === 'tv'
        ? `${base}/embed/tv/${query.tmdbId}/${query.season ?? 1}/${query.episode ?? 1}`
        : `${base}/embed/movie/${query.tmdbId}`,
    referer: (base) => `${base}/`,
  },
];

interface CapturedManifest {
  url: string;
  type: 'hls' | 'dash';
}

/**
 * Pull candidate manifest URLs out of a captured request/response pair.
 *
 * Both the request URL and a redirect/response URL are considered: players
 * commonly request a bare relay path and get redirected to the real manifest,
 * which is why matching only the request URL misses everything.
 */
function manifestsFrom(urls: string[], bodies: Map<string, string>): CapturedManifest[] {
  const out: CapturedManifest[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (!MEDIA_MANIFEST_RE.test(url)) continue;
    if (!isSafeUpstreamUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const body = bodies.get(url);
    if (body !== undefined && !PLAYLIST_HEAD_RE.test(body)) continue;
    out.push({ url, type: /\.mpd(?:[?#]|$)/i.test(url) ? 'dash' : 'hls' });
  }
  return out;
}

export function createBrowserLaneAdapter(
  lane: BackendConfig['browserLane'],
): SourceAdapter {
  return {
    id: 'source-23',
    label: 'Source 23',

    enabled: () => lane.enabled,

    async resolve(query: SourceQuery): Promise<RawSourceResult> {
      if (!lane.enabled) return { candidates: [] };

      const startedAt = Date.now();
      const diag = (ok: boolean, detail: string) =>
        query.diag?.push({
          adapter: 'source-23',
          lane: 'B',
          ok,
          ms: Date.now() - startedAt,
          detail,
        });

      let browser: BrowserInstance | null = null;
      try {
        // Lazy: a deployment without these packages must still boot. `as string`
        // keeps the module specifier opaque to the TypeScript resolver, so the
        // build never depends on an optional package being installed.
        const playwrightSpec = 'playwright-core';
        const chromiumSpec = '@sparticuz/chromium';
        let chromium: ChromiumLauncher;
        let executablePath: string;
        let launchArgs: string[];
        try {
          const playwright = (await import(playwrightSpec)) as unknown as { chromium: ChromiumLauncher };
          const binary = (await import(chromiumSpec)) as unknown as {
            default: { executablePath(): Promise<string>; args: string[] };
          };
          chromium = playwright.chromium;
          executablePath = await binary.default.executablePath();
          launchArgs = binary.default.args;
        } catch {
          diag(false, 'browser-deps-missing');
          return { candidates: [] };
        }

        const collected: CapturedManifest[] = [];

        for (const target of BROWSER_TARGETS) {
          const pageUrl = target.url(query, lane.embedOrigin);
          if (!pageUrl) continue;

          if (!browser) {
            browser = await chromium.launch({
              executablePath,
              args: [...launchArgs, '--autoplay-policy=no-user-gesture-required'],
            });
          }

          const page = await browser.newPage({ userAgent: lane.userAgent });
          const bodies = new Map<string, string>();
          const urls: string[] = [];

          page.on('response', (res: BrowserResponse) => {
            const url = res.url();
            if (MEDIA_MANIFEST_RE.test(url)) {
              urls.push(url);
              // Read the body so a relay that answers 200 with HTML cannot be
              // mistaken for a manifest. Bounded: a playlist is small.
              res
                .text()
                .then((text: unknown) => {
                  const body = String(text);
                  if (body.length <= 512 * 1024) bodies.set(url, body.slice(0, 4096));
                })
                .catch(() => {});
            }
            const location = res.headers().location;
            if (location) urls.push(new URL(location, url).href);
          });
          page.on('request', (req: BrowserRequest) => {
            const url = req.url();
            if (MEDIA_MANIFEST_RE.test(url)) urls.push(url);
          });

          try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: lane.pageTimeoutMs });
            // The player resolves server-side and then hands over; a few seconds
            // of play time is what makes it request the manifest.
            await page.waitForTimeout(lane.settleMs);
          } catch {
            /* a slow or dead page simply yields nothing */
          } finally {
            await page.close().catch(() => {});
          }

          collected.push(...manifestsFrom(urls, bodies));
        }

        // Dedupe across targets: two embeds can surface the same CDN object.
        const seen = new Set<string>();
        const candidates: RawStreamCandidate[] = [];
        for (const manifest of collected) {
          if (seen.has(manifest.url)) continue;
          seen.add(manifest.url);
          candidates.push({
            key: manifest.url,
            url: manifest.url,
            type: manifest.type,
            quality: 'auto',
            // A browser-captured stream is genuine, but it came through a relay
            // front, so it must never outrank a direct origin CDN stream.
            rank: lane.rank,
            headers: { 'User-Agent': lane.userAgent, Referer: lane.referer },
          });
        }

        diag(
          candidates.length > 0,
          candidates.length > 0
            ? `browser lanes=${BROWSER_TARGETS.length} candidates=${candidates.length}`
            : `browser lanes=${BROWSER_TARGETS.length} no-manifest captured`,
        );
        return { candidates };
      } catch (error) {
        diag(false, `browser ${(error as Error).name}`);
        return { candidates: [] };
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  };
}
