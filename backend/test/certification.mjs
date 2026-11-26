/**
 * Age-rating metadata is a viewer-facing fact, not decoration.
 *
 * Movies carry certifications in `release_dates.results[]`; TV carries one
 * rating per country in `content_ratings.results[]`. The player shows a card
 * only when the catalogue actually supplied a value, so this test pins both the
 * extraction and the "never invent one" behaviour.
 */
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.TMDB_DISABLE_FALLBACK = '1';
const { fetchTmdbMetadata } = await import('../../dist/backend/tmdb.js');

const fixtures = {
  '/3/movie/550': {
    id: 550, title: 'Brand New Day', release_date: '2026-07-31', overview: 'A new day.',
    vote_average: 8.1, runtime: 145, images: { logos: [] },
    release_dates: {
      results: [
        { iso_3166_1: 'GB', release_dates: [{ certification: '12A' }] },
        { iso_3166_1: 'US', release_dates: [{ certification: '' }, { certification: 'PG-13' }] },
        { iso_3166_1: 'IN', release_dates: [{ certification: 'UA' }] },
      ],
    },
  },
  '/3/movie/551': {
    id: 551, title: 'Local Release', release_date: '2025-01-10', overview: '',
    images: { logos: [] },
    release_dates: {
      results: [
        { iso_3166_1: 'US', release_dates: [{ certification: '' }] },
        { iso_3166_1: 'IN', release_dates: [{ certification: 'UA 13+' }] },
      ],
    },
  },
  '/3/movie/552': {
    id: 552, title: 'Unrated Feature', release_date: '2024-03-01', overview: '',
    images: { logos: [] },
  },
  '/3/movie/553': {
    id: 553, title: 'No US Rating', release_date: '2022-05-01', overview: '',
    images: { logos: [] },
    release_dates: {
      results: [
        { iso_3166_1: 'US', release_dates: [{ certification: 'NR' }] },
        { iso_3166_1: 'GB', release_dates: [{ certification: '15' }] },
      ],
    },
  },
  '/3/tv/100': {
    id: 100, name: 'Night Shift', first_air_date: '2024-09-01', overview: '',
    images: { logos: [] },
    content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-14' }] },
  },
  '/3/tv/101': {
    id: 101, name: 'Quiet Show', first_air_date: '2023-02-01', overview: '',
    images: { logos: [] },
    content_ratings: { results: [{ iso_3166_1: 'US', rating: '' }] },
  },
};

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const body = fixtures[path];
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { status_message: 'Not found' }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const cfg = {
  apiBase: `http://127.0.0.1:${server.address().port}/3`,
  apiKey: 'test',
  bearerToken: '',
  imageBase: 'https://image.tmdb.org/t/p',
  timeoutMs: 2000,
};

try {
  const movie = await fetchTmdbMetadata(cfg, { type: 'movie', tmdbId: '550' });
  assert.equal(movie.certification, 'PG-13', 'US classification wins over GB/IN');
  assert.equal(movie.runtime, 145, 'runtime travels with the same response');

  const regional = await fetchTmdbMetadata(cfg, { type: 'movie', tmdbId: '551' });
  assert.equal(regional.certification, 'UA 13+', 'falls through an empty US entry to the next country');

  const unrated = await fetchTmdbMetadata(cfg, { type: 'movie', tmdbId: '552' });
  assert.equal(unrated.certification, undefined, 'no source data means no badge, never a guessed rating');

  const notRated = await fetchTmdbMetadata(cfg, { type: 'movie', tmdbId: '553' });
  assert.equal(notRated.certification, '15', 'a "not rated" label is not a rating worth showing');

  const tv = await fetchTmdbMetadata(cfg, { type: 'tv', tmdbId: '100' });
  assert.equal(tv.certification, 'TV-14');

  const tvEmpty = await fetchTmdbMetadata(cfg, { type: 'tv', tmdbId: '101' });
  assert.equal(tvEmpty.certification, undefined);

  console.log('certification: movie/TV extraction, regional fallback and absence all passed');
} finally {
  server.close();
}
