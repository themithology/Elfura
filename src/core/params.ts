/**
 * Elfura Player — Input Schema
 * ============================
 *
 * ONE declarative table is the single source of truth for:
 *   1. URL param parsing   (aliases, coercion, clamping)
 *   2. Runtime validation  (bad input -> warn + fall back to default, never throw)
 *   3. Defaults            (used to build the resolved config)
 *   4. Generated docs      (see demo/schema-table.ts -> /#params)
 *
 * Nothing else in the codebase parses a query string. If you want a new knob,
 * you add one row here and it immediately works in the URL, the JS SDK, and
 * the postMessage API (which is just `setConfig` with the same keys).
 */

export type ParamType =
  | 'string'
  | 'boolean'
  | 'number'
  | 'int'
  | 'time'
  | 'color'
  | 'enum'
  | 'stringlist'
  | 'pairlist';

export interface ParamSpec {
  /** Canonical config key. Also the postMessage / SDK name. */
  key: string;
  /** Accepted URL aliases. `key` itself is always accepted. */
  aliases?: string[];
  type: ParamType;
  /** For `enum`. */
  choices?: readonly string[];
  /** For `number` / `int`. */
  min?: number;
  max?: number;
  /** Default value. Omitted => key absent from config unless supplied. */
  default?: unknown;
  /** Short human description, surfaced in the generated docs table. */
  desc: string;
  /** Example value for docs. */
  example?: string;
  /** Grouping for the docs table. */
  group: 'source' | 'playback' | 'audio' | 'subtitles' | 'ui' | 'embed' | 'security';
}

/* ------------------------------------------------------------------ */
/* Coercion helpers                                                    */
/* ------------------------------------------------------------------ */

/** "90" | "1:30" | "01:02:03" | "1h2m3s" | "90s"  ->  seconds (number) */
export function parseTime(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // hh:mm:ss(.ms)  or  mm:ss
  if (s.includes(':')) {
    const parts = s.split(':').map((p) => p.trim());
    if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
    if (parts.length > 3) return null;
    return parts.reduce<number>((acc, p) => acc * 60 + Number(p), 0);
  }

  // 1h2m3s / 2m / 90s
  const hms = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) {
    return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0);
  }

  // bare seconds
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

