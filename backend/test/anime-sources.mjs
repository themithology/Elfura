import assert from 'node:assert/strict';
import { fetchDesiDub, createSource16Adapter } from '../../dist/backend/sources/source16.js';
import { fetchAnikoto, createSource17Adapter } from '../../dist/backend/sources/source17.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { loadBackendConfig } from '../../dist/backend/config.js';

const originalFetch = globalThis.fetch;
const requests = [];
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n';
const enc = value => Buffer.from(value).toString('base64');

const desiSeries = '<html><a href="/watch/attack-on-titan-episode-1/">Episode 1</a></html>';
const desiWatch = `<div data-embed-id="${enc('VidMoly (SUB)')}:${enc('https://vidmoly.net/embed-sub')}"></div>` +
  `<div data-embed-id="${enc('VidMoly (DUB)')}:${enc('https://vidmoly.net/embed-dub')}"></div>`;
const anikotoSeries = '<div id="watch-main" data-id="42"></div>';
const episodeFragment = '<ul><li><a href="/watch/attack-on-titan/ep-1" data-num="1" data-ids="server-group-1">Episode 1</a></li></ul>';
const serverFragment = '<div class="type"><label>SUB</label><ul><li class="server" data-link-id="sub-link" data-sv-id="s1">Vidstream-1</li></ul></div>' +
  '<div class="type"><label>DUB</label><ul><li class="server" data-link-id="dub-link" data-sv-id="d1">Vidstream-2</li></ul></div>';

function responseFor(input) {
  const url = new URL(String(input));
  requests.push(url);
  if (url.hostname === 'www.desidubanime.me' && url.pathname === '/wp-json/wp/v2/anime') {
    return Response.json([{ id: 123, slug: 'attack-on-titan', link: 'https://www.desidubanime.me/anime/attack-on-titan/', title: { rendered: 'Attack on Titan' } }]);
  }
  if (url.hostname === 'www.desidubanime.me' && url.pathname === '/anime/attack-on-titan/') return new Response(desiSeries);
  if (url.hostname === 'www.desidubanime.me' && url.pathname === '/watch/attack-on-titan-episode-1/') return new Response(desiWatch);
  if (url.hostname === 'vidmoly.net' && url.pathname === '/embed-sub') return new Response(`jwplayer.setup({file:"https://media.animecdn.example/desi-sub.m3u8"});`);
  if (url.hostname === 'vidmoly.net' && url.pathname === '/embed-dub') return new Response(`jwplayer.setup({file:"https://media.animecdn.example/desi-dub.m3u8"});`);
  if (url.hostname === 'media.animecdn.example') return new Response(manifest, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });

  if (url.hostname === 'anikototv.to' && url.pathname === '/filter') {
    return new Response('<div class="flw-item"><a href="/watch/attack-on-titan"><div class="name">Attack on Titan</div></a></div>');
  }
  if (url.hostname === 'anikototv.to' && url.pathname === '/watch/attack-on-titan') return new Response(anikotoSeries);
  if (url.hostname === 'anikototv.to' && url.pathname === '/ajax/episode/list/42') return Response.json({ result: episodeFragment });
  if (url.hostname === 'anikototv.to' && url.pathname === '/ajax/server/list') return Response.json({ result: serverFragment });
  if (url.hostname === 'anikototv.to' && url.pathname === '/ajax/server') {
    const id = url.searchParams.get('get');
    const src = id === 'sub-link' ? 'https://vidstream.example/embed/sub' : 'https://vidstream.example/embed/dub';
    return Response.json({ result: { url: src } });
  }
  if (url.hostname === 'vidstream.example' && url.pathname === '/embed/sub') {
    return new Response('data-ep-id="101"; type: \'hls\'; domain2_url: \'https://vidstream-api.example\';');
  }
  if (url.hostname === 'vidstream.example' && url.pathname === '/embed/dub') {
    return new Response('data-ep-id="102"; type: \'hls\'; domain2_url: \'https://vidstream-api.example\';');
  }
  if (url.hostname === 'vidstream-api.example' && url.pathname === '/save_data.php') {
    const id = url.searchParams.get('id');
    const path = id?.startsWith('101') ? 'anikoto-sub.m3u8' : 'anikoto-dub.m3u8';
    return Response.json({ data: { sources: [{ url: `https://media.animecdn.example/${path}` }], tracks: [] } });
  }
  throw new Error(`Unexpected anime source request: ${url.href}`);
}

globalThis.fetch = async (input, init = {}) => {
  const response = responseFor(input);
  if (init.redirect !== 'error' && new URL(String(input)).hostname !== 'media.animecdn.example') {
    // The adapters must opt out of redirects for provider/API requests.
    throw new Error('Expected redirect:error on provider requests');
  }
  return response;
};

try {
  const query = { type: 'tv', tmdbId: '1429', season: 1, episode: 1, title: 'Attack on Titan' };
  const desi = await fetchDesiDub(query);
  assert.equal(desi.length, 2, 'DesiDub should return only direct manifest-backed SUB/DUB candidates');
  assert.deepEqual(new Set(desi.map(candidate => candidate.audioLabel.split(' ')[0])), new Set(['SUB', 'DUB']));
  assert(desi.every(candidate => candidate.type === 'hls' && candidate.url.endsWith('.m3u8')));
  assert(desi.every(candidate => !candidate.url.includes('embed') && candidate.audioLang === undefined), 'server SUB/DUB labels are not treated as audio-language evidence');

  const anikoto = await fetchAnikoto(query);
  assert.equal(anikoto.length, 2, 'Anikoto Vidstream resolver should return both distinct SUB/DUB direct HLS candidates');
  assert.deepEqual(new Set(anikoto.map(candidate => candidate.audioLabel.split(' ')[0])), new Set(['SUB', 'DUB']));
  assert(anikoto.every(candidate => candidate.type === 'hls' && candidate.url.endsWith('.m3u8') && candidate.audioLang === undefined));
  assert(requests.some(url => url.hostname === 'anikototv.to' && url.pathname === '/ajax/server/list'));
  assert(requests.some(url => url.hostname === 'vidstream-api.example' && url.pathname === '/save_data.php'));

  const source16 = createSource16Adapter(() => true);
  const source17 = createSource17Adapter(() => true);
  assert.equal((await source16.resolve(query)).candidates.length, 2);
  assert.equal((await source17.resolve(query)).candidates.length, 2);
  const registry = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'anime-adapter-test-secret' }));
  assert(registry.listPublicSources().some(source => source.id === 'source-16'));
  assert(registry.listPublicSources().some(source => source.id === 'source-17'));
  const disabledRegistry = new SourceRegistry(loadBackendConfig({
    ELFURA_SECRET: 'anime-adapter-test-secret',
    ELFURA_DESIDUB_ENABLED: '0',
    ELFURA_ANIKOTO_ENABLED: '0',
  }));
  assert(!disabledRegistry.listPublicSources().some(source => source.id === 'source-16'));
  assert(!disabledRegistry.listPublicSources().some(source => source.id === 'source-17'));
  console.log('✓ DesiDubAnime and Anikoto direct-site API flows, server SUB/DUB lanes, HLS-only output and manifest verification');
} finally {
  globalThis.fetch = originalFetch;
}
