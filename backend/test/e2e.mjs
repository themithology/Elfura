process.env.ELFURA_NXSHA_ENABLED = '0';
process.env.ELFURA_VIDMODY_ENABLED = '0';
process.env.ELFURA_BINGR_ENABLED = '0'; // isolate fixture tests from live upstreams
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

// Redirect only the lazily loaded HLS engine to the event-order adapter. All
// player orchestration and the loadHls()/manifest handlers remain production code.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'hls.js' || specifier === 'dashjs') {
      return {
        url: new URL(specifier === 'hls.js' ? './hls-event-order-mock.mjs' : './dash-v5-mock.mjs', import.meta.url).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

import {
  isSafeUpstreamUrl,
  sealStreamTicket,
  openStreamTicket,
  openPlaybackEnvelope,
} from '../../dist/backend/security.js';
import {
  normalizeLang,
  fetchFromVidBolt,
} from '../../dist/backend/sources/source1.js';
import {
  rewriteHlsManifest,
  resolveHlsChildUrl,
  rewriteDashManifest,
  materializeDashTicket,
  sanitizeWebVtt,
  isAnonymousSegmentUrl,
} from '../../dist/backend/relay.js';
import { createBackendServer, matchEmbedPath } from '../../dist/backend/index.js';
import { verifyAndFilterCandidates, verifyAndFilterCandidatesDetailed } from '../../dist/backend/sources/liveness.js';
import { canonLang, languageLabel, matchScore, buildTrackList, ElfuraPlayer } from '../../dist/lib/elfura.js';

// 1. SSRF guard (production mode: loopback/RFC1918/metadata strictly rejected)
assert.equal(isSafeUpstreamUrl('http://127.0.0.1:8080/a.m3u8'), false);
assert.equal(isSafeUpstreamUrl('http://localhost/a.m3u8'), false);
assert.equal(isSafeUpstreamUrl('http://169.254.169.254/latest/meta-data/'), false);
assert.equal(isSafeUpstreamUrl('http://10.0.0.5/secret'), false);
assert.equal(isSafeUpstreamUrl('http://192.168.1.1/secret'), false);
assert.equal(isSafeUpstreamUrl('http://[::1]/secret'), false);
assert.equal(isSafeUpstreamUrl('file:///etc/passwd'), false);
assert.equal(isSafeUpstreamUrl('https://cdn.example.com/stream/master.m3u8'), true);

// Same-origin access parameters propagate only for the specific CDN families,
// never to a different origin or over an explicit child key.
assert.equal(new URL(resolveHlsChildUrl('audio.m3u8', 'https://img.rousav.tech/media/master.m3u8?api_key=fixture')).searchParams.get('api_key'), 'fixture');
assert.equal(new URL(resolveHlsChildUrl('https://other.example/a.m3u8', 'https://img.rousav.tech/media/master.m3u8?api_key=fixture')).searchParams.has('api_key'), false);
assert.equal(new URL(resolveHlsChildUrl('audio.m3u8?apikey=child', 'https://img.rousav.tech/media/master.m3u8?api_key=fixture')).searchParams.has('api_key'), false);
assert.equal(new URL(resolveHlsChildUrl('audio.m3u8', 'https://other.example/master.m3u8?api_key=fixture')).searchParams.has('api_key'), false);

// The original provider is resolved independently, with untrusted domains rejected.
{
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/api/resolve');
      assert.equal(parsed.searchParams.get('only'), 'orion');
      assert.equal(parsed.searchParams.get('season'), '2');
      assert.equal(parsed.searchParams.get('episode'), '3');
      return new Response(JSON.stringify({ stream: { sources: [
        { url: 'https://img.rousav.tech/media/test/index.m3u8', type: 'hls', master: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="hi"\n#EXT-X-MEDIA:TYPE=AUDIO,LANGUAGE="en"' },
        { url: 'https://vidstuck.cc/master.m3u8', type: 'hls' },
        { url: 'https://untrusted.example/master.m3u8', type: 'hls' },
      ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const sources = await fetchFromVidBolt('https://vidbolt.xyz', {type:'tv',tmdbId:'93405',season:2,episode:3});
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, 'https://img.rousav.tech/media/test/index.m3u8');
    assert.equal(sources[0].multiAudio, true); // scheduling hint, independently verified before playback
    assert.deepEqual(sources[0].availableAudioLangs, ['hi','en']);
    assert.equal(sources[0].qualityLabelsUnreliable, true); // known incorrect movie CDN ladder
  } finally { globalThis.fetch = originalFetch; }
}

// 2. Embed route matcher
assert.deepEqual(matchEmbedPath('/embed/movie/278'), { mediaType: 'movie', tmdbId: '278' });
assert.deepEqual(matchEmbedPath('/embed/tv/94605/1/3'), {
  mediaType: 'tv',
  tmdbId: '94605',
  season: 1,
  episode: 3,
});

// 5. AES-256-GCM stateless stream tickets
const secret = crypto.createHash('sha256').update('test-secret').digest();
const ticket = sealStreamTicket(secret, {
  u: 'https://cdn.upstream.example/hls/master.m3u8?sig=long-token-value-1234567890',
  h: { Referer: 'https://player.vidzee.wtf/', Origin: 'https://player.vidzee.wtf' },
  k: 'm',
});
assert(!ticket.includes('vidzee') && !ticket.includes('upstream'));
const opened = openStreamTicket(secret, ticket);
assert.equal(opened.u, 'https://cdn.upstream.example/hls/master.m3u8?sig=long-token-value-1234567890');
assert.equal(opened.h.Referer, 'https://player.vidzee.wtf/');
const tampered = ticket.slice(0, -2) + (ticket.endsWith('AA') ? 'BB' : 'AA');
assert.equal(openStreamTicket(secret, tampered), null);

// 5b. Dynamic runtime language canonicalization (Part 2 + Part 1, zero hardcoded track maps)
assert.equal(normalizeLang('hin').code, 'hi');
assert.equal(normalizeLang('jpn').code, 'ja');
assert.equal(normalizeLang('kan').code, 'kn');
assert.equal(normalizeLang('tam').code, 'ta');
assert.equal(normalizeLang('tel').code, 'te');
assert.equal(normalizeLang('Bangla').code, 'bn');
assert.equal(normalizeLang('Bengali').code, 'bn');
assert.equal(normalizeLang('Latin American Spanish').code, 'es-419');
assert.equal(normalizeLang('Spanish (LatAm)').code, 'es-419');
assert.equal(normalizeLang('Brazilian Portuguese').code, 'pt-br');
assert.equal(normalizeLang('Portuguese (BR)').code, 'pt-br');
assert.equal(normalizeLang('1. English').code, 'en');
assert.equal(normalizeLang('en.[CC]').code, 'en');
assert.equal(canonLang('hin'), 'hi');
assert.equal(canonLang('jpn'), 'ja');
assert.equal(canonLang('kan'), 'kn');
assert.equal(canonLang('es-419'), 'es-419');
assert.equal(canonLang('pt-br'), 'pt-br');
assert.equal(canonLang('hindi-(ms)'), 'hi');
assert.equal(canonLang('Hindi (MS)'), 'hi');
assert.equal(canonLang('telugu-(ms)'), 'te');
assert.equal(canonLang('unknown (MS)'), 'und');
assert.equal(matchScore('hi', 'hin'), 0);
assert.equal(matchScore('es', 'es-419'), 1);
assert.equal(languageLabel('hin', 'MovieHubBD'), 'Hindi');
assert.equal(languageLabel('es-419'), 'Latin American Spanish');
assert.equal(languageLabel('pt-br'), 'Brazilian Portuguese');

// Dynamic buildTrackList merges manifest + discovered raw source languages without hardcoding
const dynamicTracks = buildTrackList({
  native: [{ id: 0, lang: 'und', label: 'Audio', default: true }],
  discoveredSourceLangs: [
    { lang: 'ja', active: true },
    { lang: 'hi' },
    { lang: 'en' },
  ],
});
assert.equal(dynamicTracks.length, 3);
assert.deepEqual(
  dynamicTracks.map((t) => ({ lang: t.lang, kind: t.kind })),
  [
    { lang: 'ja', kind: 'native' },
    { lang: 'en', kind: 'source' },
    { lang: 'hi', kind: 'source' },
  ],
);

// 5c. HLS manifest sanitizer (Dune 2 MovieHubBD watermark + TGKAI ISO-639-2 & all-DEFAULT=NO)
const duneManifest = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="MovieHubBD",LANGUAGE=hin,DEFAULT=YES,AUTOSELECT=YES,URI="aud1.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="MovieHubBD",LANGUAGE=eng,DEFAULT=NO,AUTOSELECT=YES,URI="aud2.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="MovieHubBD",LANGUAGE=eng,DEFAULT=NO,URI="sub0.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="MovieHubBD",LANGUAGE=eng,DEFAULT=NO,URI="sub1.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="MovieHubBD",LANGUAGE=eng,DEFAULT=NO,URI="sub2.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,AUDIO="aud",SUBTITLES="subs"',
  'vid.m3u8',
].join('\n');
const rewrittenDune = rewriteHlsManifest(duneManifest, 'https://cdn.example.com/hls/master.m3u8', undefined, secret);
assert(!rewrittenDune.includes('MovieHubBD'));
assert(rewrittenDune.includes('LANGUAGE="hi"'));
assert(rewrittenDune.includes('NAME="Hindi"'));
assert(rewrittenDune.includes('NAME="English"'));
assert(!rewrittenDune.includes('TYPE=SUBTITLES'));
assert(!rewrittenDune.includes('SUBTITLES="subs"'));

const kaiManifest = [
  '#EXTM3U',
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="jpn",NAME="Japanese",DEFAULT=NO,AUTOSELECT=YES,URI="https://cdn.example.com/api/kai/abc?p=%2Fhls%2Fa_jp.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="kan",NAME="Kannada",DEFAULT=NO,AUTOSELECT=YES,URI="https://cdn.example.com/api/kai/abc?p=%2Fhls%2Fa_kn.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,AUDIO="audio"',
  'https://cdn.example.com/api/kai/abc?p=%2Fhls%2Fv1080.m3u8',
].join('\n');
const rewrittenKai = rewriteHlsManifest(kaiManifest, 'https://cdn.example.com/api/kai/abc', undefined, secret);
assert.equal(rewrittenKai.match(/^#EXTM3U$/gm)?.length, 1);
assert(rewrittenKai.includes('LANGUAGE="ja",NAME="Japanese",DEFAULT=YES'));
assert(rewrittenKai.includes('LANGUAGE="kn",NAME="Kannada",DEFAULT=NO'));

// Live Re:Zero S1E1 VidSync playlists escape underscores (`hls\_mps`). Preserve the
// actual CDN key instead of letting WHATWG URL parsing turn it into `hls/_mps`.
const escapedReZeroManifest = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:10',
  '#EXTINF:2.919578,',
  'https://img.hscow.com/hls\\_mps/1e2b23eb7579651f267d872be6c30354/720/0.jpg?t=1777023509',
  '#EXT-X-ENDLIST',
].join('\n');
const rewrittenReZero = rewriteHlsManifest(
  escapedReZeroManifest,
  'https://img1.hscow.com/hls_mps/1e2b23eb7579651f267d872be6c30354/720/index_287.m3u8',
  { Referer: 'https://api.hlowb.com/', 'User-Agent': 'okhttp/4.9.3' },
  secret,
);
const reZeroSegmentRef = rewrittenReZero.split('\n').find((line) => line.startsWith('/api/v1/stream?t='));
assert(reZeroSegmentRef, 'Escaped Re:Zero media segment must remain relayed');
const reZeroSegmentTicket = openStreamTicket(
  secret,
  new URL(reZeroSegmentRef, 'https://elfura.example').searchParams.get('t'),
);
assert.equal(
  reZeroSegmentTicket.u,
  'https://img.hscow.com/hls_mps/1e2b23eb7579651f267d872be6c30354/720/0.jpg?t=1777023509',
  'Re:Zero segment ticket must normalize hls\\_mps to the real hls_mps CDN key',
);

// DASH SegmentTemplate URLs must remain substitutable by dash.js without exposing
// the upstream template. The relay materializes $Number$/$RepresentationID$ only
// after opening the authenticated ticket.
const dashTemplateMpd = `<?xml version="1.0"?>
<MPD><BaseURL>https://cdn.example.com/root/?sig=a&amp;b=c</BaseURL><Period><AdaptationSet>
<Representation id="v1" bandwidth="1200000"><SegmentTemplate startNumber="7"
 media="video/$RepresentationID$/$Number%05d$.m4s?x=1&amp;y=2"
 initialization="video/$RepresentationID$/init.mp4" /></Representation>
</AdaptationSet></Period></MPD>`;
const rewrittenDashTemplate = rewriteDashManifest(
  dashTemplateMpd,
  'https://origin.example.com/manifest.mpd',
  { Referer: 'https://player.example.com/' },
  secret,
);
assert(!rewrittenDashTemplate.includes('cdn.example.com'), 'DASH templates must not leak their upstream origin');
const dashMediaRef = rewrittenDashTemplate.match(/\smedia="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
assert(dashMediaRef?.startsWith('/api/v1/stream?t='), 'DASH media template must be relayed');
assert(dashMediaRef.includes('_dr=$RepresentationID$'), 'RepresentationID must remain visible to dash.js');
assert(dashMediaRef.includes('_dn=$Number%05d$'), 'Number formatting must remain visible to dash.js');
const dashMediaUrl = new URL(dashMediaRef, 'https://elfura.example');
const dashTemplateTicket = openStreamTicket(secret, dashMediaUrl.searchParams.get('t'));
assert.equal(
  dashTemplateTicket.u,
  'https://cdn.example.com/root/video/$RepresentationID$/$Number%05d$.m4s?x=1&y=2',
);
const materializedDashTicket = materializeDashTicket(dashTemplateTicket, dashMediaUrl.searchParams);
assert.equal(materializedDashTicket, null, 'Unsubstituted test template must be rejected rather than fetched literally');
dashMediaUrl.searchParams.set('_dr', 'v1');
dashMediaUrl.searchParams.set('_dn', '00042');
const resolvedDashTicket = materializeDashTicket(dashTemplateTicket, dashMediaUrl.searchParams);
assert.equal(
  resolvedDashTicket.u,
  'https://cdn.example.com/root/video/v1/00042.m4s?x=1&y=2',
  'Relay must substitute the actual DASH representation and padded segment number',
);

const dashListMpd = `<MPD><BaseURL>https://cdn.example.com/list/</BaseURL><Period><Representation id="a">
<SegmentList><Initialization source="init.mp4"/><SegmentURL media="seg1.m4s"/></SegmentList>
</Representation></Period></MPD>`;
const rewrittenDashList = rewriteDashManifest(dashListMpd, 'https://origin.example.com/list.mpd', undefined, secret);
const dashInitRef = rewrittenDashList.match(/\ssource="([^"]+)"/)?.[1];
const dashSegmentRef = rewrittenDashList.match(/\smedia="([^"]+)"/)?.[1];
assert.equal(openStreamTicket(secret, new URL(dashInitRef, 'https://elfura.example').searchParams.get('t')).u,
  'https://cdn.example.com/list/init.mp4');
assert.equal(openStreamTicket(secret, new URL(dashSegmentRef, 'https://elfura.example').searchParams.get('t')).u,
  'https://cdn.example.com/list/seg1.m4s');

// Source 2 rousav + dash-hls-bridge manifest sanitization & WebVTT spam cue stripping
const rousavManifest = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="1. English [CC]",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,LANGUAGE="en.[CC]",URI="subtitles_englishcc.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="1. English",DEFAULT=YES,AUTOSELECT=YES,URI="track_english.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="hin",NAME="2. Hindi",DEFAULT=NO,AUTOSELECT=YES,URI="track_hindi.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="subs"',
  'video_720p.m3u8',
].join('\n');
const rewrittenRousav = rewriteHlsManifest(rousavManifest, 'https://cdn.example.com/media/abc/index.m3u8', undefined, secret);
assert(rewrittenRousav.includes('LANGUAGE="en"'));
assert(!rewrittenRousav.includes('en.[CC]'));
assert(!rewrittenRousav.includes('TYPE=SUBTITLES'));
assert(!rewrittenRousav.includes('SUBTITLES="subs"'));
assert(rewrittenRousav.includes('NAME="English"'));
assert(rewrittenRousav.includes('NAME="Hindi"'));
assert(!rewrittenRousav.includes('1. English'));
assert(!rewrittenRousav.includes('2. Hindi'));

const bridgeManifest = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="https://cdn.example.com/v3.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1920x1080,AUDIO="audio"',
  'https://cdn.example.com/v0.m3u8',
].join('\n');
const rewrittenBridge = rewriteHlsManifest(bridgeManifest, 'https://cdn.example.com/master.m3u8', undefined, secret);
assert(rewrittenBridge.includes('NAME="Original"'));

const dirtyVtt = [
  'WEBVTT',
  '',
  '1',
  '00:00:01.000 --> 00:00:03.000',
  'Subtitles downloaded from www.OpenSubtitles.org',
  '',
  '2',
  '00:00:04.250 --> 00:00:06.500',
  'Welcome back to Arrakis.',
  '',
  '3',
  '00:00:08.000 --> 00:00:10.000',
  'Watch movies free on aethoflix.world!',
  '',
].join('\n');
const cleanVtt = sanitizeWebVtt(dirtyVtt);
assert(!cleanVtt.includes('OpenSubtitles'));
assert(!cleanVtt.includes('aethoflix'));
assert(cleanVtt.includes('Welcome back to Arrakis.'));

// 6. Full E2E server + mock upstreams
process.env.NODE_ENV = 'test';
process.env.ELFURA_ALLOW_LOOPBACK_TEST = '1';

// A healthy candidate must not be listed alongside slow/unverified lanes. Those
// lanes remain available only in last-resort mode when nothing verifies alive.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/healthy.m3u8')) {
      return new Response('#EXTM3U\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n', {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
      });
    }
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe timeout')), 5000);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  };
  try {
    const candidates = [
      {
        key: 'healthy', fingerprint: 'healthy', type: 'hls', url: 'https://cdn.example.com/healthy.m3u8',
        quality: '1080p', multiAudio: true, subtitles: [], rank: 0, latencyMs: 0,
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        key: `slow-${i}`, fingerprint: `slow-${i}`, type: 'hls',
        url: `https://cdn.example.com/slow-${i}.m3u8`, quality: 'auto', multiAudio: false,
        subtitles: [], rank: i + 1, latencyMs: 500,
      })),
    ];
    const filtered = await verifyAndFilterCandidates(candidates);
    assert.deepEqual(filtered.map((c) => c.key), ['healthy'],
      'Unverified slow lanes must be hidden when a healthy candidate exists');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// A temporary child failure must not poison the master as permanently dead.
{
  const originalFetch = globalThis.fetch;
  let childCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/retry-master.m3u8')) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\nretry-child.m3u8\n');
    if (url.endsWith('/retry-child.m3u8')) {
      if (++childCalls === 1) return new Response('temporary', { status: 503 });
      return new Response('#EXTM3U\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n');
    }
    throw new Error('unexpected fetch');
  };
  try {
    const c = { key: 'retry-master', type: 'hls', url: 'https://cdn.example.com/retry-master.m3u8', quality: 'auto', rank: 1 };
    assert.equal((await verifyAndFilterCandidatesDetailed([c])).verifiedAliveCount, 0);
    assert.equal((await verifyAndFilterCandidatesDetailed([c])).verifiedAliveCount, 1);
    assert.equal(childCalls, 2, 'transient child errors must be retried, not cached as dead');
  } finally { globalThis.fetch = originalFetch; }
}