/** "00b4ff" | "#00b4ff" | "FF00B4FF" (ARGB) -> "#rrggbb" (lowercase) or null */
export function parseColor(raw: string): string | null {
  let s = raw.trim().replace(/^#/, '');
  // Tolerate ARGB/AARRGGBB which some embed builders emit.
  if (s.length === 8) s = s.slice(2);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.toLowerCase()}`;
}

/** Loose truthiness for URL params: absent means "not specified". */
export function parseBool(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', ''].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return true; // garbage -> treat as present/true, documented behaviour
}

export function parseStringList(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

export interface LangPair {
  lang: string;
  label?: string;
  url: string;
}

/**
 * "hi:https://cdn/x.m4a,en:https://cdn/y.m4a"
 *   -> [{lang:'hi',url:'...'},{lang:'en',url:'...'}]
 * Also accepts "hi:Hindi:https://..." for an explicit display label.
 * A bare "https://..." (no colon prefix) is accepted as {lang:'und'}.
 */
export function parsePairList(raw: string): LangPair[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((entry) => {
      // Split on ':' but keep the URL intact (it contains "://").
      const m = entry.match(/^([a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*)(?::([^:/]*))?:\/\/?(.+)$/);
      if (m) {
        const [, lang, label, rest] = m;
        const hadScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(entry.slice(entry.indexOf(':') + 1));
        return { lang: lang.toLowerCase(), label: label || undefined, url: hadScheme ? rest : rest };
      }
      const parts = entry.split(/:(?![/\\])/);
      if (parts.length >= 2 && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(parts[0])) {
        const url = parts.slice(parts.length === 3 ? 2 : 1).join(':');
        return {
          lang: parts[0].toLowerCase(),
          label: parts.length === 3 ? parts[1] : undefined,
          url,
        };
      }
      return { lang: 'und', url: entry };
    });
}

/* ------------------------------------------------------------------ */
/* The schema                                                          */
/* ------------------------------------------------------------------ */

export const PARAM_SCHEMA: readonly ParamSpec[] = [
  /* ------------------------------ source ------------------------- */
  {
    key: 'src',
    aliases: ['url', 'stream'],
    type: 'string',
    group: 'source',
    desc: 'Direct media URL. HLS (.m3u8), DASH (.mpd) or progressive (.mp4/.webm). Optional when `tmdb` is supplied.',
    example: 'https://cdn.example.com/movie/master.m3u8',
  },
  {
    key: 'type',
    aliases: ['format'],
    type: 'enum',
    choices: ['auto', 'hls', 'dash', 'mp4', 'movie', 'tv'],
    default: 'auto',
    group: 'source',
    desc: 'Container/protocol (`auto|hls|dash|mp4`), or media kind (`movie|tv`) when resolving via `tmdb`.',
    example: 'hls',
  },
  {
    key: 'tmdb',
    aliases: ['tmdbid', 'id'],
    type: 'string',
    group: 'source',
    desc: 'TMDB ID resolved through the uniform `/api/v1/playback` backend endpoint.',
    example: '278',
  },
  {
    key: 'mediaType',
    aliases: ['mediatype', 'kind'],
    type: 'enum',
    choices: ['movie', 'tv'],
    default: 'movie',
    group: 'source',
    desc: 'TMDB content type (`movie` or `tv`). Automatically set to `tv` when `/tv/:id/:s/:e` path is used.',
    example: 'movie',
  },
  {
    key: 'season',
    aliases: ['s'],
    type: 'int',
    min: 1,
    max: 200,
    default: 1,
    group: 'source',
    desc: 'Season number (1-based) for `tv` playback.',
    example: '1',
  },
  {
    key: 'episode',
    aliases: ['e', 'ep'],
    type: 'int',
    min: 1,
    max: 5000,
    default: 1,
    group: 'source',
    desc: 'Episode number (1-based) for `tv` playback.',
    example: '1',
  },
  {
    key: 'source',
    aliases: ['provider'],
    type: 'string',
    group: 'source',
    desc: 'Preferred uniform source id (e.g. `source-1`), or legacy alias for `src` when given a URL.',
    example: 'source-1',
  },
  {
    key: 'api',
    type: 'string',
    default: '/api/v1/playback',
    group: 'source',
    desc: 'Uniform playback resolution endpoint URL.',
    example: '/api/v1/playback',
  },
  {
    key: 'poster',
    type: 'string',
    group: 'source',
    desc: 'Poster image shown before playback starts.',
  },
  {
    key: 'title',
    type: 'string',
    group: 'source',
    desc: 'Title shown in the top bar and used for the document title in fullscreen.',
  },
  {
    key: 'servers',
    type: 'pairlist',
    group: 'source',
    desc: 'Ordered fallback servers as `id:URL` pairs. The player walks down the list on fatal error and emits `server:switch`.',
    example: 'primary:https://a/x.m3u8,mirror:https://b/x.m3u8',
  },
  {
    key: 'server',
    type: 'string',
    group: 'source',
    desc: 'Pin a specific server id from `servers`. Disables auto-failover until the user overrides it.',
  },

  /* ----------------------------- playback ------------------------ */
  {
    key: 'autoplay',
    type: 'boolean',
    default: false,
    group: 'playback',
    desc: 'Begin playback on load. Browsers block unmuted autoplay, so the player retries muted and emits `autoplay:blocked`.',
    example: '1',
  },
  {
    key: 'muted',
    type: 'boolean',
    default: false,
    group: 'playback',
    desc: 'Start muted. Implied when autoplay is blocked.',
  },
  {
    key: 'loop',
    type: 'boolean',
    default: false,
    group: 'playback',
    desc: 'Loop the media.',
  },
  {
    key: 't',
    aliases: ['start', 'starttime', 'seek'],
    type: 'time',
    group: 'playback',
    desc: 'Start position. Accepts seconds, mm:ss, hh:mm:ss or 1h2m3s.',
    example: '1:30:00',
  },
  {
    key: 'speed',
    type: 'number',
    min: 0.25,
    max: 4,
    default: 1,
    group: 'playback',
    desc: 'Initial playback rate.',
    example: '1.5',
  },
  {
    key: 'volume',
    type: 'number',
    min: 0,
    max: 1,
    default: 1,
    group: 'playback',
    desc: 'Initial volume, 0..1.',
    example: '0.8',
  },
  {
    key: 'quality',
    aliases: ['maxquality'],
    type: 'string',
    default: 'auto',
    group: 'playback',
    desc: '`auto` or a height cap in pixels (e.g. 1080). Caps ABR without pinning an exact level.',
    example: '1080',
  },
  {
    key: 'intro',
    type: 'pairlist',
    group: 'playback',
    desc: 'Intro range as `start:end` in seconds; renders a coloured segment on the scrubber plus a Skip button.',
    example: '0:52',
  },
  {
    key: 'outro',
    type: 'pairlist',
    group: 'playback',
    desc: 'Outro range as `start:end` in seconds.',
    example: '1500:1560',
  },
  {
    key: 'next',
    type: 'string',
    group: 'playback',
    desc: 'URL to auto-advance to when the outro begins (or on ended).',
  },

  /* ------------------------------- audio ------------------------- */
  {
    key: 'lang',
    aliases: ['audio', 'audiolang', 'audiotrack'],
    type: 'string',
    group: 'audio',
    desc: 'Preferred audio language as a BCP-47 tag. Matched exactly first, then by primary subtag (`hi-IN` satisfies `hi`).',
    example: 'hi',
  },
  {
    key: 'audioTracks',
    aliases: ['dub', 'dubs', 'externalaudio'],
    type: 'pairlist',
    group: 'audio',
    desc: 'External per-language audio files (`lang:URL` pairs) merged into the track list alongside manifest-native tracks. Used for separately-hosted dubs.',
    example: 'hi:https://cdn/hi.m4a,ta:https://cdn/ta.m4a',
  },
  {
    key: 'audioSwapMode',
    type: 'enum',
    choices: ['seamless', 'reload'],
    default: 'seamless',
    group: 'audio',
    desc: 'How external (non-manifest) audio is applied. `seamless` keeps the clock running and swaps the element src; `reload` re-inits the engine.',
  },
  {
    key: 'persistAudio',
    type: 'boolean',
    default: true,
    group: 'audio',
    desc: 'Remember the chosen audio language in localStorage and apply it to future titles.',
  },

  /* ----------------------------- subtitles ----------------------- */
  {
    key: 'subtitles',
    aliases: ['subs', 'captions'],
    type: 'boolean',
    default: true,
    group: 'subtitles',
    desc: 'Master switch for the subtitle renderer.',
  },
  {
    key: 'sublang',
    aliases: ['subtitlelang', 'cc'],
    type: 'string',
    group: 'subtitles',
    desc: 'Preferred subtitle language (BCP-47). Same matching rules as `lang`.',
    example: 'en',
  },
  {
    key: 'subsrc',
    aliases: ['subtitle', 'subtitlesrc', 'vtt'],
    type: 'pairlist',
    group: 'subtitles',
    desc: 'External subtitle tracks as `lang:URL` pairs. WebVTT, SRT and ASS/SSA are all parsed client-side.',
    example: 'en:https://cdn/en.vtt,hi:https://cdn/hi.srt',
  },
  {
    key: 'substyle',
    type: 'string',
    group: 'subtitles',
    desc: 'Compact style preset, applied under the default style. `k:v|k:v` form, e.g. `size:115|color:#ffe|bgOpacity:0`.',
    example: 'size:115|color:#ffd54a',
  },
  {
    key: 'persistSubs',
    type: 'boolean',
    default: true,
    group: 'subtitles',
    desc: 'Remember the user subtitle style in localStorage and reuse it across titles and embeds on this origin.',
  },

  /* -------------------------------- ui --------------------------- */
  {
    key: 'color',
    aliases: ['accent', 'accentcolor', 'theme'],
    type: 'color',
    default: '#ff5c39',
    group: 'ui',
    desc: 'Accent colour. Drives scrubber fill, active states, skip badges and focus rings; derived shades are computed automatically.',
    example: '00b4ff',
  },
  {
    key: 'controls',
    type: 'boolean',
    default: true,
    group: 'ui',
    desc: 'Show the control bar. With `0` the player is chrome-less and driven only by the postMessage API.',
  },
  {
    key: 'keyboard',
    type: 'boolean',
    default: true,
    group: 'ui',
    desc: 'Enable keyboard shortcuts (space, arrows, f, m, c, s, 0-9).',
  },
  {
    key: 'skipStep',
    aliases: ['seekstep', 'jump'],
    type: 'int',
    min: 1,
    max: 120,
    default: 10,
    group: 'ui',
    desc: 'Seconds for the +/- seek buttons and the arrow keys. The buttons hide themselves when the title is shorter than two steps.',
    example: '30',
  },
  {
    key: 'back',
    type: 'boolean',
    default: true,
    group: 'ui',
    desc: 'Show a back button in the top bar while player UI is visible; posts a `back` message to the parent (or navigates back when standalone).',
  },
  {
    key: 'episodeSelector',
    type: 'boolean',
    default: false,
    group: 'ui',
    desc: 'Show the episode strip. Episodes are supplied by the host via postMessage.',
  },
  {
    key: 'autoplayNextEp',
    type: 'boolean',
    default: false,
    group: 'ui',
    desc: 'Auto-advance into the next episode during the outro / on ended.',
  },
  {
    key: 'brand',
    aliases: ['branding'],
    type: 'string',
    group: 'ui',
    desc: 'Wordmark shown in the top-right of the player.',
  },
  {
    key: 'skin',
    type: 'enum',
    choices: ['dark', 'light', 'auto'],
    default: 'dark',
    group: 'ui',
    desc: 'Control chrome colour scheme.',
  },

  /* ------------------------------- embed ------------------------- */
  {
    key: 'origin',
    aliases: ['parentorigin'],
    type: 'string',
    group: 'embed',
    desc: 'Parent origin allowed to receive postMessage events and issue commands. Auto-detected from document.referrer when omitted.',
  },
  {
    key: 'postMessage',
    aliases: ['pm', 'events'],
    type: 'boolean',
    default: true,
    group: 'embed',
    desc: 'Emit lifecycle events to the parent frame.',
  },
  {
    key: 'debug',
    type: 'boolean',
    default: false,
    group: 'embed',
    desc: 'Log input resolution and engine activity to the console.',
  },

  /* ----------------------------- security ------------------------ */
  {
    key: 'pltoken',
    aliases: ['token', 'sig'],
    type: 'string',
    group: 'security',
    desc: 'Signed playback token minted by your backend. Opaque to the player — it is forwarded verbatim on the manifest request and never logged.',
  },
  {
    key: 'nonce',
    type: 'string',
    group: 'security',
    desc: 'Single-use replay nonce accompanying `pltoken`.',
  },
] as const;

