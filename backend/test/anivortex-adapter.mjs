import assert from 'node:assert/strict';
import { X509Certificate, createHash, createPrivateKey, generateKeyPairSync, verify } from 'node:crypto';
import {
  anivortexRequest,
  b64UrlNoPad,
  buildSelfSignedCertificate,
  canonicalQuery,
  encodeQueryValue,
  readAnivortexCredentials,
  registerAnivortexInstallation,
} from '../../dist/backend/anivortex-auth.js';
import {
  createSource17Adapter,
  episodeIdsFromWatchPayload,
  pickBestTitle,
  playbackQueryAttempts,
} from '../../dist/backend/sources/source17.js';

const originalFetch = globalThis.fetch;
const requests = [];
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKeyB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

const CREDENTIALS = { installationId: 'inst-fixture-1', keyId: 'key-fixture-1', privateKeyB64 };

/* ------------------------------------------------------------------ */
/* Query canonicalization                                              */
/* ------------------------------------------------------------------ */

assert.equal(encodeQueryValue('a b'), 'a%20b', 'spaces become %20, never +');
assert.equal(encodeQueryValue('a*b'), 'a*b', 'Java URLEncoder leaves * unescaped');
assert.equal(encodeQueryValue("a!b'c(d)e~f"), 'a%21b%27c%28d%29e%7Ef');
assert.equal(encodeQueryValue('x/y?z=1&'), 'x%2Fy%3Fz%3D1%26');
assert.equal(canonicalQuery({ b: '2', a: '1' }), 'a=1&b=2', 'query parameters sort by key');
assert.equal(canonicalQuery({}), '', 'no parameters produce an empty canonical query');

/* ------------------------------------------------------------------ */
/* Signed request headers                                              */
/* ------------------------------------------------------------------ */

const signed = await anivortexRequest(CREDENTIALS, {
  method: 'GET',
  path: '/api/v1/titles/550/playback',
  query: { season: '2', episode: '3' },
  timestamp: 1_760_000_000,
  requestId: 'request-fixture',
}, {
  fetchImpl: async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) });
    return Response.json({ ok: true });
  },
});

assert.equal(signed.status, 200);
assert.equal(
  requests[0].url,
  'https://api.anivortex.in/api/v1/titles/550/playback?episode=3&season=2',
  'signed URLs carry the sorted canonical query',
);
assert.equal(requests[0].headers.get('x-anivortex-installation-id'), CREDENTIALS.installationId);
assert.equal(requests[0].headers.get('x-anivortex-key-id'), CREDENTIALS.keyId);
assert.equal(requests[0].headers.get('x-anivortex-request-id'), 'request-fixture');
assert.equal(requests[0].headers.get('x-anivortex-timestamp'), '1760000000');
assert.equal(requests[0].headers.get('user-agent'), 'Dart/3.10 (dart:io)', 'send the client identity the API expects');

const canonical = [
  'ANIVORTEX-SIGNED-REQUEST-V1',
  CREDENTIALS.installationId,
  CREDENTIALS.keyId,
  '1760000000',
  'request-fixture',
  'GET',
  '/api/v1/titles/550/playback',
  'episode=3&season=2',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
].join('\n');
const signatureB64 = requests[0].headers.get('x-anivortex-signature');
assert.equal(
  verify('sha256', Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(signatureB64, 'base64url')),
  true,
  'signature must cover the exact canonical request string',
);

// Body hashing: a POST body changes the canonical hash.
requests.length = 0;
await anivortexRequest(CREDENTIALS, {
  method: 'POST',
  path: '/api/v1/push/installation',
  body: Buffer.from('{"a":1}'),
  timestamp: 1_760_000_000,
  requestId: 'request-fixture-2',
}, { fetchImpl: async (url, init) => { requests.push({ url: String(url), headers: new Headers(init.headers) }); return Response.json({ ok: true }); } });
const bodySignature = Buffer.from(requests[0].headers.get('x-anivortex-signature'), 'base64url');
const emptyBodySignature = Buffer.from(signatureB64, 'base64url');
assert.notEqual(bodySignature.length, 0);
assert.equal(
  verify('sha256', Buffer.from('{"a":1}', 'utf8'), publicKey, bodySignature),
  false,
  'request signature signs the canonical string, not the raw body',
);
assert.notEqual(bodySignature.toString('hex'), emptyBodySignature.toString('hex'), 'body hash must change the signature');

