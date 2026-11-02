import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { isSafeUpstreamUrl, sealStreamTicket, openStreamTicket } from '../../dist/backend/security.js';
import {
  normalizeLang,
  unscramblePayload,
  serializeSerovalEnvelope,
  deserializeSerovalNode,
} from '../../dist/backend/sources/source1.js';
import { rewriteHlsManifest, sanitizeWebVtt } from '../../dist/backend/relay.js';
import { createBackendServer, matchEmbedPath } from '../../dist/backend/index.js';
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

// 2. Embed route matcher
assert.deepEqual(matchEmbedPath('/embed/movie/278'), { mediaType: 'movie', tmdbId: '278' });
assert.deepEqual(matchEmbedPath('/embed/tv/94605/1/3'), {
  mediaType: 'tv',
  tmdbId: '94605',
  season: 1,
  episode: 3,
});

// 3. XOR scramble/unscramble cipher
function scrambleForTest(plain) {
  const key = 'tGfL1x#9vQ';
  const raw = Buffer.from(plain, 'utf8');
  const xored = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < raw.length; i++) {
    xored[i] = raw[i] ^ key.charCodeAt(i % 10) ^ (i & 0xff);
  }
  return xored.toString('base64').split('').reverse().join('');
}
const sampleJson = JSON.stringify({ ok: true, title: 'Arcane', links: [{ url: 'https://cdn.example/master.m3u8' }] });
assert.equal(unscramblePayload(scrambleForTest(sampleJson)), sampleJson);

