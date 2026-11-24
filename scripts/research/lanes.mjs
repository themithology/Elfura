/**
 * The lanes worth measuring, and how each one is actually reached.
 *
 * Every entry here was taken from an adapter that was retired on 2026-11-24
 * (backend/attic/sources/), so these are observed endpoints, not guesses. The
 * point of the file is that the research harness can be pointed at reality:
 * `attempts()` returns the requests a plain HTTP adapter would have to make, in
 * order, and `browser` names the page a headless browser should open when those
 * are not enough.
 *
 * `need` is what the harness must find to call the lane reachable at all:
 *   'media'  — an HLS/DASH manifest or MP4 URL
 *   'json'   — a JSON body (the adapter would parse it further)
 *
 * Nothing here is registered with the backend. This is measurement.
 */

/** Probe titles. AniList ids are only needed by the anime lanes. */
export const TITLES = [
  { key: 'movie-550', type: 'movie', tmdbId: '550', label: 'Fight Club' },
  { key: 'movie-27205', type: 'movie', tmdbId: '27205', label: 'Inception' },
  { key: 'tv-1399-1-1', type: 'tv', tmdbId: '1399', season: 1, episode: 1, label: 'Game of Thrones S1E1' },
  { key: 'anime-46260-1-1', type: 'tv', tmdbId: '46260', season: 1, episode: 1, anilistId: '20', label: 'Naruto S1E1' },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const base = (href) => {
  try {
    return new URL(href).origin;
  } catch {
    return '';
  }
};

const browserHeaders = (origin) => ({
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: `${origin}/`,
});

const apiHeaders = (origin) => ({
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: `${origin}/`,
  Origin: origin,
});

export const LANES = [
  /* ── direct JSON APIs: cheapest possible adapter, no page involved ─────── */
  {
    id: 'greybox',
    label: 'Greybox',
    origin: 'https://greyboxtv.duckdns.org',
    kind: 'json-api',
    need: 'media',
    note: 'plain JSON, no token; source-25 recorded /api/player/sources',
    attempts: (t) => {
      const q = new URLSearchParams({ media: t.type, id: t.tmdbId });
      if (t.type === 'tv') {
        q.set('season', String(t.season ?? 1));
        q.set('episode', String(t.episode ?? 1));
      }
      return [{ url: `https://greyboxtv.duckdns.org/api/player/sources?${q}`, headers: apiHeaders('https://greyboxtv.duckdns.org') }];
    },
  },
  {
    id: 'rivestream-citadel',
    label: 'RiveStream (citadel)',
    origin: 'https://scrapper.rivestream.app',
    kind: 'json-api',
    need: 'media',
    note: 'source-14: /api/provider?provider=citadel&id=<tmdb> answered in ~200ms',
    attempts: (t) => [
      {
        url: `https://scrapper.rivestream.app/api/provider?provider=citadel&id=${t.tmdbId}${
          t.type === 'tv' ? `&season=${t.season ?? 1}&episode=${t.episode ?? 1}` : ''
        }`,
        headers: apiHeaders('https://www.rivestream.app'),
      },
    ],
  },
  {
    id: 'vidlink',
    label: 'VidLink',
    origin: 'https://vidlink.pro',
    kind: 'json-api',
    need: 'media',
    note: 'source-24: /api/b/movie/<tmdb> is real JSON; token dance via enc-dec.app',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://vidlink.pro/api/b/movie/${t.tmdbId}`
            : `https://vidlink.pro/api/b/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: apiHeaders('https://vidlink.pro'),
      },
    ],
  },

  /* ── page HTML with a token or a signed URL inside ────────────────────── */
  {
    id: 'vixsrc',
    label: 'VixSrc',
    origin: 'https://vixsrc.to',
    kind: 'html-token',
    need: 'media',
    note: 'source-9: /api/movie/<tmdb> -> {src:"/embed/..."} -> token+expires+url in HTML',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://vixsrc.to/api/movie/${t.tmdbId}`
            : `https://vixsrc.to/api/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: apiHeaders('https://vixsrc.to'),
      },
    ],
    browser: (t) => `https://vixsrc.to/embed/movie/${t.tmdbId}`,
  },
  {
    id: 'bingr',
    label: 'Bingr',
    origin: 'https://bingr.st',
    kind: 'next-page',
    need: 'json',
    note: 'source-4: /watch/movie/<tmdb> page -> /api/sources (server ids are dynamic)',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://bingr.st/watch/movie/${t.tmdbId}`
            : `https://bingr.st/watch/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: browserHeaders('https://bingr.st'),
      },
    ],
    browser: (t) =>
      t.type === 'movie'
        ? `https://bingr.st/watch/movie/${t.tmdbId}`
        : `https://bingr.st/watch/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
  },
  {
    id: 'mapple',
    label: 'Mapple',
    origin: 'https://mapple.fun',
    kind: 'token-chain',
    need: 'media',
    note: 'source-15: /watch/movie/<tmdb> -> request-token -> playback-init -> stream-encrypted',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://mapple.fun/watch/movie/${t.tmdbId}`
            : `https://mapple.fun/watch/tv/${t.tmdbId}-${t.season ?? 1}-${t.episode ?? 1}`,
        headers: browserHeaders('https://mapple.fun'),
      },
    ],
    browser: (t) =>
      t.type === 'movie'
        ? `https://mapple.fun/watch/movie/${t.tmdbId}`
        : `https://mapple.fun/watch/tv/${t.tmdbId}-${t.season ?? 1}-${t.episode ?? 1}`,
  },
  {
    id: 'vidsync',
    label: 'VidSync',
    origin: 'https://vidsync.pro',
    kind: 'json-api',
    need: 'media',
    note: 'source-3: /api/stream and /api/core/streams',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://vidsync.pro/api/stream?type=movie&tmdb=${t.tmdbId}`
            : `https://vidsync.pro/api/stream?type=tv&tmdb=${t.tmdbId}&season=${t.season ?? 1}&episode=${t.episode ?? 1}`,
        headers: apiHeaders('https://vidsync.pro'),
      },
    ],
    // No recorded page path for this protocol; the API is the lane.
    browser: () => null,
  },
  {
    id: 'vidzen',
    label: 'VidZen',
    origin: 'https://vidzen.fun',
    kind: 'next-page',
    need: 'json',
    note: 'source-12: server list -> opaque /api/stream/ URLs',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://vidzen.fun/watch/movie/${t.tmdbId}`
            : `https://vidzen.fun/watch/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: browserHeaders('https://vidzen.fun'),
      },
    ],
    browser: (t) =>
      t.type === 'movie'
        ? `https://vidzen.fun/watch/movie/${t.tmdbId}`
        : `https://vidzen.fun/watch/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
  },
  {
    id: 'vidnest',
    label: 'VidNest',
    origin: 'https://vidnest.fun',
    kind: 'next-page',
    need: 'json',
    note: 'source-10: per-lane encrypted API, six lanes',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://vidnest.fun/movie/${t.tmdbId}`
            : `https://vidnest.fun/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: browserHeaders('https://vidnest.fun'),
      },
    ],
    browser: (t) =>
      t.type === 'movie'
        ? `https://vidnest.fun/movie/${t.tmdbId}`
        : `https://vidnest.fun/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
  },
  {
    id: 'vidzee',
    label: 'VidZee',
    origin: 'https://core.vidzee.wtf',
    kind: 'json-api',
    need: 'media',
    note: 'source-8: core.vidzee.wtf server endpoints (dcloud, tik, ipcloud, v6)',
    attempts: (t) => [
      {
        url: `https://core.vidzee.wtf/embed/${t.type}/${t.tmdbId}${
          t.type === 'tv' ? `/${t.season ?? 1}/${t.episode ?? 1}` : ''
        }`,
        headers: apiHeaders('https://core.vidzee.wtf'),
      },
    ],
    browser: (t) => `https://player.vidzee.wtf/embed/${t.type}/${t.tmdbId}`,
  },

  /* ── anime lanes, AniList-keyed ───────────────────────────────────────── */
  {
    id: 'novuscloud',
    label: 'NovusCloud',
    origin: 'https://novuscloud.buzz',
    kind: 'embed-resolve',
    need: 'media',
    note: 'source-29: /embed/ani/<anilist>/<ep>/<lane> exposes resolve:"<signed api>"; page says "Embedded playback only"',
    animeOnly: true,
    attempts: (t) =>
      t.anilistId
        ? [
            {
              url: `https://novuscloud.buzz/embed/ani/${t.anilistId}/${t.episode ?? 1}/sub?k=1`,
              headers: browserHeaders('https://novuscloud.buzz'),
            },
          ]
        : [],
    browser: (t) => (t.anilistId ? `https://novuscloud.buzz/embed/ani/${t.anilistId}/${t.episode ?? 1}/sub` : null),
  },
  {
    id: 'megaplay',
    label: 'MegaPlay',
    origin: 'https://megaplay.buzz',
    kind: 'js-player',
    need: 'media',
    note: 'source-30: /stream/ani/<anilist>/<ep>/<mode>, media discovered by page JS',
    animeOnly: true,
    attempts: () => [],
    browser: (t) => (t.anilistId ? `https://megaplay.buzz/stream/ani/${t.anilistId}/${t.episode ?? 1}/sub` : null),
  },
  {
    id: 'mikaza',
    label: 'Mikaza',
    origin: 'https://mikaza.buzz',
    kind: 'embed-resolve',
    need: 'media',
    note: 'source-16: /embed/haiku/ani/<anilist>/<ep>/<lang> exposes a resolve URL',
    animeOnly: true,
    attempts: (t) =>
      t.anilistId
        ? [
            {
              url: `https://mikaza.buzz/embed/haiku/ani/${t.anilistId}/${t.episode ?? 1}/jpn`,
              headers: browserHeaders('https://mikaza.buzz'),
            },
          ]
        : [],
    browser: (t) => (t.anilistId ? `https://mikaza.buzz/embed/haiku/ani/${t.anilistId}/${t.episode ?? 1}/jpn` : null),
  },
  {
    id: 'animesalt',
    label: 'AnimeSalt (Ravok)',
    origin: 'https://ravok.buzz',
    kind: 'js-player',
    need: 'media',
    note: 'source-28: catalogue on animesalt.cx -> ravok.buzz player/index.php POST',
    animeOnly: true,
    attempts: () => [],
    browser: (t) => (t.anilistId ? `https://animesalt.cx/watch/${t.anilistId}` : null),
  },

  /* ── the two big aggregators ─────────────────────────────────────────── */
  {
    id: 'vidbolt',
    label: 'VidBolt (source-1 family)',
    origin: 'https://vidbolt.xyz',
    kind: 'js-player',
    need: 'media',
    note: 'source-1: vidbolt/vidrift/vidrock. The biggest lane on the old board.',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://vidbolt.xyz/embed/movie/${t.tmdbId}`
            : `https://vidbolt.xyz/embed/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: browserHeaders('https://vidbolt.xyz'),
      },
    ],
    browser: (t) =>
      t.type === 'movie'
        ? `https://vidbolt.xyz/embed/movie/${t.tmdbId}`
        : `https://vidbolt.xyz/embed/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
  },
  {
    id: 'tgvidx',
    label: 'TGVIDX',
    origin: 'https://tgvidx.lovable.app',
    kind: 'js-player',
    need: 'media',
    note: 'source-17: dynamic server inventory, aggregates other upstreams',
    attempts: (t) => [
      {
        url: `https://tgvidx.lovable.app/?type=${t.type}&tmdb=${t.tmdbId}${
          t.type === 'tv' ? `&s=${t.season ?? 1}&e=${t.episode ?? 1}` : ''
        }`,
        headers: browserHeaders('https://tgvidx.lovable.app'),
      },
    ],
    browser: (t) =>
      `https://tgvidx.lovable.app/embed?type=${t.type}&tmdb=${t.tmdbId}${
        t.type === 'tv' ? `&season=${t.season ?? 1}&episode=${t.episode ?? 1}` : ''
      }`,
  },
  {
    id: 'xpass',
    label: 'Xpass',
    origin: 'https://freakyniki.elaxo.lol',
    kind: 'signed-proxy',
    need: 'media',
    note: 'source-13: signed /proxyv2; NOTE its recorded player host player-4aq.pages.dev no longer resolves',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://player-4aq.pages.dev/embed/movie/${t.tmdbId}`
            : `https://player-4aq.pages.dev/embed/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: browserHeaders('https://player-4aq.pages.dev'),
      },
    ],
    browser: (t) =>
      t.type === 'movie'
        ? `https://player-4aq.pages.dev/embed/movie/${t.tmdbId}`
        : `https://player-4aq.pages.dev/embed/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
  },
  {
    id: 'nxsha',
    label: 'Nxsha',
    origin: 'https://nxsha.space',
    kind: 'js-player',
    need: 'media',
    note: 'source-5: scraper inventory (bkl-blast, rive, screenscape, ...)',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://nxsha.space/watch/movie/${t.tmdbId}`
            : `https://nxsha.space/watch/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: browserHeaders('https://nxsha.space'),
      },
    ],
    browser: (t) =>
      t.type === 'movie'
        ? `https://nxsha.space/watch/movie/${t.tmdbId}`
        : `https://nxsha.space/watch/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
  },
  {
    id: 'blakite',
    label: 'Blakite',
    origin: 'https://blakiteapi.xyz',
    kind: 'json-api',
    need: 'media',
    note: 'source-18: catalogue -> hugh.cdn.rumble.cloud HLS/MP4 (direct CDN)',
    attempts: (t) => [
      {
        url: `https://blakiteapi.xyz/api/getAllAnime.php`,
        headers: apiHeaders('https://blakiteapi.xyz'),
      },
      {
        url: `https://blakiteapi.xyz/api/get.php?tmdb=${t.tmdbId}&type=${t.type}`,
        headers: apiHeaders('https://blakiteapi.xyz'),
      },
    ],
  },
  {
    id: 'vidora',
    label: 'Vidora (moviesapi)',
    origin: 'https://moviesapi.to',
    kind: 'js-player',
    need: 'media',
    note: 'source-20: MoviesAPI -> paretocdn.site or a worker relay',
    attempts: (t) => [
      {
        url:
          t.type === 'movie'
            ? `https://moviesapi.to/movie/${t.tmdbId}`
            : `https://moviesapi.to/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
        headers: browserHeaders('https://moviesapi.to'),
      },
    ],
    browser: (t) =>
      t.type === 'movie'
        ? `https://moviesapi.to/movie/${t.tmdbId}`
        : `https://moviesapi.to/tv/${t.tmdbId}/${t.season ?? 1}/${t.episode ?? 1}`,
  },
  {
    id: 'watchout',
    label: 'Watchout',
    origin: 'https://vidout.pages.dev',
    kind: 'json-api',
    need: 'media',
    note: 'source-21: catalogue on jsDelivr/GitHub raw -> episode media host',
    attempts: () => [
      {
        url: 'https://cdn.jsdelivr.net/gh/aliwahan/watchout@main/db.json',
        headers: apiHeaders('https://cdn.jsdelivr.net'),
      },
    ],
    browser: () => 'https://vidout.pages.dev/',
  },
];

/** Lanes that apply to a given probe title. */
export function lanesFor(title) {
  return LANES.filter((lane) => !lane.animeOnly || title.anilistId);
}

export { base, UA };
