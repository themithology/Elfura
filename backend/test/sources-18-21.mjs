import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { pngCarriesTransportStream, sniffMediaBytes, unwrapPngTransportStream } from '../../dist/backend/sources/media-sniff.js';
import { catalogVariants, fetchFromSubDub, renditionsFromPayload } from '../../dist/backend/sources/source18.js';
import { parseEmbedServers, parseEpisodeLinks, searchDesiDub } from '../../dist/backend/sources/source19.js';
import { fetchFromVidora, vidoraCandidates } from '../../dist/backend/sources/source20.js';
import { parseCards, parseDlButtons, parseSeasonFiles } from '../../dist/backend/sources/source21.js';

/* ── media sniffing (Source 8 PNG-wrapped transport streams) ─────────────── */

function chunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload, Buffer.alloc(4)]);
}

function pngWithTs(tsBytes) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tsDa', tsBytes),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const tsPayload = Buffer.alloc(188 * 2);
tsPayload[0] = 0x47;
tsPayload[188] = 0x47;
const wrapped = pngWithTs(tsPayload);
assert.equal(pngCarriesTransportStream(wrapped), true);
assert.equal(sniffMediaBytes(wrapped), 'png-wrapped-ts');
assert.deepEqual(Buffer.from(unwrapPngTransportStream(wrapped)), tsPayload.slice(0, 188 * 2));

const plainPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', Buffer.alloc(13)),
  chunk('IDAT', Buffer.alloc(16)),
  chunk('IEND', Buffer.alloc(0)),
]);
assert.equal(sniffMediaBytes(plainPng), 'png-image', 'a real image must never be treated as media');
assert.equal(unwrapPngTransportStream(plainPng), null);

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
assert.equal(sniffMediaBytes(jpeg), 'jpeg-image');
assert.equal(sniffMediaBytes(tsPayload), 'mpeg-ts');
assert.equal(sniffMediaBytes(Buffer.from('<!doctype html>')), 'unknown');

/* ── Source 18: SubDubAnime renditions ───────────────────────────────────── */

const hlsRow = {
  dataId: 'abc123XY',
  format: 'M3U8',
  quality: '480p',
  ranges: '0-100 (480p)\n101-200 (1080p)\n201-300 (720p)',
};
const hlsCandidates = renditionsFromPayload(hlsRow);
assert.equal(hlsCandidates.length, 3);
assert.equal(hlsCandidates[0].quality, '1080p');
assert.match(hlsCandidates[0].url, /^https:\/\/hugh\.cdn\.rumble\.cloud\/video\/abc123XY\.haa\.tar\?/);
assert.match(hlsCandidates[0].url, /r_range=101-200$/);
assert.equal(hlsCandidates[0].type, 'hls');

const mp4Candidates = renditionsFromPayload({ dataId: 'mp4File01', format: 'MP4', qid: 3 });
assert.equal(mp4Candidates.length, 3);
assert.equal(mp4Candidates[0].type, 'mp4');
assert.match(mp4Candidates[0].url, /\.caa\.mp4$/, 'qid 3 caps the ladder at 480p');

assert.deepEqual(renditionsFromPayload({ dataId: '../../evil' }), []);
assert.deepEqual(renditionsFromPayload({ dataId: 'nested/../evil', format: 'MP4', qid: 2 }), [], 'no traversal segments');
assert.deepEqual(renditionsFromPayload({ dataId: 'a//b', format: 'MP4' }), [], 'no empty segments');
const nested = renditionsFromPayload({ dataId: 'streams/2025/abc', format: 'M3U8', ranges: '0-10 (720p)' });
assert.equal(nested.length, 1, 'provider ids may be slash-separated paths');
assert.match(nested[0].url, /\/video\/streams\/2025\/abc\.gaa\.tar\?/);
assert.deepEqual(renditionsFromPayload(null), []);

const catalog = {
  movies: {
    '000438631': { tmdbId: '000438631', originalTmdbId: '438631', language: 'Hindi Dubbed', title: 'Dune (Hindi)' },
  },
  series: {
    '0010070': { tmdbId: '0010070', originalTmdbId: '10070', language: 'English', title: 'Example' },
  },
  dramas: {},
};
assert.equal(catalogVariants(catalog, 'movie', '438631').length, 1);
assert.equal(catalogVariants(catalog, 'tv', '10070').length, 1);
assert.equal(catalogVariants(catalog, 'movie', '999').length, 0);