const SEGMENT_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

let skipSegmentRequestCount = 0;
let removedSourceCalls = 0;
const mockUpstream = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const origin = `http://${req.headers.host}`;
  if (/^\/api\/(?:extract|scan|sources)(?:\/|$)/.test(u.pathname) || u.pathname.startsWith('/backend/database/')) removedSourceCalls++;

  if (u.pathname === '/tmdb/trending/movie/week') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { id: 533535, title: 'Deadpool & Wolverine', release_date: '2024-07-24', vote_average: 7.9, poster_path: '/deadpool.jpg', backdrop_path: '/deadpool-wide.jpg', overview: 'Movie overview' },
      { id: 1218925, title: 'Chainsaw Man - The Movie: Reze Arc', release_date: '2025-09-19', vote_average: 8.4, poster_path: '/reze.jpg', backdrop_path: '/reze-wide.jpg', overview: 'Anime film overview' },
    ] }));
    return;
  }
  if (u.pathname === '/tmdb/trending/tv/week') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { id: 94605, name: 'Arcane', first_air_date: '2021-11-06', vote_average: 8.7, poster_path: '/arcane.jpg', backdrop_path: '/arcane-wide.jpg', overview: 'Series overview' },
    ] }));
    return;
  }
  if (u.pathname === '/tmdb/discover/tv') {
    assert.equal(u.searchParams.get('with_genres'), '16');
    assert.equal(u.searchParams.get('with_original_language'), 'ja');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [
      { id: 2190, name: 'Dynamic Anime', first_air_date: '2024-04-01', vote_average: 8.2, poster_path: '/anime.jpg', backdrop_path: '/anime-wide.jpg', overview: 'Anime overview' },
    ] }));
    return;
  }
  if (u.pathname === '/tmdb/tv/94605') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 94605,
        name: 'Arcane',
        first_air_date: '2021-11-06',
        tagline: 'Every legend has a beginning.',
        vote_average: 8.76,
        genres: [{ name: 'Animation' }, { name: 'Action' }],
        overview: 'Amid the stark discord of twin cities Piltover and Zaun...',
        poster_path: '/fqldf2t8ztc9aiwn3k6mlX3tvRT.jpg',
        backdrop_path: '/rkB4LyZHo1NHXFEDHl9vSD9r1lI.jpg',
        external_ids: { imdb_id: 'tt11126994' },
        seasons: [
          { season_number: 0, name: 'Specials', episode_count: 3 },
          { season_number: 1, name: 'Season 1', episode_count: 9 },
          { season_number: 2, name: 'Season 2', episode_count: 9 },
        ],
        images: {
          logos: [{ iso_639_1: 'en', file_path: '/arcaneTitleLogo.png' }],
        },
      }),
    );
    return;
  }
  if (u.pathname === '/tmdb/tv/94605/season/1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        season_number: 1,
        episodes: [
          {
            episode_number: 1,
            season_number: 1,
            name: 'Welcome to the Playground',
            overview: 'Orphaned sisters Vi and Powder bring trouble to Zaun.',
            runtime: 43,
            vote_average: 8.6,
            air_date: '2021-11-06',
          },
          {
            episode_number: 2,
            season_number: 1,
            name: 'Some Mysteries Are Better Left Unsolved',
            overview: 'Idealistic inventor Jayce attempts to harness magic.',
            runtime: 40,
            vote_average: 8.5,
            air_date: '2021-11-06',
          },
          {
            episode_number: 3,
            season_number: 1,
            name: 'The Base Violence Necessary for Change',
            overview: 'An epic showdown pits old rivals against each other.',
            runtime: 44,
            vote_average: 9.2,
            air_date: '2021-11-06',
          },
        ],
      }),
    );
    return;
  }
  if (u.pathname === '/opensubs/subtitles/series/tt11126994:1:1.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        subtitles: [
          {
            id: 'os-bad-sub',
            url: `${origin}/opensubs/dl/arcane_frame.sub`,
            SubEncoding: 'UTF-8',
            lang: 'eng',
            subtitleFileName: 'Arcane.S01E01.sub',
          },
          {
            id: 'os-en-utf8',
            url: `${origin}/opensubs/dl/arcane_en_utf8`,
            SubEncoding: 'UTF-8',
            lang: 'eng',
            subtitleFileName: 'Arcane.S01E01.WEB.srt',
          },
          {
            id: 'os-hi-utf8',
            url: `${origin}/opensubs/dl/arcane_hi_utf8.srt`,
            SubEncoding: 'UTF-8',
            lang: 'hin',
            subtitleFileName: 'Arcane.S01E01.Hindi.srt',
          },
          {
            id: 'os-pob-utf8',
            url: `${origin}/opensubs/dl/arcane_ptbr.srt`,
            SubEncoding: 'UTF-8',
            lang: 'pob',
            subtitleFileName: 'Arcane.S01E01.PTBR.srt',
          },
          {
            id: 'os-spl-utf8',
            url: `${origin}/opensubs/dl/arcane_es419.srt`,
            SubEncoding: 'UTF-8',
            lang: 'spl',
            subtitleFileName: 'Arcane.S01E01.LatAm.srt',
          },
        ],
      }),
    );
    return;
  }
  if (u.pathname.startsWith('/opensubs/dl/')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(
      [
        '1',
        '00:00:01,000 --> 00:00:03,000',
        'Support us and become VIP member to remove all ads from www.OpenSubtitles.org',
        '',
        '2',
        '00:00:04,500 --> 00:00:07,200',
        'Welcome to Piltover.',
        '',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname === '/tmdb/tv/94605/season/1/episode/1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'Welcome to the Playground' }));
    return;
  }
  if (u.pathname === '/tmdb/movie/533535') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 533535,
        title: 'Deadpool & Wolverine',
        release_date: '2024-07-24',
        poster_path: '/8cdWjvZQUExUUTzyp4t6EDMubfO.jpg',
        backdrop_path: '/yDHYTfA3R0jFYba16jBB1ef8oIt.jpg',
        external_ids: { imdb_id: 'tt6263850' },
      }),
    );
    return;
  }
  if (u.pathname === '/tmdb/movie/1218925') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 1218925,
        title: 'Chainsaw Man - The Movie: Reze Arc',
        original_language: 'ja',
        release_date: '2025-09-19',
        poster_path: '/rezePoster.jpg',
        backdrop_path: '/rezeBackdrop.jpg',
        external_ids: { imdb_id: 'tt30472557' },
      }),
    );
    return;
  }
  if (u.pathname === '/api/m/533535') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, links: [] }));
    return;
  }
  if (u.pathname === '/api/m/1218925') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        links: [
          {
            server: 'MHBD Dead Child',
            label: 'Multi-Audio [HIN + ENG]',
            quality: '1080p',
            type: 'hls',
            multi_audio: true,
            audios: ['hin', 'eng'],
            url: `${origin}/dead-child-stream/master.m3u8?v=1`,
          },
        ],
      }),
    );
    return;
  }
  if (u.pathname === '/race/dead.mp4') {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('bad gateway');
    return;
  }
  if (u.pathname === '/race/slow-hi.mp4') {
    setTimeout(() => {
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${SEGMENT_BYTES.length - 1}/${SEGMENT_BYTES.length}`,
      });
      res.end(SEGMENT_BYTES);
    }, 550);
    return;
  }
  if (u.pathname === '/race/fast-hi.mp4') {
    setTimeout(() => {
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${SEGMENT_BYTES.length - 1}/${SEGMENT_BYTES.length}`,
      });
      res.end(SEGMENT_BYTES);
    }, 10);
    return;
  }

  if (u.pathname.startsWith('/_serverFn/')) {
    skipSegmentRequestCount++;
    res.writeHead(410); res.end(); return;
  }

  if (u.pathname === '/api/tv/94605/1/1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, links: [] }));
    return;
  }

  if (u.pathname === '/api/boot/tv/94605/1/1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        meta: {
          playbackToken: "fixture-rift-token",
          orionStreams: [
            {
              url: '/api/orion/abc123hash/master.m3u8',
              name: 'Orion · Hindi',
              rungs: [{ height: 720 }, { height: 1080 }],
            },
          ],
        },
      }),
    );
    return;
  }
  if (u.pathname.startsWith('/api/orion/abc123hash/')) {
    assert.equal(req.headers['x-playback-token'], 'fixture-rift-token');
    const tail = u.pathname.split('/').pop();
    if (tail === 'subtitles.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tracks: [{ label: 'English', lang: 'en', url: '/api/orion/abc123hash/sub_en.vtt' }] }));
      return;
    }
    if (tail === 'sub_en.vtt') {
      res.writeHead(200, { 'Content-Type': 'text/vtt' }); res.end('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome!\n'); return;
    }
    if (tail === 'master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Hindi",LANGUAGE="hi",DEFAULT=YES,URI="/cdn/hub/a_hi.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="/cdn/hub/a_en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="aud"\n/cdn/hub/v0.m3u8\n'); return;
    }
  }
  if (u.pathname === '/api/relay') {
    const decoded = Buffer.from(u.searchParams.get('u'), 'base64url').toString('utf8');
    if (decoded.endsWith('/subtitles.json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tracks: [{ label: 'English · Orion', lang: 'en', url: '/api/orion/abc123hash/sub_en.vtt' }],
        }),
      );
      return;
    }
    if (decoded.endsWith('/sub_en.vtt')) {
      res.writeHead(200, { 'Content-Type': 'text/vtt' });
      res.end('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nWelcome to Piltover!\n');
      return;
    }
    if (decoded.endsWith('/master.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n/cdn/hub/v0.m3u8\n');
      return;
    }
  }

  if (u.pathname === '/api/core/streams' || u.pathname === '/api/stream') {
    if (u.searchParams.get('id') === '1218925') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          sources:
            u.pathname === '/api/core/streams'
              ? [
                  {
                    provider: { id: 'vidzee', name: 'VidZee' },
                    directUrl: `${origin}/dead-direct/bigtits.m3u8`,
                    url: `/api/core/proxy?data=vidzee_live_hi_1218925`,
                    type: 'hls',
                    quality: 'Auto',
                    audioLanguage: 'hi',
                  },
                ]
              : [],
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sources: [
          {
            provider: { id: 'castle', label: 'Castle' },
            directUrl: `${origin}/cdn/protected/master.m3u8`,
            type: 'hls',
            quality: '1080p',
            audioLanguage: 'en',
            headers: { Referer: 'https://api.hlowb.com/' },
          },
        ],
      }),
    );
    return;
  }
  if (u.pathname === '/api/core/proxy') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\n/cdn/hub/seg0.m4s\n#EXT-X-ENDLIST\n');
    return;
  }
  if (u.pathname === '/dead-direct/bigtits.m3u8') {
    res.writeHead(403, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>403 Forbidden</title></head><body>Forbidden</body></html>');
    return;
  }
  if (u.pathname === '/dead-child-stream/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Malay",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE=hin,URI="/dead-child-stream/audio0.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="audio"',
        '/cdn/hub/v0.m3u8',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname === '/vix-encrypted-segment.ts') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(Buffer.from([0xff, 0x81, 0x00, 0x94, 0xac, 0x30, 0xc3, 0x88]));
    return;
  }
  if (u.pathname === '/dead-child-stream/audio0.m3u8' || u.pathname === '/dead-html-segment.ts') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body>CDN Marketing Landing Page</body></html>');
    return;
  }

  // Source 2 unified /api/extract mock (models 30-server byServer + proxy-m3u8 + rousav + worker dubs)
  if (u.pathname === '/api/extract') {
    if (u.searchParams.get('tmdbId') === '1218925') {
      assert.equal(u.searchParams.get('mediaType'), 'movie');
      assert.equal(u.searchParams.get('title'), 'Chainsaw Man - The Movie: Reze Arc');
      assert.equal(u.searchParams.get('year'), '2025');
      assert.equal(u.searchParams.get('date'), '2025-09-19');
      assert.equal(u.searchParams.get('imdbId'), 'tt30472557');

      const makeBridge = (slug, sig = 'SIG_OUTER_OK') =>
        `${origin}/dash-hls-bridge/?url=${encodeURIComponent(`${origin}/dash/1218925_0_0_1080_h265_${slug}/master.m3u8`)}&Policy=POL123&Signature=${sig}&Key-Pair-Id=KP123`;
      const vidboltEn1080 = `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/m/tok_1218925_atlas_en1080?f=.m3u8`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`;
      const rousavMulti = `${origin}/media/rousav1218925/index.m3u8?api_key=testkey`;
      const deadMirror = `${origin}/dead-direct/bigtits.m3u8`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          sources: [
            {
              url: makeBridge('ja01'),
              type: 'hls',
              resolution: 1080,
              resolutions: [1080, 720, 480],
              label: '1080p • Japanese',
              language: 'Japanese',
              audioLanguages: ['Japanese'],
              originServer: 'atlas',
            },
          ],
          byServer: {
            atlas: {
              latencyMs: 390,
              dubs: [
                { lanCode: 'ja', lanName: 'Japanese', original: true, dubType: '0' },
                { lanCode: 'hi', lanName: 'Hindi', original: false, dubType: '0' },
                { lanCode: 'en', lanName: 'English', original: false, dubType: '0' },
                { lanCode: 'fr', lanName: 'French', original: false, dubType: '0' },
                { lanCode: 'ar', lanName: 'Arabic', original: false, dubType: '0' },
                { lanCode: 'in', lanName: 'Indonesian', original: false, dubType: '0' },
                { lanCode: 'ku', lanName: 'Kurdish sub', original: false, dubType: '0' },
              ],
              sources: [
                {
                  url: vidboltEn1080,
                  type: 'hls',
                  resolution: 1080,
                  resolutions: [1080, 720, 360],
                  label: '1080p • English',
                  language: 'English',
                  audioLanguages: ['English'],
                  originServer: 'atlas',
                },
                {
                  url: makeBridge('ja01'),
                  type: 'hls',
                  resolution: 1080,
                  resolutions: [1080, 720, 480],
                  label: '1080p • Japanese',
                  language: 'Japanese',
                  audioLanguages: ['Japanese'],
                  originServer: 'atlas',
                },
                {
                  url: makeBridge('hi01'),
                  type: 'hls',
                  resolution: 1080,
                  resolutions: [1080, 720, 480],
                  label: '1080p • Hindi',
                  language: 'Hindi',
                  audioLanguages: ['Hindi'],
                  originServer: 'atlas',
                },
                {
                  url: makeBridge('fr01'),
                  type: 'hls',
                  resolution: 360,
                  resolutions: [360],
                  label: '360p • French',
                  language: 'French',
                  audioLanguages: ['French'],
                  originServer: 'atlas',
                },
                {
                  url: makeBridge('ar01'),
                  type: 'hls',
                  resolution: 1080,
                  resolutions: [1080],
                  label: '1080p • Arabic',
                  language: 'Arabic',
                  audioLanguages: ['Arabic'],
                  originServer: 'atlas',
                },
                {
                  url: makeBridge('id01'),
                  type: 'hls',
                  resolution: 1080,
                  resolutions: [1080],
                  label: '1080p • Indonesian',
                  language: 'in',
                  audioLanguages: ['in'],
                  originServer: 'atlas',
                },
                {
                  url: makeBridge('ku_sub'),
                  type: 'hls',
                  resolution: 1080,
                  resolutions: [1080],
                  label: '1080p • Kurdish sub',
                  language: 'Kurdish sub',
                  audioLanguages: ['Kurdish sub'],
                  originServer: 'atlas',
                },
                {
                  url: deadMirror,
                  type: 'hls',
                  resolution: 1080,
                  resolutions: [1080],
                  label: '1080p • German',
                  language: 'German',
                  audioLanguages: ['German'],
                  originServer: 'atlas',
                },
              ],
            },
            callisto: {
              latencyMs: 410,
              sources: [
                {
                  url: rousavMulti,
                  type: 'hls',
                  resolution: 1080,
                  resolutions: [1080, 720],
                  label: '1080p • Multi-Audio (Hindi, English)',
                  language: 'Hindi',
                  audioLanguages: ['Hindi', 'English'],
                  originServer: 'callisto',
                },
              ],
            },
          },
          scanReport: [
            { id: 'atlas', available: true, latencyMs: 390 },
            { id: 'callisto', available: true, latencyMs: 410 },
          ],
        }),
      );
      return;
    }

    if (u.searchParams.get('tmdbId') === '533535') {
      assert.equal(u.searchParams.get('mediaType'), 'movie');
      const thirtyIds = [
        'orion', 'vega', 'callisto', 'bharat', 'indus', 'bolly', 'kuro', 'quantum', 'rousav', 'atlas',
        'ursa', 'andromeda', 'valstrax', 'alatreon', 'resshin', 'centaurus', 'daedalus', 'quasar', 'zenith', 'nebula',
        'zxc_orion', 'zxc_atlas', 'zxc_ursa', 'hyperion', 'vidfast', 'vaplayer', 'kronos', 'pegasus', 'nova', 'apollo',
      ];
      const byServer = {};
      const scanServers = [];
      thirtyIds.forEach((srvId, i) => {
        const latencyMs = srvId === 'rousav' ? 365 : srvId === 'quantum' ? 370 : 400 + i * 15;
        scanServers.push({ serverId: srvId, status: 'online', streamCount: 4, latencyMs });
        byServer[srvId] = {
          latencyMs,
          dubs: [
            { lanCode: 'en', lanName: 'English', dubType: 1 },
            { lanCode: 'hi', lanName: 'Hindi', dubType: 0 },
            { lanCode: 'te', lanName: 'Telugu', dubType: 0 },
            { lanCode: 'po', lanName: 'Polish', dubType: 0 },
          ],
          sources: [
            {
              url: `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/m/tok_533535_${srvId}_en720?f=.m3u8`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`,
              type: 'hls',
              resolution: 720,
              resolutions: [720],
              label: '720p • English',
              language: 'English',
              audioLanguages: ['English'],
              originServer: srvId,
            },
            {
              url: `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/m/tok_533535_shared_hi480?f=.m3u8`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`,
              type: 'hls',
              resolution: 480,
              resolutions: [480],
              label: '480p • Hindi',
              language: 'Hindi',
              audioLanguages: ['Hindi'],
              originServer: srvId,
            },
            {
              url: `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/m/tok_533535_shared_te720?f=.m3u8`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`,
              type: 'hls',
              resolution: 720,
              resolutions: [720],
              label: '720p • Telugu',
              language: 'Telugu',
              audioLanguages: ['Telugu'],
              originServer: srvId,
            },
            {
              url: `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/m/tok_533535_shared_uk360?f=.m3u8`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`,
              type: 'hls',
              resolution: 360,
              resolutions: [360],
              label: '360p • Ukr',
              language: 'Ukr',
              audioLanguages: ['Ukr'],
              originServer: srvId,
            },
          ],
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          sources: byServer.orion.sources,
          subtitles: [
            {
              url: `${origin}/media/rousav94605/subs_en.vtt`,
              lang: 'en',
              label: 'Native English',
            },
          ],
          byServer,
          scanReport: { totalServers: 30, onlineServers: 30, servers: scanServers },
        }),
      );
      return;
    }

    assert.equal(u.searchParams.get('tmdbId'), '94605');
    assert.equal(u.searchParams.get('mediaType'), 'tv');
    const rousavUrl = `${origin}/media/rousav94605/index.m3u8?api_key=testkey`;
    const vidboltFr1 = `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/m/tok_orion_fr_720?f=.m3u8`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`;
    const vidboltFr2 = `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/m/tok_valstrax_fr_720?f=.m3u8`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`;
    const bridgeLatAm = `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/bridge/?url=${encodeURIComponent(`${origin}/dash/94605_1_1_1080_h265_01/master.m3u8`)}`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`;
    const bridgeBn = `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/bridge/?url=${encodeURIComponent(`${origin}/dash/94605_1_1_720_h265_02/master.m3u8`)}`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`;
    const hardsubKu = `/api/proxy-m3u8?url=${encodeURIComponent(`${origin}/bridge/?url=${encodeURIComponent(`${origin}/dash/94605_1_1_1080_h265_ku/master.m3u8`)}`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        sources: [
          {
            url: rousavUrl,
            type: 'hls',
            resolution: 1080,
            resolutions: [1080, 720, 480],
            label: '1080p • Multi-Audio (English, Hindi)',
            language: 'English',
            audioLanguages: ['English', 'Hindi'],
            originServer: 'orion',
          },
          {
            url: vidboltFr1,
            type: 'hls',
            resolution: 720,
            resolutions: [720],
            label: '720p • French',
            language: 'French',
            audioLanguages: ['French'],
            originServer: 'orion',
          },
        ],
        byServer: {
          orion: {
            sources: [
              {
                url: rousavUrl,
                type: 'hls',
                resolution: 1080,
                resolutions: [1080, 720, 480],
                label: '1080p • Multi-Audio (English, Hindi)',
                language: 'English',
                audioLanguages: ['English', 'Hindi'],
                originServer: 'orion',
              },
              {
                url: vidboltFr1,
                type: 'hls',
                resolution: 720,
                resolutions: [720],
                label: '720p • French',
                language: 'French',
                audioLanguages: ['French'],
                originServer: 'orion',
              },
            ],
          },
          valstrax: {
            sources: [
              {
                url: rousavUrl,
                type: 'hls',
                resolution: 1080,
                resolutions: [1080, 720, 480],
                label: '1080p • Multi-Audio (English, Hindi)',
                language: 'English',
                audioLanguages: ['English', 'Hindi'],
                originServer: 'valstrax',
              },
              {
                url: vidboltFr2,
                type: 'hls',
                resolution: 720,
                resolutions: [720],
                label: '720p • French',
                language: 'French',
                audioLanguages: ['French'],
                originServer: 'valstrax',
              },
              {
                url: hardsubKu,
                type: 'hls',
                resolution: 1080,
                resolutions: [1080],
                label: '1080p • Kurdish sub',
                language: 'Kurdish sub',
                audioLanguages: ['Kurdish sub'],
                originServer: 'valstrax',
              },
            ],
          },
          zenith: {
            sources: [
              {
                url: bridgeLatAm,
                type: 'hls',
                resolution: 1080,
                resolutions: [1080],
                label: '1080p • Spanish (LatAm)',
                language: 'Spanish (LatAm)',
                audioLanguages: ['Spanish (LatAm)'],
                originServer: 'zenith',
              },
              {
                url: bridgeBn,
                type: 'hls',
                resolution: 720,
                resolutions: [720],
                label: '720p • Bengali',
                language: 'Bengali',
                audioLanguages: ['Bengali'],
                originServer: 'zenith',
              },
            ],
          },
        },
        dubs: [
          { lanCode: 'en', lanName: 'English', original: true, dubType: '0' },
          { lanCode: 'hi', lanName: 'Hindi', original: false, dubType: '0' },
          { lanCode: 'fr', lanName: 'French', original: false, dubType: '0' },
          { lanCode: 'es', lanName: 'Spanish', original: false, dubType: '0' },
          { lanCode: 'bn', lanName: 'Bengali', original: false, dubType: '0' },
          { lanCode: 'ku', lanName: 'Kurdish sub', original: false, dubType: '0' },
        ],
        subtitles: [
          {
            url: `/api/proxy-segment?url=${encodeURIComponent(`${origin}/media/rousav94605/subs_en.vtt`)}&ref=${encodeURIComponent('https://vidbolt.xyz/')}`,
            lang: 'en',
            label: '1. English [CC]',
          },
        ],
      }),
    );
    return;
  }

  // Source 2 rousav endpoints: child playlists 404 unless Referer: https://vidbolt.xyz/ is sent!
  if (u.pathname === '/media/rousav94605/index.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="1. English",DEFAULT=YES,AUTOSELECT=YES,URI="track_english.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="hin",NAME="2. Hindi",DEFAULT=NO,AUTOSELECT=YES,URI="track_hindi.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="audio"',
        'video_720p.m3u8',
      ].join('\n'),
    );
    return;
  }
  if (
    u.pathname === '/media/rousav94605/video_720p.m3u8' ||
    u.pathname === '/media/rousav94605/track_english.m3u8' ||
    u.pathname === '/media/rousav94605/track_hindi.m3u8' ||
    u.pathname === '/media/rousav1218925/video_720p.m3u8' ||
    u.pathname === '/media/rousav1218925/track_hi.m3u8'
  ) {
    if (req.headers.referer !== 'https://vidbolt.xyz/') {
      res.writeHead(404);
      res.end('404 Not Found (nginx)');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\n/cdn/hub/seg0.m4s\n#EXT-X-ENDLIST\n');
    return;
  }
  if (u.pathname === '/media/rousav1218925/index.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="hin",NAME="Hindi",DEFAULT=YES,URI="track_hi.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="eng",NAME="English",DEFAULT=NO,URI="track_hi.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="kor",NAME="Korean",DEFAULT=NO,URI="track_hi.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="tha",NAME="Thai",DEFAULT=NO,URI="track_hi.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
        'video_720p.m3u8',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname === '/bridge/' || u.pathname === '/bridge') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\n/cdn/hub/seg0.m4s\n#EXT-X-ENDLIST\n');
    return;
  }
  if (u.pathname === '/dash-hls-bridge/' || u.pathname === '/dash-hls-bridge') {
    // Outer CloudFront query params MUST be preserved (never unwrapped to bare `url=`)!
    if (u.searchParams.get('Signature') !== 'SIG_OUTER_OK') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Missing outer CloudFront signature');
      return;
    }
    if (u.searchParams.get('mode') === 'variant') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="/cdn/hub/init.mp4"\n#EXTINF:6.0,\n/cdn/hub/seg0.m4s\n#EXT-X-ENDLIST\n');
      return;
    }
    const innerParam = u.searchParams.get('url') || '';
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${origin}/dash-hls-bridge/?mode=variant&v=3&url=${encodeURIComponent(innerParam)}&Signature=SIG_OUTER_OK"`,
        `#EXT-X-STREAM-INF:BANDWIDTH=2328000,RESOLUTION=2542x1080,AUDIO="audio"`,
        `${origin}/dash-hls-bridge/?mode=variant&v=0&url=${encodeURIComponent(innerParam)}&Signature=SIG_OUTER_OK`,
      ].join('\n'),
    );
    return;
  }
  if (u.pathname === '/media/rousav94605/subs_en.vtt') {
    if (req.headers.referer !== 'https://vidbolt.xyz/') {
      res.writeHead(404);
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/vtt' });
    res.end(
      [
        'WEBVTT',
        '',
        '1',
        '00:00:01.000 --> 00:00:03.000',
        'Watch movies online at aethoflix.world',
        '',
        '2',
        '00:00:04.000 --> 00:00:07.000',
        'Real subtitle line from Source 2.',
        '',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname.startsWith('/m/tok_')) {
    if (req.headers.referer !== 'https://vidbolt.xyz/') {
      res.writeHead(502);
      res.end('Bad gateway without Referer');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\n/cdn/hub/seg0.m4s\n#EXT-X-ENDLIST\n');
    return;
  }

  if (u.pathname === '/cdn/protected/master.m3u8') {
    if (req.headers.referer !== 'https://api.hlowb.com/') {
      res.writeHead(403);
      res.end('Missing required Referer!');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\nv0.m3u8\n');
    return;
  }
  if (u.pathname === '/cdn/hub/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Hindi",LANGUAGE="hi",DEFAULT=YES,URI="a_hi.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="a_en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
        'v0.m3u8',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname.endsWith('/v0.m3u8') || u.pathname.endsWith('/a_hi.m3u8')) {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.0,',
        'seg0.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname.endsWith('/init.mp4') || u.pathname.endsWith('/seg0.m4s')) {
    if (req.headers.range === 'bytes=0-3') {
      res.writeHead(206, {
        'Content-Type': 'video/iso.segment',
        'Content-Range': `bytes 0-3/${SEGMENT_BYTES.length}`,
        'Content-Length': '4',
      });
      res.end(SEGMENT_BYTES.subarray(0, 4));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/iso.segment',
      'Content-Length': String(SEGMENT_BYTES.length),
    });
    res.end(SEGMENT_BYTES);
    return;
  }

  // Hybrid offload test fixtures:
  //  - /edge-cors/* : anonymous, Referer-free, returns Access-Control-Allow-Origin: *
  //  - /edge-echo-cors/* : echoes only the probe Origin (must stay relayed!)
  //  - /edge-nocors/* : anonymous, but omits Access-Control-Allow-Origin (must stay relayed!)
  //  - /edge-reflock/* : sends CORS *, but 403s without Referer (must stay relayed!)
  if (u.pathname === '/edge-echo-cors/variant.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:6.0,',
        `${origin}/edge-echo-cors/chunk-0001.m4s`,
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname === '/edge-echo-cors/chunk-0001.m4s') {
    res.writeHead(200, {
      'Content-Type': 'video/iso.segment',
      'Access-Control-Allow-Origin': String(req.headers.origin || ''),
      Vary: 'Origin',
      'Content-Length': String(SEGMENT_BYTES.length),
    });
    res.end(SEGMENT_BYTES);
    return;
  }
  if (u.pathname === '/edge-cors/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\n/edge-cors/variant.m3u8\n');
    return;
  }
  if (u.pathname === '/edge-cors/variant.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        `#EXT-X-KEY:METHOD=AES-128,URI="${origin}/edge-cors/enc.key"`,
        `#EXT-X-MAP:URI="${origin}/edge-cors/init.m4s"`,
        '#EXTINF:6.0,',
        `${origin}/edge-cors/chunk-0001.m4s?Policy=abc&Signature=sig1&Key-Pair-Id=K1`,
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname === '/edge-cors/enc.key') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.alloc(16, 0x42));
    return;
  }
  if (u.pathname === '/edge-cors/init.m4s' || u.pathname === '/edge-cors/chunk-0001.m4s') {
    // Reject if a foreign Referer leaked — verifies headerless CORS probe!
    if (req.headers.referer) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Unexpected Referer leaked');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/iso.segment',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': String(SEGMENT_BYTES.length),
    });
    res.end(SEGMENT_BYTES);
    return;
  }
  if (u.pathname === '/edge-nocors/variant.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:6.0,',
        `${origin}/edge-nocors/chunk-0001.m4s`,
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname === '/edge-nocors/chunk-0001.m4s') {
    res.writeHead(200, {
      'Content-Type': 'video/iso.segment',
      'Content-Length': String(SEGMENT_BYTES.length),
    });
    res.end(SEGMENT_BYTES);
    return;
  }
  if (u.pathname === '/edge-reflock/variant.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:6.0,',
        `${origin}/edge-reflock/chunk-0001.m4s`,
        '#EXT-X-ENDLIST',
      ].join('\n'),
    );
    return;
  }
  if (u.pathname === '/edge-reflock/chunk-0001.m4s') {
    if (req.headers.referer !== 'https://vidbolt.xyz/') {
      res.writeHead(403, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' });
      res.end('Missing Referer');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/iso.segment',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': String(SEGMENT_BYTES.length),
    });
    res.end(SEGMENT_BYTES);
    return;
  }

  res.writeHead(404);
  res.end();
});

