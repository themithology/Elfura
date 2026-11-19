import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { pngCarriesTransportStream, sniffMediaBytes, unwrapPngTransportStream } from '../../dist/backend/sources/media-sniff.js';
import { catalogVariants, fetchFromSubDub, renditionsFromPayload } from '../../dist/backend/sources/source18.js';
import { fetchFromVidora, vidoraCandidates } from '../../dist/backend/sources/source20.js';

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

/* ── Registry toggles ────────────────────────────────────────────────────── */

const on = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'test' }));
const ids = on.listPublicSources().map((source) => source.id);
for (const id of ['source-18', 'source-20', 'source-21']) {
  assert(ids.includes(id), `${id} should be enabled by default`);
}
// 21 used to be reserved for the retired KMMovies lane; the number is now the
// Vidout catalogue lane, so only the retired behaviour (Cloudflare solving) must
// stay absent — nothing here depends on KMMovies.`
const off = new SourceRegistry(
  loadBackendConfig({
    ELFURA_SECRET: 'test',
    ELFURA_SUBDUB_ENABLED: '0',
    ELFURA_DESIDUB_ENABLED: '0',
    ELFURA_VIDORA_ENABLED: '0',
  }),
);
const offIds = off.listPublicSources().map((source) => source.id);
for (const id of ['source-18', 'source-20']) {
  assert(!offIds.includes(id), `${id} should honour its opt-out flag`);
}
for (const id of ['source-18', 'source-20']) {
  const entry = on.listPublicSources().find((source) => source.id === id);
  assert(entry && /^Source \d+$/.test(entry.label), `${id} keeps a generic label`);
}

console.log('✓ Sources 18-20 payload parsing, AES lane, opt-out flags and PNG-wrapped TS sniffing');
