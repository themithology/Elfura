/**
 * Citadel adapter: the parser, and the ranking rule it exists to serve.
 *
 * The rows below are trimmed copies of real payloads recorded from
 * `scrapper.rivestream.app` on a GitHub runner (research/measurements.json,
 * 2026-11-24). They are fixtures on purpose: the parser must keep rejecting the
 * shapes that used to become dead streams, and a live call cannot run in this
 * sandbox (every provider host answers ECONNRESET here, through plain fetch and
 * through TLS impersonation alike).
 */
import assert from 'node:assert/strict';
import { citadelCandidates, citadelUrl, parseCitadelRow, rowLanguage } from '../../dist/backend/sources/citadel.js';
import { selectPlaybackCandidates } from '../../dist/backend/sources/selection.js';
import { extractDeclaredBitrateBps } from '../../dist/backend/sources/liveness.js';

const now = 1_700_000_000_000;
const expires = Math.floor(now / 1000) + 3600;
const sign = (n) => `${'A'.repeat(60)}${n}`;

const signed = (host, path, n, extra = '') =>
  `https://${host}${path}?Expires=${expires}&KeyName=Signature&Signature=${sign(n)}${extra}`;

/** One row as the API returns it. */
const row = (url, language, quality, over = {}) => ({
  url,
  language,
  quality,
  label: quality,
  format: 'hls',
  isEmbed: false,
  ...over,
});

console.log('— row language');
assert.equal(rowLanguage('Hindi')?.code, 'hi');
assert.equal(rowLanguage('720p | Hindi')?.code, 'hi');
assert.equal(rowLanguage('Multi-Audio'), null, 'multi-audio is not a language');
assert.equal(rowLanguage('English Subtitle'), null, 'subtitles are not audio');
assert.equal(rowLanguage('auto'), null);
assert.equal(rowLanguage('')?.code, undefined);