await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
const upPort = mockUpstream.address().port;
const upBase = `http://127.0.0.1:${upPort}`;

const { server: elfuraServer } = createBackendServer({
  host: '127.0.0.1',
  port: 0,
  isProd: true,
  secret,
  allowedOrigins: ['https://watch.elfura.example'],
  requireToken: true,
  bindTokenIp: false,
  rateLimitPerMin: 120,
  resolveTimeoutMs: 8000,
  tmdb: {
    apiBase: `${upBase}/tmdb`,
    apiKey: '',
    bearerToken: '',
    imageBase: 'https://image.tmdb.org/t/p',
    timeoutMs: 3000,
  },
  source1: {
    enabled: true,
    appOrigin: upBase,
    apiOrigin: upBase,
    riftOrigin: upBase,
    vidboltOrigin: upBase, // Keep integration tests isolated from live upstreams.
    riftRelay: upBase,
    syncOrigin: upBase,
  },
  source2: {
    enabled: true,
    embedOrigin: upBase,
    defaultServer: 'orion',
    nxshaOrigin: upBase,
    vidstuckOrigin: upBase,
  },
  source3: {
    enabled: true,
    origin: upBase,
  },
  source4: { enabled: false },
  subtitles: {
    enabled: true,
    openSubtitlesBase: `${upBase}/opensubs`,
    timeoutMs: 2500,
  },
});

await new Promise((r) => elfuraServer.listen(0, '127.0.0.1', r));
const apiPort = elfuraServer.address().port;
const apiBase = `http://127.0.0.1:${apiPort}`;

const browserHeaders = {
  Origin: 'https://watch.elfura.example',
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/137.0.0.0 Mobile Safari/537.36',
};

