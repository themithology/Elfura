/**
 * Elfura Player — Config resolution
 * =================================
 *
 * Three input channels converge on one PlayerConfig. Precedence is deliberate
 * and documented, because "why did my config not apply?" is the #1 support
 * question for any embeddable player.
 *
 *   BOOT (once, before the engine starts)
 *     1. DEFAULTS               from PARAM_SCHEMA
 *     2. stored preferences     localStorage (audio lang, subtitle style)
 *     3. JS / SDK config        ElfuraPlayer.create(el, {...})
 *     4. URL query params       win — the URL is the shareable, debuggable,
 *                               canonical statement of intent for an embed
 *
 *   RUNTIME (after boot)
 *     5. postMessage commands   mutate live state only
 *     6. user interaction       UI clicks / keyboard / drag
 *
 * 4 beats 3 on purpose: a publisher pasting ?lang=hi into an iframe URL is
 * making a more specific claim than a generic SDK default. Escape hatch for
 * self-hosted use: `ignoreUrlParams: true` in the JS config.
 *
 * 5/6 never rewrite boot config — they write to a separate live-state layer so
 * `getState()` can report both "what was asked for" and "what is now true".
 */

import {
  PARAM_SCHEMA,
  parseParams,
  parseStyleString,
  type ParseIssue,
} from './params';
import { DEFAULT_SUB_STYLE, mergeStyle, loadStoredStyle, type SubtitleStyle } from '../subs/style';
import { loadPreferredAudio } from './audio';

export interface ElfuraConfig {
  /* source */
  src?: string;
  type?: 'auto' | 'hls' | 'dash' | 'mp4';
  tmdb?: string;
  anilist?: string;
  anilistEpisode?: number;
  mediaType?: 'movie' | 'tv';
  season?: number;
  episode?: number;
  source?: string;
  api?: string;
  poster?: string;
  title?: string;
  servers?: { lang: string; label?: string; url: string }[];
  server?: string;

  /* playback */
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
  t?: number;
  speed?: number;
  volume?: number;
  quality?: string;
  intro?: { lang: string; url: string }[];
  outro?: { lang: string; url: string }[];
  next?: string;

  /* audio */
  lang?: string;
  audioTracks?: { lang: string; label?: string; url: string }[];
  audioSwapMode?: 'seamless' | 'reload';
  persistAudio?: boolean;

  /* subtitles */
  subtitles?: boolean;
  sublang?: string;
  subsrc?: { lang: string; label?: string; url: string }[];
  substyle?: string | Record<string, unknown>;
  persistSubs?: boolean;

  /* ui */
  color?: string;
  controls?: boolean;
  keyboard?: boolean;
  skipStep?: number;
  back?: boolean;
  episodeSelector?: boolean;
  autoplayNextEp?: boolean;
  brand?: string;
  skin?: 'dark' | 'light' | 'auto';

  /* embed */
  origin?: string;
  postMessage?: boolean;
  debug?: boolean;
  ignoreUrlParams?: boolean;

  /* security */
  pltoken?: string;
  nonce?: string;
}

export interface ResolvedInput {
  config: Required<Pick<ElfuraConfig, 'type' | 'mediaType' | 'season' | 'episode' | 'api' | 'autoplay' | 'muted' | 'loop' | 'speed' | 'volume' | 'quality' | 'audioSwapMode' | 'persistAudio' | 'subtitles' | 'persistSubs' | 'color' | 'controls' | 'keyboard' | 'back' | 'episodeSelector' | 'autoplayNextEp' | 'skin' | 'postMessage' | 'debug'>> & ElfuraConfig;
  /** Fully resolved subtitle style, after defaults -> stored -> ?substyle. */
  subtitleStyle: SubtitleStyle;
  /** Everything that was rejected/clamped, for ?debug and the demo panel. */
  issues: ParseIssue[];
  /** Provenance per key: which channel supplied the winning value. */
  provenance: Record<string, 'default' | 'stored' | 'js' | 'url' | 'redacted'>;
  /** Canonical keys explicitly present in the URL. */
  urlSeen: Set<string>;
}

const SCHEMA_DEFAULTS = (() => {
  const d: Record<string, unknown> = {};
  for (const s of PARAM_SCHEMA) if (s.default !== undefined) d[s.key] = s.default;
  return d;
})();

function parsePathnameMedia(pathname: string): Partial<ElfuraConfig> {
  const clean = pathname.replace(/\/+$/, '');
  const movieMatch = clean.match(/^(?:\/embed)?\/movie\/([A-Za-z0-9_-]+)$/);
  if (movieMatch) {
    return { mediaType: 'movie', tmdb: movieMatch[1] };
  }
  const tvMatch = clean.match(/^(?:\/embed)?\/tv\/([A-Za-z0-9_-]+)\/(\d+)\/(\d+)$/);
  if (tvMatch) {
    return {
      mediaType: 'tv',
      tmdb: tvMatch[1],
      season: Math.max(1, Number(tvMatch[2]) || 1),
      episode: Math.max(1, Number(tvMatch[3]) || 1),
    };
  }
  return {};
}

