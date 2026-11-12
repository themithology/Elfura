import assert from 'node:assert/strict';
import { diagnoseCandidatePlayback } from '../../dist/backend/sources/liveness.js';

const originalFetch = globalThis.fetch;
const calls = [];
const media = Buffer.from([0x47, 0x40, 0x00, 0x10, 0x00, 0x01, 0x02, 0x03]);

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const headers = new Headers(init.headers);
  calls.push({ path: url.pathname, range: headers.get('range'), origin: headers.get('origin') });
  if (url.pathname === '/media/master.m3u8') {
    return new Response([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Hindi",LANGUAGE="hi",DEFAULT=YES,URI="audio-hi.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="audio-en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"',
      'video.m3u8',
      '',
    ].join('\n'), { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  }
  if (url.pathname === '/media/video.m3u8' || url.pathname === '/media/audio-hi.m3u8' || url.pathname === '/media/audio-en.m3u8') {
    const seg = url.pathname.includes('video') ? 'video-001.ts' : `${url.pathname.includes('hi') ? 'audio-hi' : 'audio-en'}-001.ts`;
    return new Response(`#EXTM3U\n#EXTINF:4,\n${seg}\n#EXT-X-ENDLIST\n`, {
      status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    });
  }
  if (url.pathname.endsWith('.ts')) {
    return new Response(media, {
      status: headers.has('range') ? 206 : 200,
      headers: {
        'Content-Type': 'video/mp2t',
        'Content-Range': `bytes 0-${media.length - 1}/${media.length}`,
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  throw new Error(`Unexpected diagnostic request ${url.pathname}`);
};

try {
  const result = await diagnoseCandidatePlayback({
    key: 'fixture',
    url: 'https://cdn.example.com/media/master.m3u8',
    type: 'hls',
    quality: '720p',
    multiAudio: true,
    availableAudioLangs: ['hi', 'en'],
    rank: 0,
  }, 'hybrid');

  assert.deepEqual(result.manifestLanguages, ['hi', 'en']);
  assert.deepEqual(result.manifest, { status: 'ok', kind: 'hls-master' });
  assert.equal(result.media.status, 'ok');
  assert.equal(result.media.checks, 3, 'diagnostics probes video and both listed audio segment samples');
  assert.equal(result.browserPlaybackChecked, false);
  assert.equal(result.delivery.route, 'browser-cdn-offload');
  assert.equal(result.delivery.corsOffloadPreflight, 'passed');
  assert(calls.some(call => call.path.endsWith('.ts') && call.range === 'bytes=0-1023'));
  assert(calls.some(call => call.path.endsWith('.ts') && call.origin === 'https://player.elfura.invalid'));
  assert(!JSON.stringify(result).includes('cdn.example.com'));

  let redirectCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    redirectCalls++;
    assert.equal(new Headers(init.headers).get('authorization'), 'secret-fixture');
    return new Response(null, { status: 302, headers: { Location: 'https://other.example/media.m3u8' } });
  };
  const redirected = await diagnoseCandidatePlayback({
    key: 'auth-redirect-fixture', url: 'https://cdn.example.com/private/master.m3u8', type: 'hls', quality: 'auto',
    headers: { Authorization: 'secret-fixture' }, rank: 0,
  }, 'hybrid');
  assert.equal(redirectCalls, 1, 'credential-bearing headers must never be sent to a redirected origin');
  assert(redirected.checks.some(step => step.status === 'blocked-auth-redirect'));
  assert(!JSON.stringify(redirected).includes('secret-fixture'));

  const mp4Calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    mp4Calls.push({ path: url.pathname, range: headers.get('range') });
    return new Response(media, { status: 206, headers: { 'Content-Type': 'video/mp4' } });
  };
  const mp4 = await diagnoseCandidatePlayback({
    key: 'mp4-fixture', url: 'https://cdn.example.com/movie.mp4', type: 'mp4', quality: 'auto', rank: 0,
  }, 'full');
  assert.equal(mp4.media.status, 'ok');
  assert.equal(mp4.delivery.route, 'backend-relay');
  assert(mp4Calls.some(call => call.range === 'bytes=0-1023'));

  globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    return new Response(media, { status: headers.has('range') ? 206 : 200, headers: {
      'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*',
    } });
  };
  const imageResponse = await diagnoseCandidatePlayback({
    key: 'image-fixture', url: 'https://cdn.example.com/not-a-stream.mp4', type: 'mp4', quality: 'auto', rank: 0,
  }, 'hybrid');
  assert.equal(imageResponse.media.status, 'unexpected-content-type');
  assert.equal(imageResponse.delivery.route, 'backend-relay', 'image responses must not be accepted for browser offload');
  assert(imageResponse.checks.some(step => step.status === 'unexpected-content-type' && step.contentType === 'image/jpeg'));

  console.log('✓ Playback diagnostics test actual manifests, child playlists, media byte-ranges, relay policy, and rejects image payloads');
} finally {
  globalThis.fetch = originalFetch;
}