/* ------------------------------------------------------------------ */
/* Lookup indexes (built once)                                         */
/* ------------------------------------------------------------------ */

const BY_KEY = new Map<string, ParamSpec>();
const ALIAS_TO_KEY = new Map<string, string>();

for (const spec of PARAM_SCHEMA) {
  BY_KEY.set(spec.key, spec);
  ALIAS_TO_KEY.set(spec.key.toLowerCase(), spec.key);
  for (const a of spec.aliases ?? []) ALIAS_TO_KEY.set(a.toLowerCase(), spec.key);
}

export function specFor(urlKey: string): ParamSpec | undefined {
  const canonical = ALIAS_TO_KEY.get(urlKey.toLowerCase());
  return canonical ? BY_KEY.get(canonical) : undefined;
}

export const CANONICAL_KEYS = [...BY_KEY.keys()] as string[];

export interface ParseIssue {
  key: string;
  raw: string;
  message: string;
}

export interface ParseResult<T = Record<string, unknown>> {
  config: T;
  issues: ParseIssue[];
  /** Which canonical keys were explicitly present in the input. */
  seen: Set<string>;
}

function coerce(spec: ParamSpec, raw: string, issues: ParseIssue[], key: string): unknown {
  const fail = (msg: string): undefined => {
    issues.push({ key, raw, message: msg });
    return undefined;
  };

  switch (spec.type) {
    case 'string':
      return raw;

    case 'boolean':
      return parseBool(raw);

    case 'number':
    case 'int': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return fail('not a number');
      let out = spec.type === 'int' ? Math.round(n) : n;
      if (spec.min !== undefined && out < spec.min) out = spec.min;
      if (spec.max !== undefined && out > spec.max) out = spec.max;
      return out;
    }

    case 'time': {
      const t = parseTime(raw);
      if (t === null) return fail('not a time (try 90, 1:30, 01:02:03 or 1h2m3s)');
      return Math.max(0, t);
    }

    case 'color': {
      const c = parseColor(raw);
      if (!c) return fail('not a hex colour');
      return c;
    }

    case 'enum': {
      const v = raw.trim().toLowerCase();
      const choices = spec.choices ?? [];
      if (!choices.includes(v)) return fail(`expected one of ${choices.join(' | ')}`);
      return v;
    }

    case 'stringlist':
      return parseStringList(raw);

    case 'pairlist':
      return parsePairList(raw);
  }
}