try {
  const healthRes = await fetch(`${apiBase}/api/v1/health`);
  assert.equal(healthRes.status, 200);
  const health = await healthRes.json();
  assert.deepEqual(health.sources, [
    { id: 'source-1', label: 'Source 1' },
    { id: 'source-2', label: 'Source 2' },
    { id: 'source-3', label: 'Source 3' },
  ]);

  // The public diagnostic reports observations, never upstream links or
  // credentials. A leaf playlist cannot become a verified quality ladder.
  const diagRes = await fetch(`${apiBase}/diagnose/?type=tv&tmdb=94605&s=1&e=1`);
  assert.equal(diagRes.status, 200);
  assert.match(diagRes.headers.get('cache-control') || '', /no-store/);
  const diag = await diagRes.json();
  assert.equal(diag.ok, true);
  assert.equal(diag.probe.tmdbId, '94605');
  assert.equal(diag.sources.length, 3);
  assert.equal(removedSourceCalls, 0, 'diagnostics must not call legacy source endpoints');
  assert(diag.sources.some((s) => s.options?.some((o) => o.probe?.manifestKind)));
  assert(!JSON.stringify(diag.sources).includes(upBase), 'diagnostic options must not expose upstream URLs');
  for (const source of diag.sources) {
    assert(source.options.length <= 20);
    for (const option of source.options) {
      assert.match(option.fingerprint, /^[a-f0-9]{12}$/);
      assert(!('url' in option) && !('headers' in option));
      if (option.probe?.manifestKind === 'hls-media') {
        assert.deepEqual(option.probe.qualityHeights, []);
      }
    }
  }
  for (let i = 0; i < 5; i++) {
    const cachedDiag = await fetch(`${apiBase}/api/v1/diagnostics?type=tv&tmdb=94605&s=1&e=1`);
    assert.equal(cachedDiag.status, 200);
  }
  const limitedDiag = await fetch(`${apiBase}/diagnostic?type=movie&tmdb=1`);
  assert.equal(limitedDiag.status, 429, 'different titles must not bypass the global diagnostics limit');

  // Public landing routes and live, sanitized TMDB catalog used by every
  // dynamic poster/demo/builder surface on the home page.
  for (const landingPath of ['/', '/demo', '/docs', '/status']) {
    const landingRes = await fetch(`${apiBase}${landingPath}`);
    assert.equal(landingRes.status, 200, `${landingPath} must serve the public landing site`);
    const landingHtml = await landingRes.text();
    assert(landingHtml.includes('TheOGPirateBot'));
    assert(landingHtml.includes('data-poster-track'));
    assert(!landingHtml.includes('https://image.tmdb.org/t/p/w500/'), 'Poster content must come from the catalog API, not fixed markup');
  }

  const brandIconRes = await fetch(`${apiBase}/icon-maskable-512.png`);
  assert.equal(brandIconRes.status, 200, 'production backend must serve the official root logo');
  assert.equal(brandIconRes.headers.get('content-type'), 'image/png');
  const brandIconBytes = Buffer.from(await brandIconRes.arrayBuffer());
  const expectedBrandIcon = await readFile(new URL('../../dist/icon-maskable-512.png', import.meta.url));
  assert(brandIconBytes.equals(expectedBrandIcon), 'served logo must be the exact supplied PNG');

  const catalogRes = await fetch(`${apiBase}/api/v1/catalog`, { headers: browserHeaders });
  assert.equal(catalogRes.status, 200);
  const catalog = await catalogRes.json();
  assert.equal(catalog.ok, true);
  assert.equal(catalog.movies[0].tmdbId, '533535');
  assert.equal(catalog.series[0].tmdbId, '94605');
  assert.equal(catalog.anime[0].type, 'anime');
  assert.equal(catalog.movies[0].poster, 'https://image.tmdb.org/t/p/w500/deadpool.jpg');
  assert.equal(catalog.movies[0].backdrop, 'https://image.tmdb.org/t/p/w1280/deadpool-wide.jpg');
  assert(!JSON.stringify(catalog).includes('api_key'), 'Catalog must never expose TMDB credentials');

  const badOriginRes = await fetch(`${apiBase}/api/v1/playback?type=tv&tmdb=94605&s=1&e=1`, {
    headers: { Origin: 'https://evil-scraper.example', 'User-Agent': browserHeaders['User-Agent'] },
  });
  assert.equal(badOriginRes.status, 403);

  const noTokRes = await fetch(`${apiBase}/api/v1/playback?type=tv&tmdb=94605&s=1&e=1`, {
    headers: browserHeaders,
  });
  assert.equal(noTokRes.status, 401);

  const embedRes = await fetch(`${apiBase}/embed/tv/94605/1/1`, {
    headers: { 'Sec-Fetch-Site': 'none', 'User-Agent': browserHeaders['User-Agent'] },
  });
  assert.equal(embedRes.status, 200);
  const embedHtml = await embedRes.text();
  const bootMatch = embedHtml.match(/window\.__ELFURA_BOOT__=(\{[^<]+\});/);
  assert(bootMatch);
  const boot = JSON.parse(bootMatch[1]);

  const pbRes = await fetch(
    `${apiBase}/api/v1/playback?type=tv&tmdb=94605&s=1&e=1&nonce=${boot.nonce}`,
    { headers: { ...browserHeaders, 'X-Playback-Token': boot.pltoken } },
  );
  assert.equal(pbRes.status, 200);
  const pb = await pbRes.json();
  assert.equal(pb.ok, true);
  assert.equal(removedSourceCalls, 0, 'legacy SOURCE2 settings must not activate removed providers');
  const upstreamUrls = pb.sources.map((s) => openStreamTicket(secret, new URL(s.url, apiBase).searchParams.get('t')).u);
  assert.equal(new Set(upstreamUrls).size, upstreamUrls.length, 'identical upstream streams must be deduplicated across groups');
  assert.equal(pb.media.title, 'Arcane · S1E1 — Welcome to the Playground');
  assert.equal(pb.segments, undefined, "TG skip endpoint must not be used");
  assert.equal(skipSegmentRequestCount, 0, "removed TG service must not be contacted");
  assert(pb.sources.length > 0, 'remaining providers should produce playable options');
  // A provider's quality catalogue is not proof that the selected manifest
  // actually contains multiple renditions; only measured ladders may rank so.
  // Hierarchy invariant: within the same multi-audio class, multi-quality
  // options never rank below single-quality or unknown-quality options.
  {
    const tierOf = (o) => {
      const n = o.qualityOptions ?? o.qualityLadder?.length ?? 0;
      if (n > 1) return 0;
      if (n === 1 || (o.quality && o.quality !== 'auto')) return 1;
      return 2;
    };
    let lastKey = '';
    for (const o of pb.sources) {
      const key = `${o.multiAudio ? '0' : '1'}:${tierOf(o)}`;
      assert(key >= lastKey, `Source hierarchy violated at ${o.label} (${key} after ${lastKey})`);
      lastKey = key;
    }
  }

  const rawJsonStr = JSON.stringify(pb);
  for (const forbidden of [
    'TG HUB',
    'Orion',
    'Castle',
    'VidZee',
    'hlowb',
    'aetho',
    'vidbolt',
    'rousav',
    'hakunaymatata',
    'valstrax',
    'zenith',
    String(upPort),
    '/cdn/',
  ]) {
    assert(!rawJsonStr.toLowerCase().includes(forbidden.toLowerCase()), `Leaked internal string: ${forbidden}`);
  }

  // The replacement Source 2 must resolve VidRift directly, not the removed adapter.
  const riftOption = pb.sources.find((s) => s.sourceId === 'source-2');
  assert(riftOption, 'Expected the VidRift fixture in Source 2');
  const riftMasterRes = await fetch(`${apiBase}${riftOption.url}`, { headers: browserHeaders });
  assert.equal(riftMasterRes.status, 200);
  assert((await riftMasterRes.text()).includes('#EXT-X-STREAM-INF'));

  const protectedOpt = pb.sources.find((s) => s.sourceId === 'source-3');
  const protectedMasterRes = await fetch(`${apiBase}${protectedOpt.url}`, { headers: browserHeaders });
  assert.equal(protectedMasterRes.status, 200);

  const primaryMasterRes = await fetch(`${apiBase}${pb.primary.url}`, { headers: browserHeaders });
  const primaryMaster = await primaryMasterRes.text();
  const variantLine = primaryMaster.split('\n').find((l) => l.startsWith('/api/v1/stream?t='));
  const variantRes = await fetch(`${apiBase}${variantLine}`, { headers: browserHeaders });
  const variantText = await variantRes.text();
  const segLine = variantText.split('\n').find((l) => l.startsWith('/api/v1/stream?t='));

  const segRangeRes = await fetch(`${apiBase}${segLine}`, {
    headers: { ...browserHeaders, Range: 'bytes=0-3' },
  });
  assert.equal(segRangeRes.status, 206);
  const segSlice = Buffer.from(await segRangeRes.arrayBuffer());
  assert.deepEqual(segSlice, SEGMENT_BYTES.subarray(0, 4));

  const subRes = await fetch(`${apiBase}${pb.primary.subtitles[0].url}`, { headers: browserHeaders });
  assert.equal(subRes.status, 200);
  assert((await subRes.text()).includes('Welcome to Piltover.'));

  // 7. Verify exhaustive raw-source audio search + fallback + unavailable message in ElfuraPlayer
  // Provide minimal DOM shims in Node so we can test ElfuraPlayer's real searchRawSourcesForLanguage logic
  const makeEl = (tag = 'div') => {
    const listeners = new Map();
    return {
      tagName: tag.toUpperCase(),
      dataset: {},
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      children: [],
      appendChild(c) { this.children.push(c); return c; },
      append(...cs) { this.children.push(...cs); },
      replaceChildren() { this.children = []; },
      remove() {},
      setAttribute() {},
      set src(v) {
        this._src = v;
        this.load();
      },
      get src() {
        return this._src || '';
      },
      removeAttribute(k) {
        if (k === 'src') this._src = '';
      },
      getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0 }),
      addEventListener(ev, fn, opts) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push({ fn, once: !!opts?.once });
      },
      removeEventListener(ev, fn) {
        if (!listeners.has(ev)) return;
        listeners.set(ev, listeners.get(ev).filter((x) => x.fn !== fn));
      },
      dispatch(ev) {
        const list = [...(listeners.get(ev) ?? [])];
        for (const item of list) {
          if (item.once) this.removeEventListener(ev, item.fn);
          item.fn({});
        }
      },
      pause() { this.paused = true; },
      play() { this.paused = false; return Promise.resolve(); },
      load() {
        queueMicrotask(() => {
          if (String(this.src || '').includes('dead-stream')) {
            if (typeof this.onerror === 'function') this.onerror(new Error('404'));
          } else if (this.src) {
            this.readyState = 2;
            this.dispatch('loadedmetadata');
          }
        });
      },
      paused: true,
      muted: false,
      volume: 1,
      playbackRate: 1,
      currentTime: 42,
      duration: 1200,
      readyState: 0,
      buffered: { length: 0, end: () => 0 },
      canPlayType: () => '',
    };
  };

  globalThis.window = {
    location: { pathname: '/embed/tv/94605/1/1', search: '', href: 'https://watch.elfura.example/embed/tv/94605/1/1' },
    parent: null,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window.parent = globalThis.window;
  globalThis.document = {
    referrer: '',
    fullscreenElement: null,
    pictureInPictureElement: null,
    createElement: (tag) => makeEl(tag),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.Audio = function () { return makeEl('audio'); };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};

  const player = new ElfuraPlayer({ postMessage: false });
  // Seed 4 raw sources: 1 English default, 1 DEAD Tamil raw source, 1 WORKING Tamil raw source, 1 DEAD Korean raw source
  player.sources = [
    {
      id: 'source-1:1',
      sourceId: 'source-1',
      label: 'Source 1 · English',
      type: 'mp4',
      url: 'https://cdn.example.com/ok-en.mp4',
      quality: '1080p',
      audioLang: 'en',
      audioTracks: [],
      subtitles: [],
    },
    {
      id: 'source-1:2',
      sourceId: 'source-1',
      label: 'Source 1 · Tamil',
      type: 'mp4',
      url: 'https://cdn.example.com/dead-stream-ta-1.mp4',
      quality: '1080p',
      audioLang: 'ta',
      audioTracks: [],
      subtitles: [],
    },
    {
      id: 'source-2:1',
      sourceId: 'source-2',
      label: 'Source 2 · Tamil',
      type: 'mp4',
      url: 'https://cdn.example.com/working-ta-2.mp4',
      quality: '720p',
      audioLang: 'ta',
      audioTracks: [],
      subtitles: [],
    },
    {
      id: 'source-1:4',
      sourceId: 'source-1',
      label: 'Source 1 · Korean',
      type: 'mp4',
      url: 'https://cdn.example.com/dead-stream-ko-1.mp4',
      quality: '1080p',
      audioLang: 'ko',
      audioTracks: [],
      subtitles: [],
    },
  ];

  await player.setSource('source-1:1');
  player.video.load();
  await new Promise((r) => setTimeout(r, 20));

  // Verify dynamic audio tracks contain ONLY what raw sources reported (English, Korean, Tamil — zero hardcoded langs!)
  assert.deepEqual(
    player.getAudioTracks().map((t) => t.lang).sort(),
    ['en', 'ko', 'ta'],
  );

  // Case A: Select Tamil -> Source 1 raw source (source-1:2) is DEAD, player automatically searches across adapters to Source 2 (source-2:1) and succeeds!
  const tamilOk = await player.setAudio('ta');
  assert.equal(tamilOk, true);
  assert.equal(player.getState().source, 'source-2:1');
  assert.equal(player.getState().audioLang, 'ta');

  // Case B: Select Korean -> only Korean raw source (source-1:4) is DEAD -> searches all sources, restores working stream, emits exact message!
  let unavailableEvent = null;
  player.bus.on('audio:unavailable', (d) => { unavailableEvent = d; });
  const koreanOk = await player.setAudio('ko');
  assert.equal(koreanOk, false);
  assert(unavailableEvent, 'Expected audio:unavailable event when all Korean raw sources fail');
  assert.equal(
    unavailableEvent.message,
    'Sorry, we searched all sources yet didn\'t find it in "Korean"',
  );
  assert.equal(player.getState().source, 'source-2:1'); // restored working stream!

  // Case C: Request German ('de') which NO raw source has at all -> searches all sources & emits exact message!
  unavailableEvent = null;
  const germanOk = await player.setAudio('de');
  assert.equal(germanOk, false);
  assert.equal(
    unavailableEvent?.message,
    'Sorry, we searched all sources yet didn\'t find it in "German"',
  );

  player.destroy();

  // 7b. An early probe win aborts the rest of its wave. Aborted candidates were
  // previously mislabeled as language-rejected and skipped by the engine fallback.
  // Prove that a later multi-audio source is tried, and that no-winner races also
  // exhaust every candidate before reporting a language unavailable.
  // Exercise the actual loadDash handler against dash.js 5's representation API.
  const dashPlayer = new ElfuraPlayer({ postMessage: false });
  await dashPlayer.loadDash('https://cdn.example.com/movie.mpd');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(dashPlayer.getQualityLevels().map((q) => q.height), [1080, 720, 480]);
  dashPlayer.setQuality(720);
  assert.deepEqual(globalThis.__elfuraDashTestPlayer.selections.at(-1), { type: 'video', index: 1, forceReplace: true });
  assert.equal(globalThis.__elfuraDashTestPlayer.settingsCalls.at(-1).streaming.abr.autoSwitchBitrate.video, false);
  assert.equal(dashPlayer.getState().effectiveHeight, 0, 'selection must not claim a rendered height');
  globalThis.__elfuraDashTestPlayer.emitRendered(720);
  assert.equal(dashPlayer.getState().effectiveHeight, 720);
  dashPlayer.setQuality('auto');
  assert.equal(globalThis.__elfuraDashTestPlayer.settingsCalls.at(-1).streaming.abr.autoSwitchBitrate.video, true);
  dashPlayer.destroy();
  delete globalThis.__elfuraDashTestPlayer;

  // A single stalled initial source must not leave the startup screen forever:
  // retry both provider groups and actually attach a newly discovered option.
  {
    const originalFetch=globalThis.fetch;
    const dead={...pb.primary,id:'source-3:1',sourceId:'source-3',fingerprint:'dead-initial',multiAudio:false,audioTracks:[],subtitles:[]};
    const good={...dead,id:'source-2:1',sourceId:'source-2',fingerprint:'late-good',multiAudio:true,availableAudioLangs:['en','hi']};
    let requested=[];
    globalThis.fetch=async input=>{const u=new URL(String(input));if(u.hostname!=='retry.example')return new Response('',{status:404});requested.push(u.searchParams.get('source'));return Response.json({ok:true,sources:u.searchParams.get('source')==='source-2'?[good]:[dead]})};
    try {
      const p=new ElfuraPlayer({postMessage:false});p.input.config.tmdb='693134';p.input.config.mediaType='movie';p.input.config.api='https://retry.example/api/v1/playback';p.sources=[dead];p.currentSource=dead;
      let active; p.activateSourceOption=async opt=>{active=opt;p.currentSource=opt};
      p.failover();await new Promise(r=>setTimeout(r,40));
      assert.deepEqual(requested.sort(),['source-1','source-2','source-3','source-4','source-5','source-6']);assert.equal(active?.fingerprint,'late-good');assert.equal(p.getSources().filter(x=>x.fingerprint==='dead-initial').length,1);
      p.failover();await new Promise(r=>setTimeout(r,20));assert.equal(requested.length,6,'exhaustion recovery must be bounded');
      p.destroy();
    } finally {globalThis.fetch=originalFetch;}
  }
  // The watchdog must cover a single option too and not stop at metadata or
  // the first fragment: it is released only once decoded data is available.
  {
    const p=new ElfuraPlayer({postMessage:false}); const opt={...pb.primary,id:'only-option',sourceId:'source-3'};p.sources=[opt];p.currentSource=opt;p.video.readyState=0;
    const oldTimer=globalThis.setTimeout;let callback,delay,called=0;globalThis.setTimeout=(fn,ms)=>{callback=fn;delay=ms;return 1};p.failover=()=>{called++};
    try {p.armStartupWatchdog(opt.id);assert.equal(delay,3000);callback();assert.equal(called,1);}finally{globalThis.setTimeout=oldTimer;p.startupWatchdogTimer=null;p.destroy();}
  }

  // A late multi-audio group must appear without interrupting or relabelling
  // the active Korean stream. The recovery request uses the same API origin.
  {
    const oldFetch = globalThis.fetch;
    let releaseRecovery;
    const recoveryGate = new Promise((resolve) => { releaseRecovery = resolve; });
    const primary = { ...pb.primary, id: 'source-3:late-test', sourceId: 'source-3', audioLang: 'ko', multiAudio: false, availableAudioLangs: [], fingerprint: 'lateprimary', audioTracks: [], subtitles: [] };
    const multi = { ...primary, id: 'source-1:1', sourceId: 'source-1', label: 'Source 1 · Multi-Audio', audioLang: undefined, multiAudio: true, availableAudioLangs: ['ko', 'hi'], fingerprint: 'latemulti' };
    let recoveryCalls = 0;
    globalThis.fetch = async (input) => {
      const u = new URL(String(input));
      assert.equal(u.origin, 'https://recovery.example');
      if (u.searchParams.get('source') === 'source-1') {
        recoveryCalls++;
        await recoveryGate;
        return new Response(JSON.stringify({ ok: true, sources: [multi] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, sources: [primary], primary }), { status: 200 });
    };
    try {
      const p = new ElfuraPlayer({ postMessage: false, api: 'https://recovery.example/api/v1/playback', tmdb: '123456', mediaType: 'movie', pltoken: 'test-token', nonce: 'test-nonce' });
      p.selectFastestInitialSource = async (_sources, fallback) => fallback;
      p.activateSourceOption = async (option) => { p.currentSource = option; };
      const updated = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('late source recovery timed out')), 3000);
        p.bus.on('sourcesUpdated', () => { clearTimeout(timer); resolve(); });
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(recoveryCalls, 1);
      assert.equal(p.currentSource?.id, primary.id);
      p.mergeNativeAudio([{ id: 0, lang: 'ko', label: 'Korean', default: true }]);
      releaseRecovery();
      await updated;
      assert(p.getSources().some((s) => s.fingerprint === 'latemulti'));
      assert(p.getAudioTracks().some((t) => t.lang === 'hi'));
      assert.equal(p.currentSource?.id, primary.id);
      assert.equal(p.getState().audioLang, 'ko', 'a newly discovered Hindi option is not already playing');
      p.destroy();
    } finally { globalThis.fetch = oldFetch; }
  }

  // A late multi-audio source must trigger the explicit Hindi preference,
  // even when the track menu previously listed Hindi as an unplayed source hint.
  {
    const oldFetch=globalThis.fetch;
    let release; const gate=new Promise(r=>{release=r});
    const primary={...pb.primary,id:'anime-primary',sourceId:'source-3',audioLang:'en',multiAudio:false,availableAudioLangs:[],audioTracks:[],subtitles:[]};
    const anime={...primary,id:'source-1:1',sourceId:'source-1',audioLang:undefined,multiAudio:true,availableAudioLangs:['hi','en'],fingerprint:'anime-new'};
    globalThis.fetch=async input=>{const u=new URL(String(input));if(u.searchParams.get('source')==='source-1'){await gate;return Response.json({ok:true,sources:[anime]})}if(u.searchParams.get('source'))return new Response('',{status:404});return Response.json({ok:true,primary,sources:[primary]})};
    try{
      const p=new ElfuraPlayer({postMessage:false,api:'https://anime-recovery.example/api/v1/playback',tmdb:'95479',mediaType:'tv',season:1,episode:1,lang:'hi',pltoken:'token',nonce:'nonce'});
      p.activateSourceOption=async option=>{p.currentSource=option};let requested=[];p.setAudio=async lang=>{requested.push(lang);return true};
      await new Promise(r=>setTimeout(r,20));assert.equal(p.currentSource?.id,primary.id);
      p.currentAudio={id:'hint-hi',kind:'source',lang:'hi',label:'Hindi',ref:'hi'};
      release();await new Promise(r=>setTimeout(r,30));assert(p.getSources().some(s=>s.sourceId==='source-1'));assert.deepEqual(requested,['hi']);p.destroy();
    }finally{globalThis.fetch=oldFetch}
  }

  // A source-specific playback request can recover the same fingerprint after
  // the startup probe times out, without duplicating or restarting it.
  {
    const oldFetch=globalThis.fetch;let calls=0,release;const gate=new Promise(r=>{release=r});
    const fallback={...pb.primary,id:'late-source-1',sourceId:'source-1',audioLang:undefined,multiAudio:false,availableAudioLangs:[],fingerprint:'same-vidbolt',audioTracks:[],subtitles:[]};
    const proven={...fallback,multiAudio:true,availableAudioLangs:['hi','en']};
    globalThis.fetch=async input=>{if(!String(input).includes('/api/v1/playback'))return new Response('',{status:404});calls++;if(calls===1)return Response.json({ok:true,primary:fallback,sources:[fallback]});await gate;return Response.json({ok:true,primary:proven,sources:[proven]});};
    try {const p=new ElfuraPlayer({postMessage:false,api:'https://recovery.example/api/v1/playback',tmdb:'872585',mediaType:'movie',source:'source-1',pltoken:'token',nonce:'nonce'});
      p.activateSourceOption=async opt=>{p.currentSource=opt};await new Promise(r=>setTimeout(r,20));assert.equal(calls,2);release();await new Promise(r=>setTimeout(r,30));assert.equal(p.getSources().length,1);assert.equal(p.getSources()[0].multiAudio,true);assert.deepEqual(p.getSources()[0].availableAudioLangs,['hi','en']);p.destroy();
    } finally {globalThis.fetch=oldFetch;}
  }

  // Preferred Hindi must choose a known matching source without running the
  // exhaustive audio search before the first source is attached.
  {
    const oldFetch = globalThis.fetch;
    const eng = { ...pb.primary, id:'initial-english', sourceId:'source-2', audioLang:'en', multiAudio:false, availableAudioLangs:[], audioTracks:[], subtitles:[] };
    const hin = { ...eng, id:'initial-hindi-multi', audioLang:undefined, multiAudio:true, availableAudioLangs:['en','hi'] };
    globalThis.fetch = async () => new Response(JSON.stringify({ok:true,primary:eng,sources:[eng,hin]}),{status:200});
    try {
      const p = new ElfuraPlayer({postMessage:false,api:'https://initial.example/api/v1/playback',tmdb:'123456',mediaType:'movie',source:'source-2',lang:'hi',pltoken:'token',nonce:'nonce'});
      let searches=0, selected=null;
      p.setAudio = async () => { searches++; return false; };
      p.activateSourceOption = async (option) => { selected=option.id; p.currentSource=option; };
      await new Promise(r=>setTimeout(r,20));
      assert.equal(selected,'initial-hindi-multi');
      assert.equal(searches,0,'Initial playback must not wait for exhaustive audio search');
      assert.equal(p.desiredAudioLang,'hi');
      p.destroy();
    } finally { globalThis.fetch=oldFetch; }
  }

  const searchPlayer = new ElfuraPlayer({ postMessage: false });
  const searchSources = [
    {
      id: 'initial-en', sourceId: 'source-1', label: 'Source 1', type: 'mp4',
      url: 'https://cdn.example.com/initial-en.mp4', quality: '720p', audioLang: 'en',
      audioTracks: [], subtitles: [],
    },
    {
      id: 'multi-bad', sourceId: 'source-1', label: 'Source 1', type: 'hls',
      url: 'https://watch.elfura.example/api/v1/stream?t=multi-bad', quality: '1080p',
      multiAudio: true, availableAudioLangs: ['hi', 'en'], fingerprint: 'multi-bad-fp',
      latencyHintMs: 1, audioTracks: [], subtitles: [],
    },
    {
      id: 'multi-good', sourceId: 'source-2', label: 'Source 2', type: 'hls',
      url: 'https://watch.elfura.example/api/v1/stream?t=multi-good', quality: '720p',
      multiAudio: true, availableAudioLangs: ['hi', 'en'], fingerprint: 'multi-good-fp',
      latencyHintMs: 500, audioTracks: [], subtitles: [],
    },
    {
      id: 'direct-hi', sourceId: 'source-2', label: 'Source 2', type: 'hls',
      url: 'https://watch.elfura.example/api/v1/stream?t=direct-hi', quality: '1080p',
      audioLang: 'hi', fingerprint: 'direct-hi-fp', latencyHintMs: 1,
      audioTracks: [], subtitles: [],
    },
  ];
  searchPlayer.sources = searchSources;
  searchPlayer.currentSource = searchSources[0];

  // HLS event-order regression: MANIFEST_PARSED can run before
  // AUDIO_TRACKS_UPDATED has replaced the previous source's track list. The
  // incoming manifest, not stale this.audioTracks, must select Hindi.
  const hlsOrderPlayer = new ElfuraPlayer({ postMessage: false });
  hlsOrderPlayer.currentSource = searchSources[1];
  hlsOrderPlayer.audioTracks = [
    { id: 'native:0', kind: 'native', lang: 'en', label: 'English', ref: 0 },
  ];
  let manifestProbeResult = null;
  const manifestProbeDone = new Promise((resolve) => {
    hlsOrderPlayer.activeProbe = {
      seq: 1,
      targetLang: 'hi',
      opt: searchSources[1],
      startedAt: Date.now(),
      settle: (result) => {
        manifestProbeResult = result;
        resolve(result);
      },
    };
  });
  await hlsOrderPlayer.loadHls(searchSources[1].url);
  await manifestProbeDone;
  // Let the mock finish its ordered event sequence even when a regression
  // settles early; assertions below then identify the incorrect probe result.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    hlsOrderPlayer.hls.eventLog,
    ['manifest', 'audioTracks', 'fragment'],
    'test must exercise manifest parsing before audio-track registration',
  );
  assert.equal(manifestProbeResult?.ok, true, 'real manifest handler must accept incoming Hindi');
  assert.equal(hlsOrderPlayer.hls.audioTrack, 1, 'real manifest handler must select Hindi directly');
  hlsOrderPlayer.destroy();

  // Fake language switch regression: a candidate whose metadata claims
  // [hi, en] but whose manifest exposes only an English track must REJECT a
  // Hindi probe — never report a switch that does not change the audio.
  {
    const fakeProbePlayer = new ElfuraPlayer({ postMessage: false });
    const fakeCand = {
      id: 'fake-multi', sourceId: 'source-1', label: 'Source 1', type: 'hls',
      url: 'https://watch.elfura.example/api/v1/stream?t=fake', quality: '1080p',
      multiAudio: true, availableAudioLangs: ['hi', 'en'], audioTracks: [], subtitles: [],
    };
    const accepted = fakeProbePlayer.applyHlsProbeAudioSelection(
      { targetLang: 'hi', opt: fakeCand },
      [{ id: 0, lang: 'en', name: 'English' }],
      { audioTrack: 0 },
    );
    assert.equal(accepted, false, 'single-track manifest must reject metadata-claimed language switch');
    const directCand = { ...fakeCand, multiAudio: false, availableAudioLangs: ['hi'], audioLang: 'hi' };
    const directAccepted = fakeProbePlayer.applyHlsProbeAudioSelection(
      { targetLang: 'hi', opt: directCand },
      [],
      { audioTrack: 0 },
    );
    assert.equal(directAccepted, true, 'direct single-dub metadata match must still be accepted');
    fakeProbePlayer.destroy();
  }

  // An empty EXT-X-MEDIA list is inconclusive. It must not mark a multi-audio
  // candidate languageRejected and thereby exclude it from the real engine pass.
  const previousProbeFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n', {
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    });
    const unlisted = await searchPlayer.probeCandidateViaFetch(
      {
        ...searchSources[1],
        id: 'unlisted-hindi',
        audioLang: 'und',
        availableAudioLangs: [],
      },
      'hi',
      new AbortController().signal,
    );
    assert.equal(unlisted.ok, true, 'unknown audio metadata must remain eligible for engine probing');
    assert.notEqual(unlisted.languageRejected, true);
  } finally {
    globalThis.fetch = previousProbeFetch;
  }

  let languageAttempts = [];
  let racedOrder = [];
  searchPlayer.raceCandidatesBatch = async (wave) => {
    racedOrder = wave.map((s) => s.id);
    // Only multi-bad answered; every other candidate was aborted/unknown.
    return { winner: wave[0], winners: [wave[0]], failed: [], rejected: [] };
  };
  searchPlayer.probeRawCandidateForLanguage = async (opt) => {
    languageAttempts.push(opt.id);
    searchPlayer.currentSource = opt;
    return { ok: opt.id === 'multi-good' };
  };
  const recoveredHindi = await searchPlayer.searchRawSourcesForLanguage('hi', 'Hindi');
  assert.equal(recoveredHindi, true, 'Later multi-audio source must recover after the first winner rejects Hindi');
  assert.deepEqual(racedOrder, ['multi-bad', 'multi-good', 'direct-hi'], 'Multi-audio must precede direct Hindi regardless of latency');
  assert.deepEqual(languageAttempts, ['multi-bad', 'multi-good'], 'Aborted multi-good probe must receive a real engine attempt');
  assert.equal(searchPlayer.getState().audioLang, 'hi');

  // Even when a direct Hindi stream is already healthy, explicit selection must
  // not bypass the higher-priority multi-audio tier.
  languageAttempts = [];
  searchPlayer.currentSource = searchSources[3];
  searchPlayer.video.readyState = 2;
  const prioritizedHindi = await searchPlayer.setAudio('hi');
  assert.equal(prioritizedHindi, true);
  assert.equal(searchPlayer.getState().source, 'multi-good');
  assert.deepEqual(languageAttempts, ['multi-bad', 'multi-good']);

  languageAttempts = [];
  searchPlayer.currentSource = searchSources[0];
  searchPlayer.raceCandidatesBatch = async () => ({ winner: null, winners: [], failed: [], rejected: [] });
  searchPlayer.probeRawCandidateForLanguage = async (opt) => {
    languageAttempts.push(opt.id);
    searchPlayer.currentSource = opt;
    return { ok: false };
  };
  const exhaustiveMiss = await searchPlayer.searchRawSourcesForLanguage('hi', 'Hindi');
  assert.equal(exhaustiveMiss, false);
  assert.deepEqual(languageAttempts, ['multi-bad', 'multi-good', 'direct-hi'], 'Unavailable requires an actual attempt for every compatible source');
  searchPlayer.destroy();

  // 9. Verify concurrent fastest-server racing (not sequential top-to-bottom) in ElfuraPlayer
  const deadTicket = `/api/v1/stream?t=${encodeURIComponent(sealStreamTicket(secret, { u: `${upBase}/race/dead.mp4`, k: 'a' }))}`;
  const slowTicket = `/api/v1/stream?t=${encodeURIComponent(sealStreamTicket(secret, { u: `${upBase}/race/slow-hi.mp4`, k: 'a' }))}`;
  const fastTicket = `/api/v1/stream?t=${encodeURIComponent(sealStreamTicket(secret, { u: `${upBase}/race/fast-hi.mp4`, k: 'a' }))}`;

  // Point window.location at our real loopback Elfura backend (non-embed path so manual sources aren't overwritten)
  globalThis.window.location = {
    pathname: '/player-test',
    search: '',
    href: `${apiBase}/player-test`,
  };
  const rawNodeFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) =>
    rawNodeFetch(input, {
      ...init,
      headers: {
        Referer: globalThis.window.location.href,
        ...(init.headers || {}),
      },
    });

  const racePlayer = new ElfuraPlayer({ postMessage: false });
  racePlayer.sources = [
    {
      id: 'source-1:en',
      sourceId: 'source-1',
      label: 'Source 1 · English',
      type: 'mp4',
      url: fastTicket,
      fingerprint: 'fp_en_000001',
      latencyHintMs: 50,
      quality: '1080p',
      audioLang: 'en',
      audioTracks: [],
      subtitles: [],
    },
    {
      id: 'source-1:dead-hi',
      sourceId: 'source-1',
      label: 'Source 1 · Hindi',
      type: 'mp4',
      url: deadTicket,
      fingerprint: 'fp_hi_dead01',
      latencyHintMs: 200,
      quality: '1080p',
      audioLang: 'hi',
      audioTracks: [],
      subtitles: [],
    },
    {
      id: 'source-2:slow-hi',
      sourceId: 'source-2',
      label: 'Source 2 · Hindi',
      type: 'mp4',
      url: slowTicket,
      fingerprint: 'fp_hi_slow02',
      latencyHintMs: 250,
      quality: '1080p',
      audioLang: 'hi',
      audioTracks: [],
      subtitles: [],
    },
    {
      id: 'source-2:fast-hi',
      sourceId: 'source-2',
      label: 'Source 2 · Hindi #2',
      type: 'mp4',
      url: fastTicket,
      fingerprint: 'fp_hi_fast03',
      latencyHintMs: 300,
      quality: '1080p',
      audioLang: 'hi',
      audioTracks: [],
      subtitles: [],
    },
  ];
  await racePlayer.setSource('source-1:en');
  await new Promise((r) => setTimeout(r, 20));

  const raceStart = Date.now();
  const hiRaceOk = await racePlayer.setAudio('hi');
  const raceElapsedMs = Date.now() - raceStart;
  assert.equal(hiRaceOk, true);
  assert.equal(
    racePlayer.getState().source,
    'source-2:fast-hi',
    'Expected concurrent racer to pick fastest 10ms server at bottom of list over 550ms slow server',
  );
  assert(
    raceElapsedMs < 350,
    `Expected parallel server race to finish well under slow server's 550ms delay (took ${raceElapsedMs}ms)`,
  );
  racePlayer.destroy();
  globalThis.fetch = rawNodeFetch;

  // 10. Verify zero developer/internal UI clutter in built client bundle
  const fs = await import('node:fs');
  const libBundle = fs.readFileSync(new URL('../../dist/lib/elfura.js', import.meta.url), 'utf8');
  for (const forbiddenUiText of ['other stream', 'in stream', 'external dub', ' kbps', 'Searching all sources']) {
    assert(
      !libBundle.includes(forbiddenUiText),
      `Client bundle still contains forbidden technical UI text: "${forbiddenUiText}"`,
    );
  }

  // 11. Verify movie/1218925 (Chainsaw Man - The Movie: Reze Arc):
  //     - Deep liveness prunes master-alive/child-HTML dead streams & 403 mirrors BEFORE player
  //     - VidZee routes via vidsync `/api/core/proxy` instead of dead direct `bigtits.m3u8`
  //     - Source 2 receives TMDB `title`, `year`, `date`, `imdbId` and unlocks all multi-language dubs
  //       (`ja`, `hi`, `en`, `fr`, `ar`, `id` + in-manifest `ko`, `th` discovered from `#EXTM3U`)
  //     - `dash-hls-bridge` preserves outer `Signature`, stamps `LANGUAGE="ja",NAME="Japanese"` on
  //       single-dub `NAME="Audio"`, tags `_h265_` with `CODECS="hvc1..."`, and spawns zero "Original" ghosts
  //     - HEVC-unsupported MSE skips HEVC-only streams and picks H.264 immediately
  const sessRezeRes = await fetch(`${apiBase}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://watch.elfura.example' },
    body: JSON.stringify({ type: 'movie', tmdb: '1218925' }),
  });
  const sessReze = await sessRezeRes.json();
  const pbRezeRes = await fetch(
    `${apiBase}/api/v1/playback?type=movie&tmdb=1218925&nonce=${encodeURIComponent(sessReze.nonce)}`,
    {
      headers: {
        Origin: 'https://watch.elfura.example',
        'X-Playback-Token': sessReze.pltoken,
      },
    },
  );
  assert.equal(pbRezeRes.status, 200);
  const pbReze = await pbRezeRes.json();
  assert.equal(pbReze.ok, true);
  assert.equal(pbReze.media.title, 'Chainsaw Man - The Movie: Reze Arc');

  // Dead Source 1 `MHBD Dead Child` (multi-audio `[hi, en]` whose audio0.m3u8 returned HTML) MUST be pruned!
  const s1Reze = pbReze.sources.filter((s) => s.sourceId === 'source-1');
  assert(
    !s1Reze.some((s) => s.multiAudio),
    'Master-alive / child-HTML dead Source 1 stream must be pruned before entering playback response',
  );
  // Meanwhile Source 3's Hindi stream routed via `/api/core/proxy` MUST be alive!
  const s3Reze = pbReze.sources.filter((s) => s.sourceId === 'source-3');
  assert(
    s3Reze.length > 0,
    'Expected Source 3 proxy-backed stream to survive deep liveness check',
  );

  const jaOpt = { ...pb.primary, id: 'synthetic-ja', audioLang: 'ja', label: 'Source 2 · Japanese', multiAudio: false, availableAudioLangs: [], audioTracks: [] };

  // Verify relay.ts strictly rejects HTML manifest and HTML segment responses with 502 no-store
  const htmlManifestTicket = sealStreamTicket(secret, { u: `${upBase}/dead-child-stream/audio0.m3u8`, k: 'm' });
  const htmlManifestRes = await fetch(`${apiBase}/api/v1/stream?t=${encodeURIComponent(htmlManifestTicket)}`, {
    headers: browserHeaders,
  });
  assert.equal(htmlManifestRes.status, 502, 'Relay must reject HTML masquerading as an HLS manifest with 502');
  assert(
    (htmlManifestRes.headers.get('cache-control') || '').includes('no-store'),
    'Rejected HTML manifest must never be cached at Cloudflare edge',
  );

  const htmlSegTicket = sealStreamTicket(secret, { u: `${upBase}/dead-html-segment.ts`, k: 'a' });
  const htmlSegRes = await fetch(`${apiBase}/api/v1/stream?t=${encodeURIComponent(htmlSegTicket)}`, {
    headers: browserHeaders,
  });
  assert.equal(htmlSegRes.status, 502, 'Relay must reject HTML masquerading as a binary media segment with 502');


  // Verify single-dub native audio inheritance in ElfuraPlayer produces zero ghost "Original" track
  const singleDubPlayer = new ElfuraPlayer({ postMessage: false });
  singleDubPlayer.sources = [jaOpt];
  singleDubPlayer.currentSource = jaOpt;
  singleDubPlayer.mergeNativeAudio([{ id: 0, lang: 'und', label: 'Original', default: true }]);
  assert.deepEqual(
    singleDubPlayer.getAudioTracks().map((t) => ({ lang: t.lang, label: t.label })),
    [{ lang: 'ja', label: 'Japanese' }],
    'Single-dub source must not emit a bogus "Original" audio track alongside "Japanese"',
  );
  singleDubPlayer.destroy();

  // 12. Verify Source 2 cold-cache `success: false` recovery + `/api/scan` warm-up + `atlas` retry
  const { createSource2Adapter } = await import('../../dist/backend/sources/source2.js');
  const coldCalls = [];
  globalThis.fetch = async (input) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.startsWith('https://cold-embed.example')) {
      const cu = new URL(urlStr);
      coldCalls.push(`${cu.pathname}?server=${cu.searchParams.get('server') || ''}`);
      if (cu.pathname === '/api/scan') {
        return new Response(JSON.stringify({ servers: [{ id: 'atlas', available: true, latencyMs: 390 }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (cu.pathname === '/api/extract' && cu.searchParams.get('server') === 'orion') {
        return new Response(
          JSON.stringify({ success: false, sources: [], scanReport: [{ id: 'orion', available: false }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (cu.pathname === '/api/extract' && cu.searchParams.get('server') === 'atlas') {
        return new Response(
          JSON.stringify({
            success: true,
            sources: [
              {
                url: 'https://cold-cdn.example/m/tok_hi?f=.m3u8',
                type: 'hls',
                resolution: 1080,
                resolutions: [1080, 720],
                label: '1080p • Hindi',
                language: 'Hindi',
                audioLanguages: ['Hindi'],
                originServer: 'atlas',
              },
              {
                url: 'https://cold-cdn.example/m/tok_ja?f=.m3u8',
                type: 'hls',
                resolution: 1080,
                resolutions: [1080],
                label: '1080p • Japanese',
                language: 'Japanese',
                audioLanguages: ['Japanese'],
                originServer: 'atlas',
              },
            ],
            scanReport: [{ id: 'atlas', available: true, latencyMs: 390 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }
    return rawNodeFetch(input);
  };

  const coldAdapter = createSource2Adapter({
    enabled: true,
    embedOrigin: 'https://cold-embed.example',
    defaultServer: 'orion',
  });
  const coldResolved = await coldAdapter.resolve({
    type: 'movie',
    tmdbId: '1218925',
    resolveMetaFallback: async () => ({
      title: 'Chainsaw Man - The Movie: Reze Arc',
      rawTitle: 'Chainsaw Man - The Movie: Reze Arc',
      year: '2025',
      releaseDate: '2025-09-19',
      imdbId: 'tt30472557',
    }),
  });
  globalThis.fetch = rawNodeFetch;

  assert(
    coldCalls.some((c) => c.startsWith('/api/scan')),
    'Expected cold Source 2 miss to trigger `/api/scan` warm-up',
  );
  assert(
    coldCalls.includes('/api/extract?server=atlas'),
    'Expected cold Source 2 miss on `orion` to retry fast `atlas` server',
  );
  assert.deepEqual(
    coldResolved.candidates.map((c) => c.audioLang).sort(),
    ['hi', 'ja'],
    'Expected cold-cache retry on `atlas` to recover Hindi & Japanese candidates',
  );

  // 13. Verify OTT Player UI Overhaul + Cinema Paused Screen + Brand Watermark:
  //     - TMDB `media` carries `episodeName`, `tagline`, `rating`, `genres`, and `logo`
  //     - Persistent `TheOGPirateBot` brand badge (100% opacity when started/paused, faded while playing)
  //     - `Back` button only when UI is on (no `Home` button), and `S# · E# — Episode Name` on top for TV
  //     - Title Logo with playful Cartoony Font fallback (`elf-title-cartoon`) when logo is unavailable
  //     - Cinema Paused Screen (`elf-pause-screen`: Title Logo/Cartoon, `PAUSED`, tagline, year + ★ rating, overview)
  //     - Zero center forward/backward 10s skip buttons, animated Play/Pause & 4-corner Fullscreen,
  //       double-tap 10s skip, hold-for-2x, Screen Lock, bottom Episodes/thumbnails,
  //       integrated current-language navigation, branded loading, and terminal unavailable UI
  assert.equal(pb.media.episodeName, 'Welcome to the Playground');
  assert.equal(pb.media.tagline, 'Every legend has a beginning.');
  assert.equal(pb.media.rating, 8.8);
  assert.deepEqual(pb.media.genres, ['Animation', 'Action']);
  assert.equal(pb.media.logo, 'https://image.tmdb.org/t/p/w780/arcaneTitleLogo.png');

  const cssAssetsDir = new URL('../../dist/assets/', import.meta.url);
  const cssFile = fs.readdirSync(cssAssetsDir).find((f) => f.endsWith('.css'));
  assert(cssFile, 'Expected built player CSS asset in dist/assets/');
  const builtCss = fs.readFileSync(new URL(cssFile, cssAssetsDir), 'utf8');

  for (const requiredToken of [
    'TheOGPirateBot',
    'Audio & Subtitles',
    'Screen Locked',
    '2× Speed',
    'PAUSED',
    'elf-og-pill',
    'elf-pill-back',
    'elf-top-episode',
    'elf-pause-screen',
    'elf-title-logo',
    'elf-title-cartoon',
    'elf-audio-quick',
    'elf-audio-current',
    'elf-audio-badge',
    'elf-mi-lang',
    'elf-episodes-btn',
    'elf-epw-thumb',
    'elf-loading-screen',
    'elf-loading-quote',
    'elf-unavailable-screen',
    'retrySources',
    'elf-pp-svg',
    'elf-fs-svg',
    'elf-dtap-left',
    'elf-dtap-right',
    'elf-unlock-pill',
    'elf-timeline-row',
    'elf-skip10-btn',
  ]) {
    assert(libBundle.includes(requiredToken), `Expected PlayerUI bundle to contain "${requiredToken}"`);
  }
  assert(!libBundle.includes('center.append(this.back10'), 'Center container must not include 10s skip buttons');
  assert(!libBundle.includes('elf-hotstar-lang'), 'Floating language pills must stay removed');
  assert(!builtCss.includes('.elf-hotstar-lang'), 'Floating language pill styles must stay removed');
  for (const requiredCss of [
    '.elf-og-pill',
    '.elf-pill-back',
    '.elf-pause-screen',
    '.elf-title-cartoon',
    '.elf-audio-quick',
    '.elf-audio-option',
    '.elf-audio-badge',
    '.elf-episodes-btn',
    '.elf-epw-thumb',
    '.elf-loading-screen',
    '.elf-unavailable-screen',
    '.elf-fs-tl',
    '.elf-pp-pause',
    '.elf-dtap-ripple',
    '.elf-scrub-knob',
  ]) {
    assert(builtCss.includes(requiredCss), `Expected built CSS to include "${requiredCss}"`);
  }

  // 14. Verify Smart Hybrid Segment Offload + Source Anonymity + Anti-Scraper Armour:
  //   (a) Strict source-anonymity filter allows generic HTTPS storage CDNs while blocking every source/bridge leak
  assert.equal(
    isAnonymousSegmentUrl(
      'https://sacdn.hakunaymatata.com/dash/30254/chunk-stream0-00001.m4s?Policy=eyJ123&Signature=abc&Key-Pair-Id=KM1',
      true,
    ),
    true,
  );
  assert.equal(
    isAnonymousSegmentUrl('https://img.hscow.com/hls/a30eaa/720/s_0.jpg?t=1777016941', true),
    true,
  );
  assert.equal(
    isAnonymousSegmentUrl('https://d111111abcdef8.cloudfront.net/media/seg-001.ts', true),
    true,
  );
  for (const leakyUrl of [
    'http://sacdn.hakunaymatata.com/dash/30254/chunk-stream0-00001.m4s', // Mixed-content HTTP blocked in prod!
    'https://tgvidapi.lovable.app/api/kai/abc?s=seg1.ts',
    'https://tgvid-rift-relay.vercel.app/api/relay?u=abc',
    'https://embed.vidrift.in/api/orion/abc/seg0.ts',
    'https://mb.vidrift.net/api/orion/abc/video.mp4',
    'https://vidsync.pro/api/core/proxy?data=123',
    'https://img.rousav.tech/media/84ba/seg0.ts?api_key=secret123',
    'https://proxy.vidbolt.xyz/m/tok123',
    'https://embed.aethoflix.world/api/proxy-segment?url=https%3A%2F%2Fcdn.example.com%2Fa.ts',
    'https://dash-hls-bridge.johndoesdmc.workers.dev/?url=https%3A%2F%2Fsacdn.hakunaymatata.com%2Fa.m4s',
    'https://vidstuck.cc/backend/database/andromeda?url=abc',
  ]) {
    assert.equal(isAnonymousSegmentUrl(leakyUrl, true), false, `Must block leaky/unsafe offload URL: ${leakyUrl}`);
  }

  //   (b) Embed response carries `Referrer-Policy: same-origin` + `<meta name="referrer" content="same-origin">`
  assert.equal(embedRes.headers.get('referrer-policy'), 'same-origin');
  assert(embedHtml.includes('name="referrer" content="same-origin"'));

  //   (c) CLI scrapers / downloaders (`yt-dlp`, `ffmpeg`/`Lavf`, `curl`) are blocked with 403 on `/api/v1/playback` & `/api/v1/stream`
  for (const botUa of ['yt-dlp/2026.10.01', 'Lavf/61.1.100', 'curl/8.7.1']) {
    const botStreamRes = await fetch(`${apiBase}${pb.primary.url}`, {
      headers: { Origin: 'https://watch.elfura.example', 'User-Agent': botUa },
    });
    assert.equal(botStreamRes.status, 403, `Expected 403 for scraper UA "${botUa}" on /api/v1/stream`);
  }

  //   (d) Sealed Playback Envelope (`X-Elfura-Envelope: 1`) returns pure AES-256-GCM ciphertext (zero plaintext leakage)
  const envRes = await fetch(
    `${apiBase}/api/v1/playback?type=tv&tmdb=94605&s=1&e=1&nonce=${encodeURIComponent(boot.nonce)}`,
    {
      headers: {
        ...browserHeaders,
        'X-Playback-Token': boot.pltoken,
        'X-Elfura-Envelope': '1',
      },
    },
  );
  assert.equal(envRes.status, 200);
  const envRawText = await envRes.text();
  assert(!envRawText.includes('Arcane'), 'Sealed envelope must not contain plaintext media title');
  assert(!envRawText.includes('/api/v1/stream'), 'Sealed envelope must not contain plaintext stream URLs');
  const envJson = JSON.parse(envRawText);
  assert.equal(envJson.ok, true);
  assert.equal(envJson.s, 1);
  assert(typeof envJson.p === 'string' && envJson.p.length > 60);
  const openedEnv = openPlaybackEnvelope(envJson, boot.pltoken, boot.nonce);
  assert.equal(openedEnv.media.title, 'Arcane · S1E1 — Welcome to the Playground');
  assert.equal(openedEnv.sources.length, pb.sources.length);

  // Verify real ElfuraPlayer sends `X-Elfura-Envelope: 1` and decrypts via WebCrypto `crypto.subtle`
  globalThis.window.location = {
    pathname: '/embed/tv/94605/1/1',
    search: '',
    href: `${apiBase}/embed/tv/94605/1/1`,
  };
  let sawEnvelopeHeader = false;
  const origFetchForEnv = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const hdrs = { ...browserHeaders, ...(init.headers || {}) };
    if (hdrs['X-Elfura-Envelope'] === '1') sawEnvelopeHeader = true;
    const urlStr = typeof input === 'string' && input.startsWith('/') ? `${apiBase}${input}` : input;
    return origFetchForEnv(urlStr, { ...init, headers: hdrs });
  };
  try {
    const envPlayer = new ElfuraPlayer({
      postMessage: false,
      apiBase,
      tmdb: '94605',
      mediaType: 'tv',
      season: 1,
      episode: 1,
      pltoken: boot.pltoken,
      nonce: boot.nonce,
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for ElfuraPlayer sealed envelope boot')), 4000);
      envPlayer.bus.on('sources', (srcs) => {
        clearTimeout(t);
        resolve(srcs);
      });
    });
    assert.equal(sawEnvelopeHeader, true, 'ElfuraPlayer must send X-Elfura-Envelope: 1 on /api/v1/playback');
    assert.equal(envPlayer.getMediaInfo()?.episodeName, 'Welcome to the Playground');
    assert.equal(envPlayer.getSources().length, pb.sources.length, 'ElfuraPlayer must decrypt every source from the sealed playback envelope');
    envPlayer.destroy();

    // A player embedded on a different origin with an absolute `api` endpoint must send the
    // returned root-relative media tickets to that API origin, not to the embed host.
    globalThis.window.location = {
      pathname: '/embed/tv/94605/1/1',
      search: '',
      href: 'https://watch.elfura.example/embed/tv/94605/1/1',
    };
    const crossOriginPlayer = new ElfuraPlayer({
      postMessage: false,
      api: `${apiBase}/api/v1/playback`,
      tmdb: '94605',
      mediaType: 'tv',
      season: 1,
      episode: 1,
      pltoken: boot.pltoken,
      nonce: boot.nonce,
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for cross-origin backend sources')), 4000);
      crossOriginPlayer.bus.on('sources', () => {
        clearTimeout(t);
        resolve();
      });
    });
    const crossSources = crossOriginPlayer.getSources();
    assert.equal(crossSources.length, pb.sources.length);
    for (const source of crossSources) {
      assert(
        source.url.startsWith(`${apiBase}/api/v1/stream?t=`),
        `Cross-origin backend ticket was resolved against the wrong origin: ${source.url}`,
      );
      for (const track of [...(source.audioTracks ?? []), ...(source.subtitles ?? [])]) {
        assert(
          track.url.startsWith(`${apiBase}/api/v1/stream?t=`),
          `Cross-origin track ticket was resolved against the wrong origin: ${track.url}`,
        );
      }
    }
    crossOriginPlayer.destroy();
  } finally {
    globalThis.fetch = origFetchForEnv;
  }

  //   (e) Live Hybrid Relay verification:
  //       - CORS + Referer-free anonymous bucket offloads media segments (`#EXT-X-MAP` + `.m4s`) directly
  //         while keeping master manifest AND `#EXT-X-KEY` encrypted behind `/api/v1/stream?t=...`!
  //       - Non-CORS bucket and Referer-locked bucket stay 100% relayed behind `/api/v1/stream?t=...`!
  //       - Forced proxy fallback (`&p=1`) tunnels all child manifests & segments 100% through `/api/v1/stream?t=...`!
  process.env.ELFURA_ALLOW_HTTP_OFFLOAD_TEST = '1';
  try {
    const corsMasterTicket = sealStreamTicket(secret, { u: `${upBase}/edge-cors/master.m3u8`, k: 'm' });
    const corsMasterRes = await fetch(`${apiBase}/api/v1/stream?t=${encodeURIComponent(corsMasterTicket)}`, {
      headers: browserHeaders,
    });
    assert.equal(corsMasterRes.status, 200);
    const corsMasterText = await corsMasterRes.text();
    const corsVariantRel = corsMasterText.split('\n').find((l) => l.startsWith('/api/v1/stream?t='));
    assert(corsVariantRel, 'Master playlist must always keep child variant playlists relayed via /api/v1/stream');

    const corsVariantRes = await fetch(`${apiBase}${corsVariantRel}`, { headers: browserHeaders });
    assert.equal(corsVariantRes.status, 200);
    const corsVariantText = await corsVariantRes.text();
    assert(
      corsVariantText.includes(`#EXT-X-KEY:METHOD=AES-128,URI="/api/v1/stream?t=`),
      'AES-128 #EXT-X-KEY URI must stay encrypted behind /api/v1/stream even when segments offload',
    );
    assert(
      corsVariantText.includes(`#EXT-X-MAP:URI="${upBase}/edge-cors/init.m4s"`),
      'Verified CORS-safe anonymous fMP4 init segment must offload directly',
    );
    assert(
      corsVariantText.includes(`${upBase}/edge-cors/chunk-0001.m4s?Policy=abc&Signature=sig1&Key-Pair-Id=K1`),
      'Verified CORS-safe anonymous media segment must offload directly',
    );

    // Forced proxy fallback (`&p=1` when viewer ISP blocks direct CDN) tunnels everything via `/api/v1/stream?t=`
    const forcedMasterRes = await fetch(`${apiBase}/api/v1/stream?t=${encodeURIComponent(corsMasterTicket)}&p=1`, {
      headers: browserHeaders,
    });
    const forcedMasterText = await forcedMasterRes.text();
    const forcedVariantRel = forcedMasterText.split('\n').find((l) => l.startsWith('/api/v1/stream?t='));
    const forcedVariantRes = await fetch(`${apiBase}${forcedVariantRel}`, { headers: browserHeaders });
    const forcedVariantText = await forcedVariantRes.text();
    assert(
      !forcedVariantText.includes(`${upBase}/edge-cors/chunk-0001.m4s`),
      'Forced proxy (&p=1) must propagate fp=1 to child manifests and tunnel all segments via /api/v1/stream',
    );
    assert(
      forcedVariantText.split('\n').some((l) => l.startsWith('/api/v1/stream?t=')),
      'Forced proxy (&p=1) variant playlist must emit /api/v1/stream?t= segment tickets',
    );

    // Non-CORS CDN (`/edge-nocors/*`) must NEVER offload (would fail browser CORS!)
    const noCorsTicket = sealStreamTicket(secret, { u: `${upBase}/edge-nocors/variant.m3u8`, k: 'm' });
    const noCorsRes = await fetch(`${apiBase}/api/v1/stream?t=${encodeURIComponent(noCorsTicket)}`, {
      headers: browserHeaders,
    });
    const noCorsText = await noCorsRes.text();
    assert(
      !noCorsText.includes('/edge-nocors/chunk-0001.m4s'),
      'Segments lacking Access-Control-Allow-Origin must stay relayed through /api/v1/stream',
    );

    // Origin-reflecting CDN authorized only our fake probe origin. It must stay relayed because
    // a viewer's real Origin would receive a different ACAO value and fail browser CORS.
    const echoCorsTicket = sealStreamTicket(secret, { u: `${upBase}/edge-echo-cors/variant.m3u8`, k: 'm' });
    const echoCorsRes = await fetch(`${apiBase}/api/v1/stream?t=${encodeURIComponent(echoCorsTicket)}`, {
      headers: browserHeaders,
    });
    const echoCorsText = await echoCorsRes.text();
    assert(
      !echoCorsText.includes(`${upBase}/edge-echo-cors/chunk-0001.m4s`),
      'Origin-reflecting CDN segments must stay relayed instead of failing the viewer real Origin',
    );
    assert(
      echoCorsText.split('\n').some((l) => l.startsWith('/api/v1/stream?t=')),
      'Origin-reflecting CDN segments must be rewritten to backend stream tickets',
    );

    // Referer-locked CDN (`/edge-reflock/*`) must NEVER offload (would 403 in browser!)
    const refLockTicket = sealStreamTicket(secret, {
      u: `${upBase}/edge-reflock/variant.m3u8`,
      h: { Referer: 'https://vidbolt.xyz/' },
      k: 'm',
    });
    const refLockRes = await fetch(`${apiBase}/api/v1/stream?t=${encodeURIComponent(noCorsTicket ? refLockTicket : '')}`, {
      headers: browserHeaders,
    });
    const refLockText = await refLockRes.text();
    assert(
      !refLockText.includes('/edge-reflock/chunk-0001.m4s'),
      'Referer-locked segments must stay relayed through /api/v1/stream',
    );
  } finally {
    delete process.env.ELFURA_ALLOW_HTTP_OFFLOAD_TEST;
  }

  // 15. Verify Dynamic Language-Aware Server Hierarchy & Multi-Audio Hindi Speed Priority:
  //   (a) Backend `/api/v1/playback?...&lang=hi` ranks fast Multi-Audio Hindi at #1 (`primary`) ahead of slow direct Hindi dubs
  const pbHiRes = await fetch(
    `${apiBase}/api/v1/playback?type=tv&tmdb=94605&s=1&e=1&lang=hi&nonce=${encodeURIComponent(boot.nonce)}`,
    {
      headers: {
        ...browserHeaders,
        'X-Playback-Token': boot.pltoken,
      },
    },
  );
  assert.equal(pbHiRes.status, 200);
  const pbHi = await pbHiRes.json();
  assert.equal(pbHi.ok, true);
  assert.equal(
    pbHi.primary.multiAudio,
    true,
    'Fast Multi-Audio Hindi server must rank #1 (`primary`) ahead of slower direct Hindi dubs when lang=hi',
  );
  assert(pbHi.primary.availableAudioLangs?.includes('hi'));

  //   (b) ElfuraPlayer races Multi-Audio Hindi head-to-head against direct Hindi in Wave 1 (even if untagged
  //       or given a higher initial latencyHintMs!) AND dynamically re-orders `getSources()` so the fastest
  //       Hindi server (Multi-Audio Hindi!) moves to #1 on top of the server hierarchy!
  globalThis.window.location = {
    pathname: '/player-test',
    search: '',
    href: `${apiBase}/player-test`,
  };
  const origFetchForMultiRace = globalThis.fetch;
  globalThis.fetch = (input, init = {}) =>
    origFetchForMultiRace(input, {
      ...init,
      headers: {
        Referer: globalThis.window.location.href,
        ...(init.headers || {}),
      },
    });
  try {
    const multiRacePlayer = new ElfuraPlayer({ postMessage: false });
    multiRacePlayer.sources = [
      {
        id: 'en-fast',
        sourceId: 'source-1',
        label: 'Source 1 · English',
        type: 'mp4',
        url: fastTicket,
        fingerprint: 'fp_m_en_01',
        latencyHintMs: 25,
        quality: '1080p',
        audioLang: 'en',
        audioTracks: [],
        subtitles: [],
      },
      {
        id: 'hi-direct-slow-1',
        sourceId: 'source-2',
        label: 'Source 2 · Hindi',
        type: 'mp4',
        url: slowTicket,
        fingerprint: 'fp_m_hi_slow1',
        latencyHintMs: 180,
        quality: '1080p',
        audioLang: 'hi',
        audioTracks: [],
        subtitles: [],
      },
      {
        id: 'hi-direct-slow-2',
        sourceId: 'source-1',
        label: 'Source 1 · Hindi',
        type: 'mp4',
        url: slowTicket,
        fingerprint: 'fp_m_hi_slow2',
        latencyHintMs: 210,
        quality: '1080p',
        audioLang: 'hi',
        audioTracks: [],
        subtitles: [],
      },
      {
        id: 'multi-hi-fast',
        sourceId: 'source-2',
        label: 'Source 2 · Multi-Audio',
        type: 'mp4',
        url: fastTicket,
        fingerprint: 'fp_m_multi_fast',
        latencyHintMs: 360,
        quality: '1080p',
        multiAudio: true,
        audioTracks: [],
        subtitles: [],
      },
    ];
    await multiRacePlayer.setSource('en-fast');
    await new Promise((r) => setTimeout(r, 15));

    const tStartHi = Date.now();
    const okHi = await multiRacePlayer.setAudio('hi');
    const elapsedHi = Date.now() - tStartHi;

    assert.equal(okHi, true);
    assert.equal(
      multiRacePlayer.getState().source,
      'multi-hi-fast',
      'Fast Multi-Audio Hindi server must beat slow direct Hindi servers in Wave 1',
    );
    assert(
      elapsedHi < 280,
      `Multi-Audio Hindi switch must not wait on 550ms slow direct Hindi servers (took ${elapsedHi}ms)`,
    );
    const rankedIds = multiRacePlayer.getSources().map((s) => s.id);
    assert.equal(
      rankedIds[0],
      'multi-hi-fast',
      `Dynamic hierarchy must place fastest Hindi server (Multi-Audio) at #1 on top (got ${rankedIds.join(', ')})`,
    );
    assert.equal(
      rankedIds[rankedIds.length - 1],
      'en-fast',
      'Non-Hindi servers must move below Hindi-capable servers when Hindi is selected',
    );
    multiRacePlayer.destroy();
  } finally {
    globalThis.fetch = origFetchForMultiRace;
  }

  // 16. Verify QoL Batch 3:
  //     (a) Automatic OpenSubtitles Fallback (zero-disk RAM cache, .sub filtering, legacy tag canonicalization,
  //         sealed `/api/v1/stream?t=...` tickets with zero external domain leak, and SRT spam-cue sanitization)
  const arcaneSubLangs = pb.primary.subtitles.map((s) => s.lang);
  assert.deepEqual(
    [...arcaneSubLangs].sort(),
    ['en', 'es-419', 'hi', 'pt-br'],
    'OpenSubtitles must replace—not mix with—the native subtitle catalogue',
  );
  assert.equal(new Set(arcaneSubLangs).size, arcaneSubLangs.length, 'No duplicate subtitle languages');
  for (const option of pb.sources) {
    assert.deepEqual(
      option.subtitles.map((s) => s.lang).sort(),
      [...arcaneSubLangs].sort(),
      'Every stream option must expose the same unambiguous OpenSubtitles choices',
    );
    assert(
      option.subtitles.every((s) => !['1. English [CC]', 'Native English'].includes(s.label)),
      'Native/provider labels must not leak into the OpenSubtitles-only catalogue',
    );
  }
  assert(arcaneSubLangs.includes('en'), 'Expected OpenSubtitles English fallback track');
  assert(arcaneSubLangs.includes('hi'), 'Expected OpenSubtitles Hindi fallback track');
  assert(arcaneSubLangs.includes('pt-br'), 'Expected OpenSubtitles `pob` to canonicalize to `pt-br`');
  assert(arcaneSubLangs.includes('es-419'), 'Expected OpenSubtitles `spl` to canonicalize to `es-419`');
  for (const sub of pb.primary.subtitles) {
    assert(
      sub.url.startsWith('/api/v1/stream?t=') && !sub.url.includes('opensubs'),
      `Subtitle URL must be sealed inside /api/v1/stream?t=...: ${sub.url}`,
    );
  }
  const hiSubOpt = pb.primary.subtitles.find((s) => s.lang === 'hi');
  const hiSubRes = await fetch(`${apiBase}${hiSubOpt.url}`, { headers: browserHeaders });
  assert.equal(hiSubRes.status, 200);
  assert(
    (hiSubRes.headers.get('content-type') || '').includes('text/plain; charset=utf-8'),
    'Extensionless/SRT OpenSubtitles track must relay with text/plain; charset=utf-8',
  );
  const hiSubBody = await hiSubRes.text();
  assert(!hiSubBody.includes('OpenSubtitles.org'), 'Relay must strip OpenSubtitles VIP spam cues from SRT');
  assert(hiSubBody.includes('Welcome to Piltover.'), 'Relay must preserve real dialogue cues in SRT');

  //     (b) `GET /api/v1/episodes` TV Season & Episode Catalog (plain & AES-256-GCM Sealed Envelope)
  const unauthEpRes = await fetch(`${apiBase}/api/v1/episodes?tmdb=94605&s=1`, {
    headers: { Origin: 'https://watch.elfura.example' },
  });
  assert.equal(unauthEpRes.status, 401, '/api/v1/episodes must enforce X-Playback-Token when requireToken=true');

  const sessEpRes = await fetch(`${apiBase}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://watch.elfura.example' },
    body: JSON.stringify({ type: 'tv', tmdb: '94605' }),
  });
  const sessEp = await sessEpRes.json();

  const epPlainRes = await fetch(
    `${apiBase}/api/v1/episodes?tmdb=94605&s=1&nonce=${encodeURIComponent(sessEp.nonce)}`,
    {
      headers: {
        Origin: 'https://watch.elfura.example',
        'X-Playback-Token': sessEp.pltoken,
      },
    },
  );
  assert.equal(epPlainRes.status, 200);
  const epPlain = await epPlainRes.json();
  assert.equal(epPlain.ok, true);
  assert.deepEqual(
    epPlain.seasons.map((s) => s.seasonNumber),
    [1, 2],
    'Season 0 specials must be excluded while real seasons [1, 2] are preserved',
  );
  assert.equal(epPlain.episodes.length, 3);
  assert.equal(epPlain.episodes[1].name, 'Some Mysteries Are Better Left Unsolved');

  const epSealedRes = await fetch(
    `${apiBase}/api/v1/episodes?tmdb=94605&s=1&nonce=${encodeURIComponent(sessEp.nonce)}`,
    {
      headers: {
        Origin: 'https://watch.elfura.example',
        'X-Playback-Token': sessEp.pltoken,
        'X-Elfura-Envelope': '1',
      },
    },
  );
  const epSealedRaw = await epSealedRes.json();
  assert.equal(epSealedRaw.s, 1, 'Expected sealed envelope when X-Elfura-Envelope: 1 is passed to /api/v1/episodes');
  const epOpened = openPlaybackEnvelope(epSealedRaw, sessEp.pltoken, sessEp.nonce);
  assert.equal(epOpened.episodes.length, 3);

  //     (c) Part 1 Player Core & UI QoL Batch 3 checks (Zoom, Audio Boost 200%, Subtitle Sync,
  //         TV Next-Episode target, Right-Hand Episode Wheel, Remaining Time, "Will End at xx:xx" 24h/12h)
  const qolPlayer = new ElfuraPlayer({
    postMessage: false,
    mediaType: 'tv',
    tmdb: '94605',
    season: 1,
    episode: 1,
    pltoken: sessEp.pltoken,
    nonce: sessEp.nonce,
    api: `${apiBase}/api/v1/playback`,
  });

  // Pinch-to-Zoom state API
  assert.equal(qolPlayer.getZoomMode(), 'fit');
  qolPlayer.setZoomMode('cover');
  assert.equal(qolPlayer.getZoomMode(), 'cover');
  assert.equal(qolPlayer.shell.dataset.zoom, 'cover');
  qolPlayer.setZoomMode('fit');
  assert.equal(qolPlayer.getZoomMode(), 'fit');

  // Phone Speaker Audio Boost (clamped 100%..200%)
  assert.equal(qolPlayer.getAudioBoost(), 100);
  qolPlayer.setAudioBoost(185);
  assert.equal(qolPlayer.getAudioBoost(), 185);
  qolPlayer.setAudioBoost(300);
  assert.equal(qolPlayer.getAudioBoost(), 200);
  qolPlayer.setAudioBoost(50);
  assert.equal(qolPlayer.getAudioBoost(), 100);

  // Subtitle Sync Fixer (-0.5s / +0.5s / Reset)
  assert.equal(qolPlayer.getSubtitleOffset(), 0);
  assert.equal(qolPlayer.nudgeSubtitleOffset(0.5), 0.5);
  assert.equal(qolPlayer.nudgeSubtitleOffset(-1.5), -1);
  qolPlayer.setSubtitleOffset(0);
  assert.equal(qolPlayer.getSubtitleOffset(), 0);

  // TV Season/Episode catalog + Next Episode target
  globalThis.window.location = {
    pathname: '/embed/tv/94605/1/1',
    search: '',
    href: `${apiBase}/embed/tv/94605/1/1`,
  };
  const origFetchForQol = globalThis.fetch;
  globalThis.fetch = (input, init = {}) =>
    origFetchForQol(input, {
      ...init,
      headers: {
        Origin: 'https://watch.elfura.example',
        Referer: globalThis.window.location.href,
        ...(init.headers || {}),
      },
    });
  try {
    const cat = await qolPlayer.fetchSeasonEpisodes(1);
    assert.equal(cat.episodes.length, 3);
    assert.deepEqual(qolPlayer.getNextEpisodeTarget(), {
      season: 1,
      episode: 2,
      name: 'Some Mysteries Are Better Left Unsolved',
    });
  } finally {
    globalThis.fetch = origFetchForQol;
  }
  qolPlayer.destroy();

  // Verify built CSS & JS include all requested QoL UI tokens and ZERO excluded features
  for (const requiredToken of [
    'Speaker Boost',
    'Subtitle Sync',
    'Will End at ',
    'Zoomed to fill',
    'Original fit',
    'elf-ep-wheel-overlay',
    'elf-ep-wheel-item',
    'elf-skip-prog',
  ]) {
    assert(
      libBundle.includes(requiredToken) || builtCss.includes(requiredToken),
      `Expected QoL Batch 3 token "${requiredToken}" in built client bundle/CSS`,
    );
  }
  // Ensure excluded features (Smart Auto-Resume localStorage / Vertical Edge Brightness Swipe) were NOT added
  for (const excludedToken of ['Continue Watching', 'elfura:resume', 'Brightness']) {
    assert(
      !libBundle.includes(excludedToken),
      `Excluded feature token "${excludedToken}" must NOT be present in client bundle`,
    );
  }

  // 17. Verify Production Recovery Multi-Cluster Adapters (VidSync Proxy Fix + VidRock GCM +
  //     VidLink + NXStream 30-Server Salted__ AES-CBC + VidStuck Raider + Anonymity + Safe Config):
  {
    const { createSource1Adapter } = await import('../../dist/backend/sources/source1.js');
    const {
      createSource2Adapter: createS2Recovery,
      openSslEncryptBase64Url,
      openSslDecrypt,
    } = await import('../../dist/backend/sources/source2.js');
    const { createSource3Adapter } = await import('../../dist/backend/sources/source3.js');
    const { loadBackendConfig } = await import('../../dist/backend/config.js');
    const { rewriteHlsManifest } = await import('../../dist/backend/relay.js');

    // (a) Placeholder ELFURA_SECRET must never derive a deterministic static key
    const pCfgA = loadBackendConfig({
      NODE_ENV: 'production',
      ELFURA_SECRET: 'replace-with-a-64-char-random-hex-secret',
    });
    const pCfgB = loadBackendConfig({
      NODE_ENV: 'production',
      ELFURA_SECRET: 'replace-with-a-64-char-random-hex-secret',
    });
    assert.notEqual(
      pCfgA.secret.toString('hex'),
      pCfgB.secret.toString('hex'),
      'Placeholder ELFURA_SECRET must generate fresh ephemeral secrets instead of hashing static text',
    );
    assert(!('apiOrigin' in pCfgA.source1), 'removed TG configuration must not be registered');
    assert.equal(pCfgA.source2.embedOrigin, '', 'Dead aethoflix default must be cleared when unset');
    assert.equal(pCfgA.source2.enabled, false);
    assert.equal(pCfgA.source2.nxshaOrigin, '');
    assert.equal(pCfgA.source2.vidstuckOrigin, '');
    const legacyCfg = loadBackendConfig({ SOURCE2_ENABLED: '1', SOURCE2_NXSHA_ORIGIN: 'https://legacy.invalid', SOURCE2_VIDSTUCK_ORIGIN: 'https://legacy.invalid' });
    assert.equal(legacyCfg.source2.enabled, false);
    assert.equal(legacyCfg.source2.nxshaOrigin, '');

    // (b) Anonymity guard blocks every newly added upstream/worker domain from direct segment offload
    for (const newLeakyUrl of [
      'https://nxsha.space/api/sources?q=abc',
      'https://wts.itsnitrox.tech/pitro/seg0.ts',
      'https://vercetti.org/movie/abc/seg0.ts',
      'https://vidrock.net/api/movie/533535',
      'https://vidlink.pro/api/b/movie/abc',
      'https://enc-dec.app/api/enc-vidlink?text=533535',
      'https://autumn-art-7466.nxstreamhub.workers.dev/?url=https%3A%2F%2Fsbcdnw.hakunaymatata.com%2Fa.m4s',
    ]) {
      assert.equal(
        isAnonymousSegmentUrl(newLeakyUrl, true),
        false,
        `Must deny direct offload for upstream-identifying URL: ${newLeakyUrl}`,
      );
    }

    // Verify client bundles contain zero mentions of any upstream domain or codename
    for (const forbidden of [
      'nxsha',
      'itsnitrox',
      'vidrock',
      'vidlink',
      'vidstuck',
      'vercetti',
      'enc-dec',
      'nxstreamhub',
      'vidsync',
    ]) {
      assert(
        !libBundle.toLowerCase().includes(forbidden) && !embedHtml.toLowerCase().includes(forbidden),
        `Client bundle must never mention upstream identifier "${forbidden}"`,
      );
    }

    // Verify `#EXT-X-MEDIA` release-group watermarks (`hguider`, `SPLY`) are stripped to clean language labels
    const rewrittenNitroManifest = rewriteHlsManifest(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="hguider",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="hin",URI="a_hi.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="SPLY",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="tam",URI="a_ta.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,AUDIO="audio"',
        'v1080.m3u8',
      ].join('\n'),
      'https://wts.itsnitrox.tech/pitro/master.m3u8',
      { Referer: 'https://nxsha.space/' },
      pCfgA.secret,
    );
    // Opaque encrypted ticket bytes can coincidentally spell a watermark;
    // inspect only manifest labels, not random URI token contents.
    const nitroLabelsOnly = rewrittenNitroManifest.replace(/URI="[^"]*"/g, 'URI="[ticket]"');
    assert(
      !nitroLabelsOnly.toLowerCase().includes('hguider') &&
        !nitroLabelsOnly.toLowerCase().includes('sply'),
      'Expected hguider/SPLY release watermarks to be stripped from #EXT-X-MEDIA',
    );
    assert(
      rewrittenNitroManifest.includes('LANGUAGE="hi"') && rewrittenNitroManifest.includes('NAME="Hindi"'),
      'Expected hin -> hi Hindi normalization on rewritten nitro manifest',
    );

    // (c) End-to-end mock cluster test for VidSync Castle Proxy and VidRock GCM
    //     and Source 2 (NXStream Salted__ AES-256-CBC + VidStuck Raider Salted__ AES-256-CBC)
    const NX_PASS = 'f4488ab4da401203d23baa129fc546153898162524635d6776826d0c867ccaa3';
    const VS_PASS = '7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c';
    const VROCK_KEY = Buffer.from(
      '7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f',
      'hex',
    );
    const encryptVidRock = (plain) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', VROCK_KEY, iv);
      const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, ct, tag]).toString('base64url');
    };

    let vidapiReceivedReferer = '';
    const requestedNxProviders = [];
    const clusterMock = http.createServer(async (req, res) => {
      const cu = new URL(req.url, `http://${req.headers.host}`);
      const cOrigin = `http://${req.headers.host}`;

      // VidSync: single-language Castle row with IP-signed directUrl (403) + working `/api/core/proxy`
      if (cu.pathname === '/api/stream' || cu.pathname === '/api/core/streams') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            sources:
              cu.pathname === '/api/stream'
                ? [
                    {
                      provider: { id: 'castle', name: 'Castle' },
                      url: '/api/core/proxy?data=castle_en_1080&quality=1080p',
                      directUrl: `${cOrigin}/ip-locked/index_287.m3u8?Expires=1793807012&KeyName=Signature&Signature=abc`,
                      type: 'hls',
                      quality: '1080p',
                      audioLanguage: 'en',
                      audioTracks: [{ language: 'English' }, { language: 'Hindi' }],
                      availableQualities: ['1080p', '720p', '480p'],
                      headers: { Referer: 'https://api.hlowb.com/' },
                      subtitles: [
                        { url: `${cOrigin}/vlink/en.srt`, language: 'English' },
                        { url: `${cOrigin}/vlink/hi.srt`, language: 'Hindi' },
                      ],
                    },
                    {
                      provider: { id: 'direct-test', name: 'Direct' },
                      url: `${cOrigin}/direct/master.m3u8`,
                      type: 'hls',
                      quality: '720p',
                      availableQualities: ['1080p', '720p'],
                      audioLanguage: 'hi',
                      headers: { Referer: 'https://media.example/' },
                    },
                    {
                      provider: { id: 'castle', name: 'Castle' },
                      url: '/api/core/proxy?data=castle_en_720&quality=720p',
                      directUrl: `${cOrigin}/ip-locked/index_287.m3u8?Expires=1793807012&KeyName=Signature&Signature=abc`,
                      type: 'hls',
                      quality: '720p',
                      audioLanguage: 'en',
                      headers: { Referer: 'https://api.hlowb.com/' },
                    },
                  ]
                : [],
          }),
        );
        return;
      }
      if (cu.pathname === '/ip-locked/index_287.m3u8') {
        res.writeHead(403);
        res.end('Forbidden IP mismatch');
        return;
      }
      if (cu.pathname === '/api/core/proxy') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
        return;
      }

      // VidRock AES-256-GCM
      if (cu.pathname === '/api/movie/533535') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            Nova: encryptVidRock(`${cOrigin}/vrock/nova.m3u8`),
            Hindi: encryptVidRock(`${cOrigin}/vrock/hindi.m3u8`),
            Luna: encryptVidRock('https://belfast.armadilloscp.workers.dev/browser-gated'),
          }),
        );
        return;
      }

      // NXStream (`/api/servers` + `/api/sources`)
      if (cu.pathname === '/api/servers') {
        const dec = JSON.parse(openSslDecrypt(cu.searchParams.get('q') || '', NX_PASS));
        assert.equal(dec.tmdbId, '533535');
        assert.equal(dec.ex_lang, true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            _hash: openSslEncryptBase64Url(
              JSON.stringify({
                servers: [
                  { id: 'nitro', status: 'online', types: ['web'] },
                  { id: 'vidapi', status: 'online' },
                  { id: 'mhbox', status: 'online' },
                  { id: 'awsind', status: 'online', web_support: true, isDisable: false },
                  { id: 'watchout', status: 'online' },
                  { id: 'bdxs', status: 'online' },
                  { id: 'showbox-online', status: 'online' },
                  { id: 'stvv', status: 'online' },
                  { id: 'rive-citadel', status: 'online', isDisable: true },
                  { id: 'castle', status: 'online', web_support: false },
                  { id: 'streamflix', status: 'online', types: ['app'] },
                ],
              }),
              NX_PASS,
            ),
          }),
        );
        return;
      }
      if (cu.pathname === '/api/subtitles') {
        const dec = JSON.parse(openSslDecrypt(cu.searchParams.get('q') || '', NX_PASS));
        assert.equal(dec.tmdbId, '533535');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            _hash: openSslEncryptBase64Url(
              JSON.stringify({
                subtitles: [
                  { uri: `${cOrigin}/nx/sub_hi.vtt`, language: 'hi', display: 'Hindi' },
                ],
              }),
              NX_PASS,
            ),
          }),
        );
        return;
      }
      if (cu.pathname === '/api/sources') {
        const dec = JSON.parse(openSslDecrypt(cu.searchParams.get('q') || '', NX_PASS));
        requestedNxProviders.push(dec.provider);
        const byProv = {
          awsind: [
            {
              provider: 'awsind',
              url: `${cOrigin}/awsind/multi.m3u8`,
              label: 'AwsPly',
              quality: '1080p',
              type: 'hls',
              lang: 'en',
              langName: 'English',
              multiLangs: ['en', 'hi', 'ta'],
            },
            {
              provider: 'awsind',
              url: `${cOrigin}/awsind/expired.m3u8?Expires=100`,
              label: 'Hindi',
              type: 'hls',
            },
            {
              provider: 'awsind',
              url: 'https://i-arch-400.husvu445bey.com/stream2/dead.m3u8',
              label: 'Hindi',
              type: 'hls',
            },
          ],
          watchout: [
            {
              provider: 'watchout',
              url: `${cOrigin}/watchout/hindi.m3u8`,
              label: 'watchout',
              quality: '720p',
              type: 'm3u8',
              lang: 'hi',
              langName: 'Hindi',
            },
          ],
          nitro: [
            {
              provider: 'nitro',
              url: `${cOrigin}/nitro/master.m3u8`,
              label: 'hguider | 1080P | Hindi | Tamil | Telugu',
              quality: '1080P',
              type: 'm3u8',
            },
          ],
          vidapi: [
            {
              provider: 'vidapi',
              url: `${cOrigin}/Ygu4uHrIF/pl/H4sIAAAAAAAA/master.m3u8`,
              label: 'SPLY-1',
              quality: 'Auto',
              type: 'm3u8',
            },
          ],
          mhbox: [
            {
              provider: 'mhbox',
              url: `${cOrigin}/mhbox/esla.mpd`,
              label: 'esla dub : 1080,720,480',
              quality: '1080',
              type: 'mpd',
            },
            {
              provider: 'mhbox',
              url: `${cOrigin}/mhbox/orig.mpd`,
              label: 'Original Audio dub : 1080,720,480',
              quality: '1080',
              type: 'mpd',
            },
          ],
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            _hash: openSslEncryptBase64Url(
              JSON.stringify({ sources: byProv[dec.provider] || [] }),
              NX_PASS,
            ),
          }),
        );
        return;
      }
      if (cu.pathname.includes('/pl/H4sI')) {
        vidapiReceivedReferer = String(req.headers.referer || '');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\nseg0.ts\n#EXT-X-ENDLIST\n');
        return;
      }

      // VidStuck (`/backend/raider`, `/backend/servers/*`, `/backend/subtitle`)
      if (cu.pathname === '/backend/raider' && req.method === 'POST') {
        let rawBody = '';
        for await (const chunk of req) rawBody += chunk;
        const body = JSON.parse(rawBody || '{}');
        assert.equal(body.a7f39c821d604e5b91e57b, 533535, 'VidStuck raider requires numeric TMDB id');
        assert.equal(body.c81306d28147a35632e816b, 'movie');
        assert(body['6b491e258392e7561a9384c'], 'VidStuck raider requires target server id');
        assert.equal(req.headers['content-type'], 'application/json');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: `vs_tok_${body['6b491e258392e7561a9384c']}`, ts: 1793800000 }));
        return;
      }
      if (cu.pathname === '/backend/servers/orion') {
        const isHiDub = cu.searchParams.get('dubCode') === 'hi';
        assert.equal(cu.searchParams.get('6b491e258392e7561a9384c'), 'orion');
        assert.equal(cu.searchParams.get('c492f7a183d01e36c538a716d'), 'vs_tok_orion');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            links: [
              {
                link: openSslEncryptBase64Url(
                  `/vs/${isHiDub ? 'orion_hi.mpd' : 'orion_en.mpd'}`,
                  VS_PASS,
                ),
                type: 'dash',
                resolution: 1080,
              },
              {
                link: openSslEncryptBase64Url('/vs/orion_hevc.mpd', VS_PASS),
                type: 'dash',
                resolution: 1080,
                onlyHevc: true,
              },
            ],
            dubs: isHiDub ? [] : [{ lang: 'hi', name: 'Hindi', type: 0 }],
          }),
        );
        return;
      }
      if (cu.pathname.startsWith('/backend/servers/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, links: [] }));
        return;
      }
      if (cu.pathname === '/backend/subtitle') {
        assert.equal(cu.searchParams.get('6b491e258392e7561a9384c'), 'subtitle');
        assert.equal(cu.searchParams.get('c492f7a183d01e36c538a716d'), 'vs_tok_subtitle');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ captions: [{ file: `${cOrigin}/vs/sub_en.vtt`, language: 'en', display: 'English' }] }),
        );
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise((r) => clusterMock.listen(0, '127.0.0.1', r));
    const cmPort = clusterMock.address().port;
    const cmOrigin = `http://127.0.0.1:${cmPort}`;

    try {
      const s1Rec = createSource1Adapter({
        enabled: true,
        appOrigin: '',
        apiOrigin: '',
        riftOrigin: '',
        riftRelay: '',
        syncOrigin: cmOrigin,
        vidrockOrigin: cmOrigin,
        vidboltOrigin: cmOrigin,
      }, 2);
      const laneDiag = [];
      const s1Out = await s1Rec.resolve({ type: 'movie', tmdbId: '533535', preferredLang: 'hi', diag: laneDiag });
      assert(s1Out.candidates.every(c => c.diagnosticLane === 'E'), 'diagnostics must attribute VidRock candidates to lane E');
      const s3Rec = createSource3Adapter({ enabled: true, origin: cmOrigin });
      const s3Out = await s3Rec.resolve({ type: 'movie', tmdbId: '533535', preferredLang: 'hi', diag: [] });
      assert(s3Out.candidates.every(c => c.diagnosticLane === 'stream'));

      // Source 3 must prefer `/api/core/proxy`, collapse quality clones, and retain the direct
      // signed CDN lane as a secondary candidate for registry-level liveness filtering.
      const directCand = s3Out.candidates.find((c) => c.url.includes('/direct/master.m3u8'));
      assert.equal(directCand?.headers?.Referer, 'https://media.example/', 'direct CDN must retain provider media headers');
      assert.equal(directCand?.quality, '720p', 'do not use catalogue quality as selected-stream quality');
      const castleCands = s3Out.candidates.filter((c) => c.url.includes('/api/core/proxy'));
      assert.equal(castleCands.length, 1, 'Expected Castle 1080p/720p clones to collapse to 1 proxy candidate');
      assert.equal(castleCands[0].multiAudio, false, 'catalogue language labels are not switchable manifest tracks');
      assert.equal(castleCands[0].audioLang, 'en', 'unambiguous single-track language is retained as a hint');
      assert.equal(directCand.audioLang, 'hi');
      assert.equal(directCand.subtitles, undefined, 'provider subtitles must be ignored');
      const checkedCastle = await verifyAndFilterCandidates([castleCands[0]]);
      assert.equal(checkedCastle[0].qualityOptions, 1, 'a leaf playlist must override a claimed quality ladder');
      assert.equal(checkedCastle[0].qualityLadder, undefined);
      assert(
        castleCands[0].standbyUrl?.includes('/ip-locked/index_287.m3u8'),
        'Direct signed CDN URL must remain available as a verified failover',
      );
      const deadDirectProbe = await fetch(castleCands[0].standbyUrl);
      assert.equal(deadDirectProbe.status, 403, 'Fixture must prove dead direct lanes are prunable by liveness');

      // VidRock Hindi must be decrypted and prioritized first for `preferredLang: 'hi'`
      assert(
        s1Out.candidates[0].url === `${cmOrigin}/vrock/hindi.m3u8` && s1Out.candidates[0].audioLang === 'hi',
        'Expected VidRock AES-256-GCM Hindi candidate to be decrypted & ranked #1 for preferredLang=hi',
      );
      assert.equal(s1Out.candidates[0].headers['User-Agent'], ' ', 'VidRock media requires single-space UA');
      assert.equal(s1Out.candidates[0].headers.Referer, undefined, 'VidRock media must omit Referer');
      assert.equal(s1Out.candidates[0].headers.Origin, undefined, 'VidRock media must omit Origin');
      assert(
        !s1Out.candidates.some((c) => c.url.includes('workers.dev')),
        'Browser/TLS-gated VidRock Workers lanes must not be advertised as playable',
      );

      const s2Rec = createS2Recovery({
        enabled: true,
        embedOrigin: '',
        defaultServer: 'orion',
        nxshaOrigin: cmOrigin,
        vidstuckOrigin: cmOrigin,
      });
      const s2Out = await s2Rec.resolve({
        type: 'movie',
        tmdbId: '533535',
        title: 'Deadpool & Wolverine',
        year: '2024',
        imdbId: 'tt6263850',
        preferredLang: 'hi',
      });

      assert.deepEqual(
        [...requestedNxProviders].sort(),
        ['awsind', 'bdxs', 'mhbox', 'nitro', 'showbox-online', 'streamflix', 'vidapi', 'watchout'].sort(),
        'Measured multi-language providers must fit the bounded probe set; disabled/app-only servers must be skipped',
      );
      const awsCand = s2Out.candidates.find((c) => c.url.includes('/awsind/multi.m3u8'));
      assert(awsCand, 'Expected current AwsPly provider candidate');
      assert.equal(awsCand.multiAudio, true);
      assert.deepEqual(awsCand.availableAudioLangs, ['en', 'hi', 'ta']);
      assert(
        awsCand.subtitles.some((s) => s.url === `${cmOrigin}/nx/sub_hi.vtt` && s.lang === 'hi'),
        'Current Nxsha language + uri subtitles must be normalized and pooled',
      );
      const watchoutCand = s2Out.candidates.find((c) => c.url.includes('/watchout/hindi.m3u8'));
      assert(watchoutCand && watchoutCand.audioLang === 'hi', 'Explicit Nxsha lang/langName must survive parsing');
      assert(
        !s2Out.candidates.some((c) => /expired\.m3u8|husvu445bey|orion_hevc/.test(c.url)),
        'Expired, known-dead and HEVC-only lanes must never be advertised',
      );

      const nitroCand = s2Out.candidates.find((c) => c.url.includes('/nitro/master.m3u8'));
      assert(nitroCand, 'Expected NXStream nitro candidate');
      assert.equal(nitroCand.multiAudio, true);
      assert.deepEqual(nitroCand.availableAudioLangs, ['hi', 'ta', 'te']);
      assert.equal(nitroCand.quality, '1080p');
      assert(nitroCand.subtitles.length >= 1, 'Expected VidStuck subtitles to pool onto NXStream candidates');

      const vidapiCand = s2Out.candidates.find((c) => c.url.includes('/pl/H4sI'));
      assert(vidapiCand, 'Expected NXStream vidapi candidate');
      assert.equal(vidapiCand.headers.Referer, undefined, 'vidapi /pl/H4sI must omit upstream Referer');
      const vidapiProbe = await fetch(vidapiCand.url, { headers: vidapiCand.headers });
      assert.equal(vidapiProbe.status, 200);
      assert.equal(vidapiReceivedReferer, '');

      const eslaCand = s2Out.candidates.find((c) => c.url.includes('/mhbox/esla.mpd'));
      assert(eslaCand && eslaCand.audioLang === 'es-419', 'Expected esla dub to canonicalize to es-419');

      const origMpdCand = s2Out.candidates.find((c) => c.url.includes('/mhbox/orig.mpd'));
      assert(origMpdCand && origMpdCand.audioLang === undefined, 'Original Audio dub must not invent a bogus language code');

      const vsHindiCand = s2Out.candidates.find((c) => c.url === `${cmOrigin}/vs/orion_hi.mpd`);
      assert(vsHindiCand && vsHindiCand.audioLang === 'hi', 'Expected VidStuck Orion Hindi dub to decrypt cleanly');
    } finally {
      clusterMock.close();
    }
  }

  console.log('✓ All Elfura Part 1/Part 2 boundary, security, Hybrid Relay offload, Sealed Envelope, dynamic Multi-Audio Hindi speed hierarchy, OpenSubtitles fallback, Episode Wheel, QoL Batch 3, Production Recovery Multi-Cluster & OTT Player UI tests passed.');
} finally {
  elfuraServer.close();
  mockUpstream.close();
}