/* ── Source 18 live path with mocked upstream ────────────────────────────── */

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'blakiteapi.xyz' && url.pathname === '/api/get.php') {
    return Response.json({ data: { dataId: 'live0001', format: 'M3U8', ranges: '0-10 (720p)' } });
  }
  if (url.hostname === 'blakiteapi.xyz' && url.pathname === '/api/getAllAnime.php') {
    return Response.json({ success: true, data: catalog });
  }
  throw new Error(`unexpected host ${url.hostname}`);
};
try {
  const rows = await fetchFromSubDub({ type: 'movie', tmdbId: '438631' });
  assert.equal(rows.length, 1, 'base payload lane');
  assert.equal(rows[0].quality, '720p');
} finally {
  globalThis.fetch = originalFetch;
}

/* ── Source 19: DesiDubAnime parsing + AES Streamp2p ─────────────────────── */

const embedHtml =
  `<span data-embed-id="${Buffer.from('Streamp2p').toString('base64')}:` +
  `${Buffer.from('https://desidubanime.p2pplay.pro/#vid42').toString('base64')}"></span>` +
  `<span data-embed-id="${Buffer.from('VidMoly').toString('base64')}:` +
  `${Buffer.from('https://vidmoly.to/embed-xyz.html').toString('base64')}"></span>`;
const servers = parseEmbedServers(embedHtml);
assert.equal(servers.length, 2);
assert.equal(servers[0].name, 'Streamp2p');
assert.equal(servers[0].url, 'https://desidubanime.p2pplay.pro/#vid42');

const episodeHtml =
  `<a class="episode-list-item" href="/watch/one-piece-episode-5/" data-episode-search-query="5">` +
  `<span class="episode-list-item-number">5</span></a>` +
  `<a class="episode-list-item" href="/watch/one-piece-episode-6/" data-episode-search-query="6"></a>`;
const episodes = parseEpisodeLinks(episodeHtml, 'https://www.desidubanime.me/');
assert.deepEqual(episodes.map((e) => e.number), [5, 6]);
assert.equal(episodes[0].url, 'https://www.desidubanime.me/watch/one-piece-episode-5/');

// Streamp2p payload: AES-128-CBC hex with the provider key/iv.
const p2pJson = JSON.stringify({
  title: 'One Piece (Hindi) 1080p',
  cfNative: 'https://cdn.example/one-piece/master.m3u8',
  source: 'https://cdn2.example/one-piece/master.m3u8',
  subtitle: { en: 'https://cdn.example/sub/en.vtt' },
});
const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from('kiemtienmua911ca'), Buffer.from('1234567890oiuytr'));
const hex = Buffer.concat([cipher.update(p2pJson, 'utf8'), cipher.final()]).toString('hex');
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.themoviedb.org' || url.hostname === 'www.desidubanime.me') {
    if (url.pathname === '/wp-json/wp/v2/anime') {
      return Response.json([
        { link: 'https://www.desidubanime.me/anime/one-piece/', title: { rendered: 'One Piece (Hindi Dub)' } },
      ]);
    }
    return new Response('not html', { status: 200 });
  }
  if (url.pathname === '/api/v1/video') return new Response(hex);
  throw new Error(`unexpected host ${url.hostname}`);
};
try {
  const match = await searchDesiDub('One Piece', AbortSignal.timeout(2000));
  assert.equal(match?.link, 'https://www.desidubanime.me/anime/one-piece/');
} finally {
  globalThis.fetch = originalFetch;
}

/* ── Source 20: Vidora payload ───────────────────────────────────────────── */

const vidoraBody = {
  result: true,
  sources: [
    {
      url: 'https://cdn.vidora.example/hls/master.m3u8',
      tracks: [
        { file: 'https://cdn.vidora.example/sub/en.vtt', label: 'English' },
        { file: 'https://cdn.vidora.example/sub/evil.exe', label: 'Broken' },
      ],
    },
    { url: 'https://video/not-a-manifest.mp4' },
  ],
};
const vidoraRows = vidoraCandidates(vidoraBody);
assert.equal(vidoraRows.length, 1, 'only HTTPS HLS masters are accepted');
assert.equal(vidoraRows[0].type, 'hls');
assert.equal(vidoraRows[0].subtitles.length, 1);
assert.equal(vidoraRows[0].subtitles[0].lang, 'en');
assert.deepEqual(vidoraCandidates({ sources: 'nope' }), []);

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'moviesapi.to') {
    assert.equal(url.pathname, '/api/vidora/v1/tv/1396/1/2');
    return Response.json(vidoraBody);
  }
  throw new Error('unexpected host');
};
try {
  const rows = await fetchFromVidora({ type: 'tv', tmdbId: '1396', season: 1, episode: 2 });
  assert.equal(rows.length, 1);
  assert.deepEqual(await fetchFromVidora({ type: 'tv', tmdbId: '1396', season: 0, episode: 2 }), []);
} finally {
  globalThis.fetch = originalFetch;
}

