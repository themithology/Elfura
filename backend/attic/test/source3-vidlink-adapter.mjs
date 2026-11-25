/**
 * VidLink (source-3): the token is the whole source.
 *
 * `/api/b` does not take a TMDB id — it takes a secretbox token minted with a
 * key that ships in vidlink's own public web player. If the mint is wrong,
 * everything downstream is a 400 and the lane looks dead. So the mint is tested
 * by opening it again, and the payload reader is tested against both shapes the
 * API has been observed to send.
 *
 * What this file CANNOT prove: that the API still accepts the token. That needs
 * egress, so it runs on a runner (scripts/research/independence.mjs).
 */
import assert from 'node:assert/strict';
import {
  localToken,
  openToken,
  payloadCandidates,
  vidlinkUrl,
} from '../sources/source3-vidlink.ts';

const NOW = 1_700_000_000_000;

console.log('— the token round-trips');
{
  const token = localToken('550', NOW);
  assert.ok(token, 'a numeric TMDB id must mint a token');
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'the token is base64url, nothing else');

  const opened = openToken(token);
  assert.ok(opened, 'the token must open with the same key');
  assert.equal(opened.tmdbId, '550', 'the id survives the round trip');
  assert.equal(
    opened.expiresAt,
    Math.floor(NOW / 1000) + 480,
    'the token expires eight minutes after it was minted, in seconds',
  );

  // Fresh tokens differ because the nonce is random, and both must open.
  const other = localToken('550', NOW);
  assert.notEqual(token, other, 'a reused nonce would make the same id+second mint identically');
  assert.equal(openToken(other)?.tmdbId, '550');
  assert.notEqual(
    Buffer.from(token, 'base64url').subarray(0, 24).toString('hex'),
    '00'.repeat(24),
    'the nonce must not be zeros',
  );

  // A token cannot be edited into another id.
  const forged = Buffer.from(token, 'base64url');
  forged[forged.length - 1] ^= 0xff;
  assert.equal(openToken(forged.toString('base64url')), null, 'a tampered token must not open');
}

console.log('— ids that must not mint');
{
  assert.equal(localToken(''), null);
  assert.equal(localToken('abc'), null);
  assert.equal(localToken('-1'), null);
  assert.equal(localToken('1234567890123'), null, 'thirteen digits is not a TMDB id');
  assert.equal(localToken('5.5'), null);
}

console.log('— urls');
{
  const movie = vidlinkUrl({ type: 'movie', tmdbId: '550' }, 'https://vidlink.pro/api/b', NOW);
  assert.match(movie, /^https:\/\/vidlink\.pro\/api\/b\/movie\/[A-Za-z0-9_-]+$/);

  const tv = vidlinkUrl({ type: 'tv', tmdbId: '1399', season: 2, episode: 7 }, 'https://vidlink.pro/api/b', NOW);
  assert.match(tv, /^https:\/\/vidlink\.pro\/api\/b\/tv\/[A-Za-z0-9_-]+\/2\/7$/);

  assert.equal(vidlinkUrl({ type: 'movie', tmdbId: 'nope' }), null);
}

console.log('— payload shapes');
{
  const headers = { 'User-Agent': 'x', Referer: 'https://vidlink.pro/', Origin: 'https://vidlink.pro' };

  // The documented shape.
  const full = payloadCandidates(
    {
      stream: {
        playlist: 'https://cdn.example/master.m3u8',
        qualities: {
          '1080p': { url: 'https://cdn.example/1080.m3u8' },
          '720p': { url: 'https://cdn.example/720.m3u8' },
        },
      },
    },
    headers,
  );
  assert.equal(full.length, 3, 'playlist plus both qualities');
  assert.equal(full[0].quality, '1080p', 'the highest quality comes first');
  assert.equal(full[2].quality, 'auto', 'the master playlist is the fallback');
  assert.ok(full.every((c) => c.type === 'hls'));
  assert.equal(full[0].headers.Referer, 'https://vidlink.pro/', 'the CDN needs the site referer');

  // The shape that used to be dropped silently: a bare string instead of {url}.
  const bare = payloadCandidates(
    { stream: { qualities: { '480p': 'https://cdn.example/480.m3u8' } } },
    headers,
  );
  assert.equal(bare.length, 1, 'a bare-string quality entry is a stream, not nothing');

  // Alternate shape.
  const alt = payloadCandidates(
    { streams: [{ url: 'https://cdn.example/a.m3u8', quality: '1080p' }, { url: 'https://cdn.example/b.mp4', quality: '720p' }] },
    headers,
  );
  assert.equal(alt.length, 2);
  assert.equal(alt[1].type, 'mp4', 'a .mp4 is not called HLS');

  // Refusals.
  const bad = payloadCandidates(
    {
      stream: {
        playlist: 'http://insecure.example/x.m3u8',
        qualities: {
          bad1: { url: 'https://user:pass@cdn.example/x.m3u8' },
          bad2: { url: 42 },
          bad3: {},
        },
      },
      streams: [null, { url: 'nonsense' }],
    },
    headers,
  );
  assert.equal(bad.length, 0, 'plain http, credentials and junk are all refused');

  // Duplicates collapse.
  const dupes = payloadCandidates(
    {
      stream: {
        playlist: 'https://cdn.example/same.m3u8',
        qualities: { '1080p': { url: 'https://cdn.example/same.m3u8' } },
      },
    },
    headers,
  );
  assert.equal(dupes.length, 1, 'the same URL is listed once');

  assert.equal(payloadCandidates({}, headers).length, 0);
  assert.equal(payloadCandidates({ stream: {} }, headers).length, 0);
}

console.log('— the adapter refuses to reach for a third party');
{
  // A refused token must produce no candidates and no call to any token service.
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('bad token', { status: 400 });
  };
  const { createVidlinkAdapter } = await import('../sources/source3-vidlink.ts');
  const adapter = createVidlinkAdapter();
  const quiet = console.warn;
  console.warn = () => {};
  const result = await adapter.resolve({ type: 'movie', tmdbId: '550' });
  console.warn = quiet;

  assert.equal(result.candidates.length, 0, 'a refused token is not a stream');
  assert.equal(calls.length, 1, 'exactly one request: the API, and nothing else');
  assert.ok(
    calls.every((url) => url.startsWith('https://vidlink.pro/')),
    `a refused token must not fall back to a third-party token service (saw ${calls.join(', ')})`,
  );
  assert.equal(adapter.id, 'source-3');
}

console.log('\n✓ vidlink: local token round-trips, payload shapes read, no third party in the path');
