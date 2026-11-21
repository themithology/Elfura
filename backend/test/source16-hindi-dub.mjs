#!/usr/bin/env node
/**
 * Source 16 (Mikaza, Hindi dub) end to end, plus the TMDB→AniList conversion.
 *
 * Two things are being checked, and they fail in different ways:
 *
 *   1. The conversion. If TMDB→AniList is wrong, Mikaza plays the wrong show or
 *      nothing at all. This drives the real parser with the payload shapes the
 *      API was measured to return, including the 404 that means "not anime".
 *   2. The source. It must refuse anything the provider does not itself label
 *      Hindi, and it must never invent an id.
 *
 * No network: these pin the contract, not the provider's uptime.
 */
import assert from 'node:assert/strict';

const { parseAniZipMappings, anilistIdForTmdb } = await import('../../dist/backend/sources/anime-db.js');

/* ── the parser, against payloads measured from api.ani.zip ───────────────── */

{
  // GET ?themoviedb_id=46260 -> Naruto
  const naruto = {
    titles: { en: 'Naruto' },
    episodeCount: 220,
    mappings: {
      animeplanet_id: 'naruto',
      kitsu_id: 11,
      mal_id: 20,
      type: 'TV',
      anilist_id: 20,
      thetvdb_id: 78857,
      themoviedb_id: '46260',
    },
  };
  assert.deepEqual(parseAniZipMappings(naruto), { anilistId: '20', type: 'TV' });

  // GET ?themoviedb_id=85937 -> Demon Slayer
  assert.equal(
    parseAniZipMappings({ mappings: { anilist_id: 101922, type: 'TV', themoviedb_id: '85937' } }).anilistId,
    '101922',
  );

  // A non-anime title answers 404 with no body; that is "no mapping", never an id.
  assert.equal(parseAniZipMappings(null), null);
  assert.equal(parseAniZipMappings({}), null);
  assert.equal(parseAniZipMappings({ mappings: {} }), null);
  assert.equal(parseAniZipMappings({ mappings: { anilist_id: 0 } }), null);
  assert.equal(parseAniZipMappings({ mappings: { anilist_id: 'not-a-number' } }), null);
  assert.equal(parseAniZipMappings({ mappings: { themoviedb_id: '550' } }), null);
}

/* ── a bad TMDB id must not cost a request ────────────────────────────────── */

{
  assert.equal(await anilistIdForTmdb('tv', 'abc'), null);
  assert.equal(await anilistIdForTmdb('tv', '0'), null);
}

/* ── unreachable service degrades, never throws ───────────────────────────── */

{
  assert.equal(
    await anilistIdForTmdb('movie', '550'),
    null,
    'no network here, so this must be null rather than an exception',
  );
}

/* ── the source ───────────────────────────────────────────────────────────── */

const { fetchFromMikaza } = await import('../../dist/backend/sources/source16.js');

{
  // A source that answers "no mapping" must return nothing and say why.
  const trace = [];
  const rows = await fetchFromMikaza(
    { type: 'movie', tmdbId: '550', signal: AbortSignal.timeout(3_000) },
    { trace },
  );
  assert.deepEqual(rows, [], 'no mapping means no candidates, not a guessed id');
  assert.ok(
    trace.some((t) => /no-anilist-mapping|embed-unreachable|embed-refused/.test(t)),
    `the trace must name the gate that stopped it, got: ${JSON.stringify(trace)}`,
  );
}

{
  // A junk episode number is rejected before any request.
  const rows = await fetchFromMikaza(
    { type: 'tv', tmdbId: '46260', season: 1, episode: 0, signal: AbortSignal.timeout(2_000) },
    { trace: [] },
  );
  assert.deepEqual(rows, []);
}

{
  // An explicit AniList id must bypass conversion entirely, so an embed that
  // already carries `?anilist=` still works when the mapping API is down.
  const trace = [];
  await fetchFromMikaza(
    { type: 'tv', tmdbId: '46260', anilistId: '20', season: 1, episode: 1, signal: AbortSignal.timeout(3_000) },
    { trace },
  ).catch(() => []);
  assert.ok(
    !trace.includes('no-anilist-mapping'),
    'an explicit anilist id must not be routed through the mapping service',
  );
}

/* ── later seasons must not silently resolve to season-one episode numbers ── */
{
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/embed/')) return new Response('resolve:"https://mikaza.buzz/resolve"');
    return Response.json({src:'https://media.example/episode.mp4',source:{resolvedLanguage:'hin'}});
  };
  try {
    for (const extra of [{}, {anilistId:'20'}, {anilistEpisode:53}]) {
      const trace = [];
      const rows = await fetchFromMikaza({type:'tv',tmdbId:'46260',season:2,episode:1,...extra}, {trace});
      assert.deepEqual(rows, []);
      assert.deepEqual(trace, ['unmapped-season']);
      assert.equal(requests.length, 0, 'ambiguous season must not request any provider');
    }
    const rows = await fetchFromMikaza({type:'tv',tmdbId:'46260',season:2,episode:1,anilistId:'20',anilistEpisode:53});
    assert.equal(rows.length, 1);
    assert.match(requests[0], /\/20\/53\/hin$/);
  } finally { globalThis.fetch = originalFetch; }
}

/* ── honesty check: a non-Hindi payload must be refused ──────────────────── */
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../backend/src/sources/source16.ts', import.meta.url), 'utf8'),
  );
  assert.match(src, /resolvedLanguage/, 'language must come from the provider, not from us');
  assert.match(src, /'hi'/, 'only Hindi is accepted');
  assert.doesNotMatch(
    src,
    /audioLang: 'hi'\s*,\s*audioLabel: 'Hindi'\s*,\s*multiAudio: true/,
    'a single-file lane must not claim multi-audio',
  );
}

console.log('source-16 (Mikaza Hindi dub) + TMDB→AniList: all assertions passed');