/** Parse a URLSearchParams (or plain object) into a partial config. */
export function parseParams(
  input: URLSearchParams | Record<string, string>,
): ParseResult {
  const params =
    input instanceof URLSearchParams
      ? input
      : new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)]));

  const out: Record<string, unknown> = {};
  const issues: ParseIssue[] = [];
  const seen = new Set<string>();

  // Defaults first.
  for (const spec of PARAM_SCHEMA) {
    if (spec.default !== undefined) out[spec.key] = spec.default;
  }

  // Last-one-wins for repeated params, which matches URLSearchParams semantics.
  for (const [urlKey, raw] of params.entries()) {
    const spec = specFor(urlKey);
    if (!spec) {
      issues.push({ key: urlKey, raw, message: 'unknown parameter (ignored)' });
      continue;
    }
    const value = coerce(spec, raw, issues, spec.key);
    if (value !== undefined) {
      out[spec.key] = value;
      seen.add(spec.key);
    }
  }

  return { config: out, issues, seen };
}

/** Parse only the `substyle` mini-language into a partial SubtitleStyle. */
export function parseStyleString(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw) return out;
  for (const chunk of raw.split('|')) {
    const idx = chunk.indexOf(':');
    if (idx < 1) continue;
    const k = chunk.slice(0, idx).trim();
    const v = chunk.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}