// Only /api/v1 paths may be requested.
const rejected = await anivortexRequest(CREDENTIALS, { method: 'GET', path: 'https://evil.example/x' }, {
  fetchImpl: async () => { throw new Error('must not fetch'); },
});
assert.equal(rejected.ok, false);

/* ------------------------------------------------------------------ */
/* Self-signed installation certificate                                */
/* ------------------------------------------------------------------ */

const certificateDer = buildSelfSignedCertificate(privateKey, publicKey, Date.UTC(2026, 10, 14));
const certificate = new X509Certificate(certificateDer);
assert.equal(certificate.subject, 'CN=Android Keystore Key');
assert.equal(certificate.issuer, 'CN=Android Keystore Key', 'the certificate is self-signed');
assert.equal(certificate.verify(publicKey), true, 'leaf signature validates with the installation key');
assert.ok(certificate.validFrom && certificate.validTo, 'certificate carries a validity window');

/* ------------------------------------------------------------------ */
/* Registration handshake                                              */
/* ------------------------------------------------------------------ */

const challengeBytes = Buffer.from('fixture-challenge-bytes');
let registeredBody = null;
const registration = await registerAnivortexInstallation({
  keyPair: { privateKey, publicKey },
  fetchImpl: async (url, init) => {
    const href = String(url);
    if (href.endsWith('/api/v1/install/challenge')) {
      assert.equal(JSON.parse(String(init.body)).package_name, 'app.anivortex.mobile');
      assert.equal(new Headers(init.headers).get('user-agent'), 'Dart/3.10 (dart:io)');
      return Response.json({
        challenge_id: 'challenge-fixture',
        challenge: b64UrlNoPad(challengeBytes),
        expires_at: '2026-11-14T00:00:00Z',
        server_time: '2026-11-14T00:00:00Z',
      });
    }
    if (href.endsWith('/api/v1/install/register')) {
      registeredBody = JSON.parse(String(init.body));
      return Response.json({
        installation_id: 'inst-from-server',
        key_id: 'key-from-server',
        registered_at: '2026-11-14T00:00:00Z',
        server_time: '2026-11-14T00:00:00Z',
      });
    }
    throw new Error(`Unexpected registration request: ${href}`);
  },
});

assert.ok(registration, 'registration returns credentials');
assert.equal(registration.credentials.installationId, 'inst-from-server');
assert.equal(registration.credentials.keyId, 'key-from-server');
assert.equal(registeredBody.challenge_id, 'challenge-fixture');
assert.equal(registeredBody.certificate_chain.length, 2, 'the reference client presents the leaf twice');
assert.equal(registeredBody.certificate_chain[0], registeredBody.certificate_chain[1]);

// The proof signature must verify against the presented certificate's own key.
const presented = new X509Certificate(Buffer.from(registeredBody.certificate_chain[0], 'base64'));
const proofCanonical = [
  'ANIVORTEX-INSTALL-REGISTER-V1',
  'challenge-fixture',
  b64UrlNoPad(createHash('sha256').update(challengeBytes).digest()),
].join('\n');
assert.equal(
  verify(
    'sha256',
    Buffer.from(proofCanonical, 'utf8'),
    presented.publicKey,
    Buffer.from(registeredBody.proof_signature, 'base64url'),
  ),
  true,
  'registration proof signature validates against the leaf certificate public key',
);

