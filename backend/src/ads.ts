/**
 * Pop-under ad policy
 * ===================
 * Ads exist for one reason: keeping the servers alive. They belong in exactly
 * one place — the embed player a partner site loads — and nowhere else on the
 * platform. This module owns the decision, so the same rules apply everywhere:
 *
 *  - the global switch (admin panel) turns them off for the whole install;
 *  - any embedding site can be marked ad-free individually;
 *  - localhost / private addresses never see them, so development is quiet;
 *  - the project's own domains are always exempt, without a toggle.
 *
 * The decision is made server-side, per embed request, from the referrer of the
 * page embedding the player. Nothing is injected on the catalogue, the landing
 * page, the download page or the admin panel.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The project's own sites: never carry ads, cannot be toggled on. */
export const ALWAYS_AD_FREE = ['theogpiratebot.online', 'theogpiratebot.to'];

/** Default pop-under tag; override with ELFURA_POPUNDER_SRC ('' disables ads). */
export const DEFAULT_POPUNDER_SRC = 'https://4xfreedom.com/1/120bbfb2641cdab678b85c4203ea372b';

export interface AdSettings {
  /** Master switch from the admin panel. */
  enabled: boolean;
  /** Sites (bare hosts) that must never receive the ad tag. */
  adFreeSites: string[];
}

export interface AdDecision {
  serve: boolean;
  /** Operator-facing reason; never sent to a browser. */
  reason: string;
  /** Script URL to inject, or '' when nothing should be injected. */
  src: string;
}

export function popunderSrc(): string {
  const raw = process.env.ELFURA_POPUNDER_SRC;
  if (raw === undefined) return DEFAULT_POPUNDER_SRC;
  return raw.trim();
}

/** Lower-cased bare host: no scheme, no port, no leading `www.`, no trailing dot. */
export function normalizeHost(value: unknown): string {
  let host = String(value ?? '').trim().toLowerCase();
  if (!host) return '';
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme if a URL slipped in
  host = host.split('/')[0].split('?')[0].split('#')[0];
  host = host.replace(/^.*@/, ''); // userinfo
  if (host.startsWith('[')) {
    host = host.slice(1, host.indexOf(']') === -1 ? undefined : host.indexOf(']'));
  } else if ((host.match(/:/g) ?? []).length >= 2) {
    // Bare IPv6 literal like ::1 — no port to strip.
  } else {
    host = host.split(':')[0]; // host:port
  }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  return host;
}

/** Development, LAN and container addresses: never monetised. */
export function isLocalHostname(value: unknown): boolean {
  const host = normalizeHost(value);
  if (!host) return false;
  if (host === 'localhost' || host === 'localhost.localdomain') return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** `example.com` also covers `player.example.com`. */
export function siteMatches(host: string, list: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return list.some((entry) => {
    const e = normalizeHost(entry);
    return !!e && (h === e || h.endsWith(`.${e}`));
  });
}

export function decideAds(
  args: { parentSite?: string; requestHost?: string },
  settings: AdSettings,
): AdDecision {
  const src = popunderSrc();
  if (!src) return { serve: false, reason: 'disabled by ELFURA_POPUNDER_SRC', src: '' };
  if (!settings.enabled) return { serve: false, reason: 'switched off in the admin panel', src: '' };

  const requestHost = normalizeHost(args.requestHost);
  if (isLocalHostname(requestHost)) return { serve: false, reason: `local request host ${requestHost}`, src: '' };

  const parent = normalizeHost(args.parentSite);
  if (!parent) {
    // No referrer: we cannot attribute the view to a site, and an unattributable
    // pop-under is how ad networks get banned for your whole account.
    return { serve: false, reason: 'no embedding site reported', src: '' };
  }
  if (isLocalHostname(parent)) return { serve: false, reason: `local embedding site ${parent}`, src: '' };
  if (siteMatches(parent, ALWAYS_AD_FREE)) return { serve: false, reason: `${parent} is always ad-free`, src: '' };
  if (siteMatches(parent, settings.adFreeSites)) return { serve: false, reason: `${parent} is marked ad-free`, src: '' };
  return { serve: true, reason: `ads for ${parent}`, src };
}

/** The tag itself. `data-cfasync` keeps Cloudflare Rocket Loader off it. */
export function popunderTag(src: string): string {
  if (!src) return '';
  const safe = src.replace(/["<>\\]/g, '');
  return `<script data-cfasync="false" src="${safe}" async></script>`;
}

export class AdSettingsStore {
  private settings: AdSettings;
  private file: string;

  constructor(directory = process.env.ROXY_DATA_DIR || path.join(process.cwd(), 'data')) {
    this.file = path.join(directory, 'ad-settings.json');
    this.settings = { enabled: true, adFreeSites: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AdSettings>;
      if (typeof raw.enabled === 'boolean') this.settings.enabled = raw.enabled;
      if (Array.isArray(raw.adFreeSites)) {
        this.settings.adFreeSites = raw.adFreeSites
          .map((site) => normalizeHost(site))
          .filter(Boolean)
          .slice(0, 2000);
      }
    } catch {
      /* first boot, or unreadable: defaults apply */
    }
  }

  get(): AdSettings {
    return { enabled: this.settings.enabled, adFreeSites: [...this.settings.adFreeSites] };
  }

  setEnabled(enabled: boolean): AdSettings {
    this.settings.enabled = !!enabled;
    this.flush();
    return this.get();
  }

  /** Add or remove a site. Returns the resulting settings. */
  setSiteAdFree(site: unknown, adFree: boolean): AdSettings {
    const host = normalizeHost(site);
    if (!host) return this.get();
    const set = new Set(this.settings.adFreeSites);
    if (adFree) set.add(host);
    else set.delete(host);
    this.settings.adFreeSites = [...set].sort().slice(0, 2000);
    this.flush();
    return this.get();
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      /* settings stay in memory for this boot */
    }
  }
}