export function resolveInput(
  js: ElfuraConfig = {},
  search = window.location.search,
  pathname = window.location.pathname,
): ResolvedInput {
  const issues: ParseIssue[] = [];
  const provenance: Record<string, 'default' | 'stored' | 'js' | 'url' | 'redacted'> = {};

  const merged: Record<string, unknown> = { ...SCHEMA_DEFAULTS };
  for (const k of Object.keys(merged)) provenance[k] = 'default';

  // 2. stored preferences
  const storedAudio = loadPreferredAudio();
  if (storedAudio && js.lang === undefined) {
    merged.__storedAudio = storedAudio;
  }
  const storedStyle = loadStoredStyle();

  // 2.5 SSR / Backend boot payload (`window.__ELFURA_BOOT__`)
  const boot =
    typeof window !== 'undefined'
      ? (window as unknown as { __ELFURA_BOOT__?: Partial<ElfuraConfig> }).__ELFURA_BOOT__
      : undefined;
  if (boot && typeof boot === 'object') {
    for (const [k, v] of Object.entries(boot)) {
      if (v === undefined) continue;
      merged[k] = v;
      provenance[k] = 'js';
    }
  }

  // 3. JS config
  for (const [k, v] of Object.entries(js)) {
    if (v === undefined) continue;
    merged[k] = v;
    provenance[k] = 'js';
  }

  // 4. URL pathname + query params (win unless ignoreUrlParams: true)
  const urlSearch = merged.ignoreUrlParams ? '' : search;
  if (!merged.ignoreUrlParams) {
    const pathConfig = parsePathnameMedia(pathname);
    for (const [k, v] of Object.entries(pathConfig)) {
      if (v === undefined) continue;
      merged[k] = v;
      provenance[k] = 'url';
    }
  }
  const parsed = parseParams(new URLSearchParams(urlSearch));
  issues.push(...parsed.issues);
  for (const [k, v] of Object.entries(parsed.config)) {
    if (!parsed.seen.has(k)) continue; // defaults only — do not clobber JS config
    merged[k] = v;
    provenance[k] = 'url';
  }

  // Normalize `?type=movie|tv` into `mediaType` while keeping container `type` valid
  if (merged.type === 'movie' || merged.type === 'tv') {
    if (!parsed.seen.has('mediaType')) merged.mediaType = merged.type;
    merged.type = 'auto';
  } else if (
    !parsed.seen.has('mediaType') &&
    (parsed.seen.has('season') || parsed.seen.has('episode')) &&
    merged.tmdb
  ) {
    merged.mediaType = 'tv';
  }
  if (merged.anilist && !parsed.seen.has('mediaType') && !parsed.seen.has('type') && js.mediaType === undefined) {
    merged.mediaType = 'tv';
  }

  // Backward compatibility: `?source=https://...` treated as `src`
  if (typeof merged.source === 'string' && !merged.src && /^(?:https?:\/\/|blob:|\/)/i.test(merged.source)) {
    merged.src = merged.source;
    delete merged.source;
  }

  // Security params must never leak into logs or the debug panel.
  const config = { ...(merged as ElfuraConfig & Record<string, unknown>) } as ElfuraConfig & Record<string, unknown>;
  delete config.__storedAudio;
  for (const k of Object.keys(config)) {
    const spec = PARAM_SCHEMA.find((s) => s.key === k);
    if (spec?.group === 'security') provenance[k] = 'redacted';
  }

  // Subtitle style: defaults -> stored -> ?substyle / js.substyle
  const stylePatch =
    typeof config.substyle === 'string' ? parseStyleString(config.substyle) : (config.substyle as Record<string, unknown>) ?? {};
  const styleResult = mergeStyle(
    mergeStyle(DEFAULT_SUB_STYLE, storedStyle as unknown as Record<string, unknown>).style,
    stylePatch,
  );
  issues.push(
    ...styleResult.issues.map((i) => ({
      key: String(i.key),
      raw: String(i.from),
      message: `subtitle style clamped to ${String(i.to)}`,
    })),
  );

  // Apply the audio preference floor: stored value only if nothing explicit.
  if (!config.lang && merged.__storedAudio) config.lang = String(merged.__storedAudio);

  return {
    config: config as ResolvedInput['config'],
    subtitleStyle: styleResult.style,
    issues,
    provenance: provenance as ResolvedInput['provenance'],
    urlSeen: parsed.seen,
  };
}

/** Public docs payload — the demo page renders this as the parameter table. */
export function schemaDocs() {
  return PARAM_SCHEMA.map((s) => ({
    key: s.key,
    aliases: s.aliases ?? [],
    type: s.type,
    choices: s.choices ?? [],
    default: s.default,
    desc: s.desc,
    example: s.example,
    group: s.group,
  }));
}