/* ── Source 21: KMMovies HTML parsing ────────────────────────────────────── */

const cardHtml =
  '<article class="movie-card" aria-label="Dune: Part Two (2024)">' +
  '<a href="/dune-part-two-2024/">Dune</a></article>' +
  '<article class="movie-card" aria-label="Dune (2021)">' +
  '<a href="/dune-2021/">Dune</a></article>';
const cards = parseCards(cardHtml, 'https://kmmovies.beer');
assert.equal(cards.length, 2);
assert.equal(cards[0].url, 'https://kmmovies.beer/dune-part-two-2024/');

const dlHtml =
  '<a href="https://one.kmcloud.lol/s/FileAbc123" class="dl-btn">' +
  '<span class="dl-res">1080p</span><span class="dl-size">2.1 GB</span></a>' +
  '<a href="https://magiclinks.lol/x" class="dl-btn"><span class="dl-res">720p</span></a>';
const files = parseDlButtons(dlHtml);
assert.equal(files.length, 1, 'non-KMCLOUD buttons are ignored');
assert.equal(files[0].origin, 'https://one.kmcloud.lol');
assert.equal(files[0].id, 'FileAbc123');
assert.equal(files[0].label, '1080p · 2.1 GB');

const seasonHtml =
  '<div id="download-links">' +
  '<div class="season-block open ">' +
  '<span class="season-block-title">Season 2 (8 eps)</span>' +
  '<div data-type="combined-2"><a href="https://one.kmcloud.lol/s/SeasonTwo" class="dl-btn">' +
  '<span class="dl-res">720p</span></a></div></div>' +
  '<div class="season-block">' +
  '<span class="season-block-title">Season 1 (10 eps)</span>' +
  '<div data-type="combined-1"><a href="https://one.kmcloud.lol/s/SeasonOne" class="dl-btn">' +
  '<span class="dl-res">1080p</span></a></div></div>' +
  '</div>';
const seasons = parseSeasonFiles(seasonHtml);
assert.equal(seasons.size, 2);
assert.equal(seasons.get(2)[0].id, 'SeasonTwo');
assert.equal(seasons.get(1)[0].id, 'SeasonOne');

/* ── Registry toggles ────────────────────────────────────────────────────── */

const on = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'test' }));
const ids = on.listPublicSources().map((source) => source.id);
for (const id of ['source-18', 'source-19', 'source-20']) {
  assert(ids.includes(id), `${id} should be enabled by default`);
}
assert(!ids.includes('source-21'), 'Source 21 is opt-in until KMCLOUD shares return');
const off = new SourceRegistry(
  loadBackendConfig({
    ELFURA_SECRET: 'test',
    ELFURA_SUBDUB_ENABLED: '0',
    ELFURA_DESIDUB_ENABLED: '0',
    ELFURA_VIDORA_ENABLED: '0',
    ELFURA_KMMOVIES_ENABLED: '0',
  }),
);
const offIds = off.listPublicSources().map((source) => source.id);
for (const id of ['source-18', 'source-19', 'source-20']) {
  assert(!offIds.includes(id), `${id} should honour its opt-out flag`);
}
const optIn = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'test', ELFURA_KMMOVIES_ENABLED: '1' }));
assert(optIn.listPublicSources().some((source) => source.id === 'source-21'), 'Source 21 enables when asked');
for (const id of ['source-18', 'source-19', 'source-20', 'source-21']) {
  const entry = optIn.listPublicSources().find((source) => source.id === id)
    ?? on.listPublicSources().find((source) => source.id === id);
  assert(entry && /^Source \d+$/.test(entry.label), `${id} keeps a generic label`);
}

console.log('✓ Sources 18-21 payload parsing, AES lane, bounded HTML parsing, opt-out flags and PNG-wrapped TS sniffing');