// Round-trip: the exported PKCS#8 key parses back to the same public key.
const exportedKey = createPrivateKey({ key: Buffer.from(registration.credentials.privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
assert.equal(exportedKey.asymmetricKeyType, 'ec');

/* ------------------------------------------------------------------ */
/* Catalogue matching                                                  */
/* ------------------------------------------------------------------ */

const titles = [
  { id: '1', title: 'Dune: Part Two', originalTitle: '', contentType: 'movie', releaseYear: 2024 },
  { id: '2', title: 'Dune', originalTitle: '', contentType: 'movie', releaseYear: 2021 },
  { id: '3', title: 'Dune: Prophecy', originalTitle: '', contentType: 'series', releaseYear: 2024 },
];
// Upstream list payloads are snake_case, exactly as the live API returns them.
const searchFixture = {
  results: [
    { id: 1, title: 'Dune: Part Two', original_title: 'Dune: Part Two', content_type: 'movie', release_year: 2024 },
    { id: 2, title: 'Dune', original_title: 'Dune', content_type: 'movie', release_year: 2021 },
    { id: 3, title: 'Dune: Prophecy', original_title: 'Dune: Prophecy', content_type: 'series', release_year: 2024 },
  ],
};
assert.equal(pickBestTitle(titles, { type: 'movie', title: 'Dune: Part Two', year: '2024' }).id, '1');
assert.equal(pickBestTitle(titles, { type: 'tv', title: 'Dune: Prophecy', year: '2024' }).id, '3');
assert.equal(pickBestTitle(titles, { type: 'tv', title: 'Dune', year: '2021' }), null, 'a movie never satisfies a TV query');
assert.equal(pickBestTitle([{ id: '9', title: 'Unrelated', originalTitle: '', contentType: 'movie', releaseYear: 2020 }], { type: 'movie', title: 'Dune' }), null);

assert.deepEqual(playbackQueryAttempts({ type: 'movie', tmdbId: '1' }, ['ep-7']), [{}, { episode_id: 'ep-7' }]);
assert.deepEqual(
  playbackQueryAttempts({ type: 'tv', tmdbId: '1', season: 2, episode: 3 }, ['ep-7']),
  [{ episode_id: 'ep-7' }, { season: '2', episode: '3' }],
);
assert.deepEqual(
  episodeIdsFromWatchPayload({ seasons: [{ season_number: 1, episodes: [{ episode_number: 2, id: 42 }, { episode_number: 3, episode_id: 'ep-9' }] }] }, 1, 2),
  ['42'],
  'episode ids are read from the watch payload',
);

/* ------------------------------------------------------------------ */
/* Adapter resolution (mocked, including manifest liveness)            */
/* ------------------------------------------------------------------ */

process.env.ELFURA_ANIVORTEX_INSTALL_ID = CREDENTIALS.installationId;
process.env.ELFURA_ANIVORTEX_KEY_ID = CREDENTIALS.keyId;
process.env.ELFURA_ANIVORTEX_PRIVATE_KEY = privateKeyB64;
assert.ok(readAnivortexCredentials(), 'credentials load from environment variables');

const webMaster =
  '#EXTM3U\n' +
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Hindi",LANGUAGE="hi",DEFAULT=YES,AUTOSELECT=YES,URI="hindi.m3u8"\n' +
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="english.m3u8"\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=1280x720,AUDIO="audio"\nvideo.m3u8\n';

let playbackServers = [
  {
    key: 'server-a',
    name: 'Server A',
    languages: [
      {
        code: 'hi',
        name: 'Hindi',
        playback: { qualities: [
          { quality: '720p', type: 'hls', url: 'https://cdn.example.org/anivortex/master.m3u8' },
          { quality: '720p', type: 'hls', url: 'http://127.0.0.1/private.m3u8' },
        ] },
      },
    ],
    subtitles: [{ code: 'en', name: 'English', url: 'https://cdn.example.org/anivortex/en.vtt' }],
  },
];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const headers = new Headers(init.headers);
  requests.push({ url, method: init.method || 'GET', headers });
  if (url.hostname === 'api.anivortex.in') {
    if (url.pathname === '/api/v1/search') {
      return Response.json(searchFixture);
    }
    if (/^\/api\/v1\/titles\/\d+\/watch$/.test(url.pathname)) {
      return Response.json({ seasons: [{ season_number: 1, episodes: [{ episode_number: 2, id: 'ep-2' }] }] });
    }
    if (/^\/api\/v1\/titles\/\d+\/playback$/.test(url.pathname)) {
      return Response.json({ server: playbackServers[0], server_options: [{ key: 'server-b' }], selected_server_key: 'server-a' });
    }
    throw new Error(`Unexpected AniVortex request: ${url.pathname}`);
  }
  if (url.hostname === 'cdn.example.org') {
    if (url.pathname.endsWith('master.m3u8')) return new Response(webMaster, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    if (url.pathname.endsWith('.m3u8')) return new Response('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n', { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    if (url.pathname.endsWith('.vtt')) return new Response('WEBVTT\n', { status: 200, headers: { 'Content-Type': 'text/vtt' } });
  }
  throw new Error(`Unexpected fetch: ${url.href}`);
};

const adapter = createSource17Adapter(() => true);
const diag = [];
const resolved = await adapter.resolve({ type: 'movie', tmdbId: '693134', title: 'Dune: Part Two', year: '2024', diag });

assert.equal(resolved.candidates.length, 1, 'only the public manifest survives liveness + SSRF checks');
assert.equal(resolved.candidates[0].url, 'https://cdn.example.org/anivortex/master.m3u8');
assert.equal(resolved.candidates[0].type, 'hls');
assert.equal(resolved.candidates[0].audioLabel, 'Hindi (provider label)', 'language names stay provider labels');
assert.equal(resolved.candidates[0].audioLang, undefined, 'labels are never asserted as verified audio');
assert.equal(resolved.candidates[0].diagnosticLane, 'V');
assert.equal(resolved.candidates[0].subtitles.length, 1);
assert.equal(diag.length, 1);
assert.equal(diag[0].adapter, 'source-17');
assert.equal(diag[0].ok, true);
assert.ok(requests.every((request) => new URL(String(request.url)).hostname !== 'api.anivortex.in' || request.headers.get('x-anivortex-signature')), 'every API call is signed');
assert.ok(!JSON.stringify(resolved).includes('inst-fixture-1'), 'installation credentials never leak into results');
assert.ok(requests.some((request) => { const url = new URL(String(request.url)); return url.pathname === '/api/v1/titles/1/playback' && url.searchParams.get('server') === 'server-b'; }), 'announced extra servers are queried');

// TV: episode_id is preferred, then season/episode.
requests.length = 0;
playbackServers = [{ key: 'server-a', name: 'Server A', languages: [{ code: 'hi', name: 'Hindi', playback: { qualities: [{ quality: '720p', type: 'hls', url: 'https://cdn.example.org/anivortex/master.m3u8' }] } }] }];
const tvResolved = await createSource17Adapter(() => true).resolve({ type: 'tv', tmdbId: '1396', title: 'Dune: Prophecy', year: '2024', season: 1, episode: 2 });
assert.equal(tvResolved.candidates.length, 1);
assert.ok(requests.some((request) => new URL(String(request.url)).pathname === '/api/v1/titles/3/watch'), 'TV matches the series entry and resolves its watch payload first');
assert.ok(requests.some((request) => { const url = new URL(String(request.url)); return url.pathname === '/api/v1/titles/3/playback' && url.searchParams.get('episode_id') === 'ep-2'; }));

// Missing credentials: no upstream traffic at all.
delete process.env.ELFURA_ANIVORTEX_INSTALL_ID;
delete process.env.ELFURA_ANIVORTEX_KEY_ID;
delete process.env.ELFURA_ANIVORTEX_PRIVATE_KEY;
assert.equal(readAnivortexCredentials(), null);
requests.length = 0;
const unconfiguredDiag = [];
const unconfigured = await createSource17Adapter(() => true).resolve({ type: 'movie', tmdbId: '693134', title: 'Dune', diag: unconfiguredDiag });
assert.equal(unconfigured.candidates.length, 0);
assert.equal(requests.length, 0, 'no requests without installation credentials');
assert.match(unconfiguredDiag[0].detail, /no installation credentials/);

globalThis.fetch = originalFetch;
console.log('anivortex adapter: ok');