console.log('— parse: what is accepted');
{
  const good = parseCitadelRow(
    row(signed('img1.hscow.com', '/hls/78164859/720/index_287.m3u8', 1), 'Hindi', '720p'),
    0,
    now,
  );
  assert.ok(good, 'a signed citadel row with a language is a candidate');
  assert.equal(good.candidate.type, 'hls');
  assert.equal(good.candidate.quality, '720p');
  assert.equal(good.candidate.claimedAudioLang, 'hi');
  assert.equal(good.lang, 'hi');
  assert.match(good.candidate.url, /^https:\/\/img1\.hscow\.com\/hls\//, 'the direct /hls/ path is the 720p rendition and must survive');
  assert.equal(good.candidate.headers?.Referer, 'https://www.rivestream.app/');
}

console.log('— parse: what is rejected, and why');
{
  const cases = [
    ['expired signature', row(signed('img1.hscow.com', '/hls/1/720/index_a.m3u8', 2), 'Hindi', '720p'), (u) => u.replace(/Expires=\d+/, `Expires=${Math.floor(now / 1000) - 60}`)],
    ['wrong KeyName', row(signed('img1.hscow.com', '/hls/1/720/index_a.m3u8', 3), 'Hindi', '720p'), (u) => u.replace('KeyName=Signature', 'KeyName=Other')],
    ['short signature', row(signed('img1.hscow.com', '/hls/1/720/index_a.m3u8', 4), 'Hindi', '720p'), (u) => u.replace(/Signature=[A-Za-z0-9=_-]+/, 'Signature=short')],
    ['foreign host', row(signed('cdn.example.com', '/hls/1/720/index_a.m3u8', 5), 'Hindi', '720p')],
    ['wrong path', row(signed('img1.hscow.com', '/live/1/index_a.m3u8', 6), 'Hindi', '720p')],
    ['http not https', row(signed('img1.hscow.com', '/hls/1/720/index_a.m3u8', 7), 'Hindi', '720p'), (u) => u.replace('https://', 'http://')],
    ['embed row', row(signed('img1.hscow.com', '/hls/1/720/index_a.m3u8', 8), 'Hindi', '720p', { isEmbed: true })],
    ['mp4 row', row(signed('img1.hscow.com', '/hls/1/720/index_a.m3u8', 9), 'Hindi', '720p', { format: 'mp4' })],
    ['no language', row(signed('img1.hscow.com', '/hls/1/720/index_a.m3u8', 10), 'auto', '1080p')],
    ['not a url', { ...row('nonsense', 'Hindi', '720p'), url: 'nonsense' }],
  ];
  for (const [name, value, mutate] of cases) {
    const input = mutate ? { ...value, url: mutate(value.url) } : value;
    assert.equal(parseCitadelRow(input, 0, now), null, `must reject: ${name}`);
  }
  assert.equal(parseCitadelRow(null, 0, now), null);
  assert.equal(parseCitadelRow([], 0, now), null);
}

console.log('— payload handling');
{
  const body = {
    success: true,
    data: {
      sources: [
        row(signed('img1.hscow.com', '/hls/78164859/720/index_287.m3u8', 11), 'Hindi', '720p'),
        row(signed('img1.hscow.com', '/hls_mps/78164859/480/index_287.m3u8', 12), 'Hindi', '480p'),
        row(signed('img1.fcxmb.com', '/hls/9b2/1080/index_x.m3u8', 13), 'English', '1080p'),
        row(signed('img1.fcxmb.com', '/hls/9b2/1080/index_x.m3u8', 14), 'Tamil', '1080p'), // conflicting mirror
      ],
    },
  };
  const candidates = citadelCandidates(body, now);
  assert.equal(candidates.length, 2, 'the conflicting mirror is dropped, the two Hindi renditions survive');
  assert.deepEqual(
    candidates.map((c) => c.quality),
    ['720p', '480p'],
    'rank order is preserved',
  );
  assert.equal(citadelCandidates({}, now).length, 0);
  assert.equal(citadelCandidates({ data: { sources: 'nope' } }, now).length, 0);
  assert.equal(citadelCandidates(null, now).length, 0);
}

console.log('— url builder');
{
  assert.match(citadelUrl({ type: 'movie', tmdbId: '550' }), /provider=citadel&id=550$/);
  assert.match(citadelUrl({ type: 'tv', tmdbId: '1399', season: 2, episode: 5 }), /season=2&episode=5$/);
  assert.equal(citadelUrl({ type: 'movie', tmdbId: 'not-a-number' }), null);
}

console.log('— the owner rule: same language → biggest stream wins');
{
  // Two lanes, same language, wildly different size. The bigger one must win.
  const adapter = { id: 'source-1', label: 'Source 1', enabled: () => true };
  const candidate = (url, lang, measuredBytes) => ({
    key: url,
    url,
    type: 'hls',
    quality: 'auto',
    rank: 0,
    claimedAudioLang: lang,
    measuredBytes,
    measuredThisRequest: { alive: true },
  });
  const small = candidate('https://a.example/1.m3u8', 'hi', 900 * 1024 * 1024); // 900 MB
  const big = candidate('https://b.example/2.m3u8', 'hi', 3200 * 1024 * 1024); // 3.2 GB
  const otherLang = candidate('https://c.example/3.m3u8', 'en', 6000 * 1024 * 1024); // 6 GB English

  const ordered = selectPlaybackCandidates(
    [
      { adapter, candidate: small },
      { adapter, candidate: otherLang },
      { adapter, candidate: big },
    ],
    'hi',
  ).map((entry) => entry.candidate.url);

  assert.equal(ordered[0], 'https://b.example/2.m3u8', 'the requested language comes first');
  assert.equal(
    ordered[1],
    'https://a.example/1.m3u8',
    'within the language, the smaller stream ranks after the bigger one',
  );
  assert.equal(
    ordered[2],
    'https://c.example/3.m3u8',
    'a bigger stream in another language does not outrank the requested language',
  );

  // A language-specific pick beats raw size; with no preference, size decides.
  const noPreference = selectPlaybackCandidates([
    { adapter, candidate: small },
    { adapter, candidate: big },
  ]).map((entry) => entry.candidate.url);
  assert.deepEqual(noPreference, ['https://b.example/2.m3u8', 'https://a.example/1.m3u8']);

  // An unmeasured stream never beats a measured one, however fast it claims to be.
  const unmeasured = { ...candidate('https://d.example/4.m3u8', 'hi', undefined), latencyMs: 1 };
  const withUnknown = selectPlaybackCandidates([
    { adapter, candidate: unmeasured },
    { adapter, candidate: small },
  ]).map((entry) => entry.candidate.url);
  assert.equal(withUnknown[0], 'https://a.example/1.m3u8', 'unknown size ranks below a measured one');
}

console.log('— declared bitrate is read, and only used under a real measurement');
{
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080',
    'high.m3u8',
  ].join('\n');
  assert.equal(extractDeclaredBitrateBps(master, false), 5200000, 'the highest declared variant');
  assert.equal(extractDeclaredBitrateBps('<MPD><Representation bandwidth="900000"/></MPD>', true), 900000);
  assert.equal(extractDeclaredBitrateBps('#EXTM3U', false), undefined);
}

console.log('\n✓ citadel adapter: row parsing, rejection rules, and size-first ranking');