// 4. Seroval AST codec
const ser = serializeSerovalEnvelope({ data: { path: '/api/tv/94605/1/1', n: 42, ok: true } });
assert.deepEqual(deserializeSerovalNode(JSON.parse(ser)), {
  data: { path: '/api/tv/94605/1/1', n: 42, ok: true },
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
assert(rewrittenDune.includes('NAME="English #2"'));
assert(rewrittenDune.includes('NAME="English #3"'));

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
assert(rewrittenRousav.includes('NAME="English (SDH)"'));
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

const SEGMENT_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

const mockUpstream = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const origin = `http://${req.headers.host}`;

  if (u.pathname === '/tmdb/tv/94605') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 94605,
        name: 'Arcane',
        first_air_date: '2021-11-06',
        overview: 'Amid the stark discord of twin cities Piltover and Zaun...',
        poster_path: '/fqldf2t8ztc9aiwn3k6mlX3tvRT.jpg',
        backdrop_path: '/rkB4LyZHo1NHXFEDHl9vSD9r1lI.jpg',
        external_ids: { imdb_id: 'tt11126994' },
      }),
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
  if (u.pathname === '/api/m/533535') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, links: [] }));
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

  if (req.method === 'POST' && u.pathname.startsWith('/_serverFn/ff183e')) {
    assert.equal(req.headers['x-tsr-serverfn'], 'true');
    const inner = JSON.stringify({
      ok: true,
      imdb_id: 'tt11126994',
      title: 'Arcane',
      links: [
        {
          server: 'TG HUB v2',
          label: 'TG HUB v2 · Multi-Audio [HIN + ENG]',
          quality: '1080p',
          type: 'hls',
          multi_audio: true,
          audios: ['hin', 'eng'],
          url: `${origin}/cdn/hub/master.m3u8`,
        },
      ],
    });
    const serResp = Buffer.from(serializeSerovalEnvelope({ p: scrambleForTest(inner) }), 'utf8');
    const frameHeader = Buffer.alloc(9);
    frameHeader[0] = 0;
    frameHeader.writeUInt32BE(0, 1);
    frameHeader.writeUInt32BE(serResp.length, 5);
    res.writeHead(200, {
      'Content-Type': 'application/x-tss-framed',
      'X-Tss-Serialized': 'true',
    });
    res.end(Buffer.concat([frameHeader, serResp]));
    return;
  }

  if (req.method === 'GET' && u.pathname.startsWith('/_serverFn/6b4f5d')) {
    const serResp = serializeSerovalEnvelope({
      intro: { start: 52, end: 94 },
      outro: { start: 2310, end: 2420 },
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Tss-Serialized': 'true' });
    res.end(serResp);
    return;
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

  // Source 2 unified /api/extract mock (models 30-server byServer + proxy-m3u8 + rousav + worker dubs)
  if (u.pathname === '/api/extract') {
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
  if (u.pathname === '/media/rousav94605/video_720p.m3u8') {
    if (req.headers.referer !== 'https://vidbolt.xyz/') {
      res.writeHead(404);
      res.end('404 Not Found (nginx)');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5.0,\n/cdn/hub/seg0.m4s\n#EXT-X-ENDLIST\n');
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
    riftRelay: upBase,
    syncOrigin: upBase,
  },
  source2: {
    enabled: true,
    embedOrigin: upBase,
    defaultServer: 'orion',
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
  ]);

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
  assert.equal(pb.media.title, 'Arcane · S1E1 — Welcome to the Playground');
  assert.deepEqual(pb.segments.intro, [52, 94]);
  assert.deepEqual(pb.primary.availableAudioLangs, ['hi', 'en']);

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

  // Verify Source 2 candidates are present, deduplicated, and canonicalized cleanly
  const s2Options = pb.sources.filter((s) => s.sourceId === 'source-2');
  assert(s2Options.length >= 4, 'Expected Source 2 candidates in uniform playback response');
  // French 720p was aliased across orion & valstrax with two vidbolt tokens -> must deduplicate to 1!
  const s2French = s2Options.filter((s) => s.audioLang === 'fr');
  assert.equal(s2French.length, 1, 'Expected per-server vidbolt French clones to deduplicate to 1');
  assert(s2Options.some((s) => s.audioLang === 'es-419' && s.label.includes('Latin American Spanish')));
  assert(s2Options.some((s) => s.audioLang === 'bn' && s.label.includes('Bangla')));
  // "Kurdish sub" hardsub stream must NOT masquerade as Kurdish audio ('ku')!
  assert(!s2Options.some((s) => s.audioLang === 'ku'), 'Hardsub stream must not be tagged as Kurdish audio');

  // Verify Source 2 rousav multi-audio master + child playlist Referer injection + VTT spam cue filter
  const s2Multi = s2Options.find((s) => s.multiAudio);
  assert(s2Multi, 'Expected Source 2 multi-audio master stream');
  const s2MasterRes = await fetch(`${apiBase}${s2Multi.url}`, { headers: browserHeaders });
  assert.equal(s2MasterRes.status, 200);
  const s2MasterText = await s2MasterRes.text();
  assert(s2MasterText.includes('NAME="English"'));
  assert(s2MasterText.includes('NAME="Hindi"'));
  const s2ChildLine = s2MasterText.split('\n').find((l) => l.startsWith('/api/v1/stream?t='));
  const s2ChildRes = await fetch(`${apiBase}${s2ChildLine}`, { headers: browserHeaders });
  assert.equal(s2ChildRes.status, 200, 'Expected rousav child playlist to succeed with server-side Referer');

  const s2SubRes = await fetch(`${apiBase}${s2Multi.subtitles[0].url}`, { headers: browserHeaders });
  assert.equal(s2SubRes.status, 200);
  const s2SubText = await s2SubRes.text();
  assert(!s2SubText.includes('aethoflix'), 'Expected WebVTT spam cue to be stripped');
  assert(s2SubText.includes('Real subtitle line from Source 2.'));

  // Requesting preferred lang=fr promotes Source 2 French directly to `primary`!
  const pbFrRes = await fetch(
    `${apiBase}/api/v1/playback?type=tv&tmdb=94605&s=1&e=1&lang=fr&nonce=${boot.nonce}`,
    { headers: { ...browserHeaders, 'X-Playback-Token': boot.pltoken } },
  );
  assert.equal(pbFrRes.status, 200);
  const pbFr = await pbFrRes.json();
  assert.equal(pbFr.primary.sourceId, 'source-2');
  assert.equal(pbFr.primary.audioLang, 'fr');

  const protectedOpt = pb.sources.find((s) => s.label.includes('English'));
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
  assert((await subRes.text()).includes('Welcome to Piltover!'));

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

  // 8. Verify full 30-server Source 2 harvesting + latency ordering + Ukr->uk canonicalization on movie/533535
  const sess533535Res = await fetch(`${apiBase}/api/v1/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://watch.elfura.example' },
    body: JSON.stringify({ type: 'movie', tmdb: '533535' }),
  });
  const sess533535 = await sess533535Res.json();
  const pb533535Res = await fetch(
    `${apiBase}/api/v1/playback?type=movie&tmdb=533535&nonce=${encodeURIComponent(sess533535.nonce)}`,
    {
      headers: {
        Origin: 'https://watch.elfura.example',
        'X-Playback-Token': sess533535.pltoken,
      },
    },
  );
  assert.equal(pb533535Res.status, 200);
  const pb533535Raw = await pb533535Res.text();
  for (const leaked of ['rousav', 'quantum', 'valstrax', 'zxc_orion', 'vidbolt', 'aethoflix']) {
    assert(!pb533535Raw.toLowerCase().includes(leaked), `Playback payload leaked "${leaked}"`);
  }
  const pb533535 = JSON.parse(pb533535Raw);
  const s2Movie = pb533535.sources.filter((s) => s.sourceId === 'source-2');
  assert(
    s2Movie.length >= 33,
    `Expected all 30 Source 2 servers + distinct dubs (got ${s2Movie.length})`,
  );
  assert.equal(s2Movie[0].latencyHintMs, 365, 'Fastest 365ms server must be ranked first');
  assert.equal(s2Movie[1].latencyHintMs, 370, 'Second fastest 370ms server must be ranked second');
  assert(/^[0-9a-f]{12}$/.test(s2Movie[0].fingerprint), 'Expected 12-hex opaque fingerprint');
  assert(s2Movie.some((s) => s.audioLang === 'hi'), 'Expected Hindi dub in movie/533535');
  assert(s2Movie.some((s) => s.audioLang === 'te'), 'Expected Telugu dub in movie/533535');
  assert(s2Movie.some((s) => s.audioLang === 'uk'), 'Expected "Ukr" normalized to ISO "uk"');

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

  console.log('✓ All Elfura Part 1/Part 2 boundary, security, TMDB, 30-server Source 2, fastest-server racer & clean UI tests passed.');
} finally {
  elfuraServer.close();
  mockUpstream.close();
}
