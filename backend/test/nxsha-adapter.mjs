/**
 * nxsha adapter — the rules that decide what this lane may say.
 *
 * No network. The envelope is tested by sealing and opening real payloads, and
 * every refusal is tested by handing the adapter a payload that contains the
 * thing it is supposed to refuse. Those are the assertions that matter: this lane
 * can reach the same catalogue as source-1 and the same relay hosts source-2
 * refuses, and a test that only checked "it returns rows" would pass while doing
 * both.
 */
import assert from 'node:assert/strict';

console.log('— the sealed envelope round-trips, and a wrong key does not open it');
{
  const { seal, open, openAny, PASSES } = await import('../../dist/backend/sources/nxsha.js');
  const payload = { servers: [{ scraper: 'nitro' }, { scraper: 'castle' }] };

  const sealed = seal(payload, PASSES[0]);
  assert.match(sealed, /^[A-Za-z0-9_-]+$/, 'the envelope is base64url and nothing else');
  // seal() stamps _req_ts and _req_salt into the body, the way the site's own
  // client does, so the round trip is compared on the fields that were sent.
  const opened = open(sealed, PASSES[0]);
  assert.deepEqual(opened.servers, payload.servers, 'it opens with the key that sealed it');
  assert.ok(opened._req_ts > 0, 'the request timestamp survives');
  assert.equal(typeof opened._req_salt, 'string', 'so does the request salt');

  // The Salted__ header is the only thing that says this is an OpenSSL envelope.
  assert.equal(Buffer.from(sealed, 'base64url').subarray(0, 8).toString(), 'Salted__');

  assert.throws(() => open(sealed, 'not-the-key'), 'a wrong key must not open it');
  // 'not-a-payload' is valid base64url, so it is refused for being too short
  // rather than for its alphabet. Both refusals exist; assert each on a real case.
  assert.throws(() => open('not-a-payload', PASSES[0]), /too-short/);
  assert.throws(() => open('has spaces and /slashes/', PASSES[0]), /not-base64url/);
  assert.throws(() => open(Buffer.from('too short').toString('base64url'), PASSES[0]), /too-short|bad-magic/);

  // openAny tries the history, which is what keeps a rotation from looking dead.
  const viaHistory = openAny(sealed);
  assert.equal(viaHistory?.payload.servers.length, 2, 'openAny finds the key that works');
  assert.equal(openAny('definitely-not-sealed'), null, 'and returns null when none do');
}

console.log('— RiveStream lanes are excluded by construction, not by comment');
{
  const { ownLanes } = await import('../../dist/backend/sources/nxsha.js');
  // Every family nxsha uses for source-1's catalogue.
  const given = [
    'nitro',
    'rive-citadel',
    'rive-primevids',
    'rive-flowcast',
    'rive-hindicast',
    'rive-quasar',
    'RIVE-CASTLE',
    'rive_castle',
    'castle',
  ];
  const kept = ownLanes(given);
  assert.deepEqual(kept, ['nitro', 'castle'], `only its own lanes survive, got ${kept.join(',')}`);
  // The real allowlist must contain none of them either.
  assert.equal(ownLanes().filter((lane) => /^rive/i.test(lane)).length, 0);
}

console.log('— the provider’s own edge is kept; somebody else’s is not');
{
  const { nxCandidates } = await import('../../dist/backend/sources/nxsha.js');
  const rows = nxCandidates({
    sources: [
      // castle and vixolity, measured: six real rows on two titles, 1080p and
      // Japanese among them. This is nxsha's own Cloudflare edge, the same case
      // source-2 documents for its own proxy - NOT a relay.
      //
      // Every fixture carries a language, and that is not cosmetic: a row that
      // names no language is now refused on its own account, so an unlabelled
      // fixture would pass these assertions for the wrong reason and stop
      // testing the host rule at all.
      { url: 'https://catflix.nxstreamhub.workers.dev/a/index.m3u8', type: 'hls', quality: '1080P', language: 'English' },
      { url: 'https://twilight-lake-fd5c.nxstreamhub.workers.dev/b/index.m3u8', type: 'hls', language: 'Japanese' },
      // Somebody else's bridge - greybox's dash-hls-bridge is exactly this shape.
      { url: 'https://dash-hls-bridge.john1mc.workers.dev/?url=x', type: 'hls', language: 'English' },
      { url: 'https://random.someoneelse.workers.dev/a.m3u8', type: 'hls', language: 'English' },
      // A host that literally names itself a proxy.
      { url: 'https://proxy.7movie.ws/a.m3u8', type: 'hls', language: 'English' },
      { url: 'https://relay7.example.net/a.m3u8', type: 'hls', language: 'English' },
    ],
  });
  const urls = rows.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('catflix.nxstreamhub.workers.dev')), 'its own edge is kept');
  assert.ok(urls.some((u) => u.includes('twilight-lake-fd5c.nxstreamhub.workers.dev')), 'both of them');
  assert.equal(urls.length, 2, 'and nothing else survives');
  for (const bad of ['john1mc', 'someoneelse', 'proxy.7movie', 'relay7']) {
    assert.ok(!urls.some((u) => u.includes(bad)), `a foreign bridge is still refused: ${bad}`);
  }
  // An 'edge-' prefix is a name, not evidence. The old regex refused these.
  const named = nxCandidates({ sources: [{ url: 'https://edge-proxy.example.com/a.m3u8', type: 'hls', language: 'English' }] });
  assert.equal(named.length, 0, 'a self-declared proxy is still refused');
  const plain = nxCandidates({ sources: [{ url: 'https://edge12.cdn.example.com/a.m3u8', type: 'hls', language: 'English' }] });
  assert.equal(plain.length, 1, 'but a CDN node merely named edge12 is not');
}

console.log('— a row that names no language is not offered at all');
{
  const { nxCandidates } = await import('../../dist/backend/sources/nxsha.js');
  // This is the case the live board test found: a perfectly good 1080p row on
  // nxsha's own edge, with nothing saying what audio it carries. On a board
  // where the viewer asks for a language, that row can win the race and play
  // something they did not ask for.
  const unlabelled = nxCandidates({
    sources: [
      { url: 'https://catflix.nxstreamhub.workers.dev/a/index.m3u8', type: 'hls', quality: '1080P' },
      { url: 'https://catflix.nxstreamhub.workers.dev/b/index.m3u8', type: 'hls', language: '   ' },
      { url: 'https://catflix.nxstreamhub.workers.dev/c/index.m3u8', type: 'hls', language: null },
      { url: 'https://catflix.nxstreamhub.workers.dev/d/index.m3u8', type: 'hls', language: 'Hindi' },
    ],
  });
  assert.equal(unlabelled.length, 1, 'only the labelled row survives');
  assert.equal(unlabelled[0].claimedAudioLang, 'Hindi');
  // It is a CLAIM and must stay one: the manifest is the only thing that can
  // verify what a file actually carries.
  assert.equal(unlabelled[0].audioLang, undefined, 'a provider label is never promoted to a verified language');
}

console.log('— media rows are filtered the way the board filters them');
{
  const { nxCandidates } = await import('../../dist/backend/sources/nxsha.js');
  const payload = {
    sources: [
      //
      // Every row names a language, so whatever this block refuses, it refuses
      // for the URL/type reason it is asserting and not for silence about audio.
      { url: 'https://wts.itsnitrox.tech/x/index.m3u8', type: 'hls', quality: '1080P', language: 'Hindi' },
      // source-2 refuses these, so source-3 must too
      { url: 'https://bad.workers.dev/manifest.m3u8', type: 'hls', language: 'English' },
      { url: 'https://edge-proxy.example.com/a.m3u8', type: 'hls', language: 'English' },
      { url: 'https://proxy.relay.example.net/a.m3u8', type: 'hls', language: 'English' },
      // Drive pages: refused for six sources already
      { url: 'https://drive.google.com/file/d/abc/view', type: 'hls', language: 'English' },
      { url: 'https://drive.usercontent.google.com/download?id=abc', type: 'hls', language: 'English' },
      // somebody else's player
      { url: 'https://cdn.example.com/embed/player.m3u8', type: 'embed', isEmbed: true, language: 'English' },
      // not media
      { url: 'https://cdn.example.com/film.mp4', type: 'mp4', language: 'English' },
      { url: 'http://plain.example.com/a.m3u8', type: 'hls', language: 'English' },
      { url: 'https://user:pass@cdn.example.com/a.m3u8', type: 'hls', language: 'English' },
      { url: 'not a url', type: 'hls', language: 'English' },
      // a genuine DASH row and a genuine HLS row with no extension
      { url: 'https://cdn.example.com/a.mpd', type: 'dash', language: 'English' },
      { url: 'https://cdn.example.com/stream', type: 'hls', language: 'English' },
      // the same stream again, labelled differently - only the URL decides
      { url: 'https://wts.itsnitrox.tech/x/index.m3u8', type: 'hls', quality: '720P', language: 'Tamil' },
    ],
  };
  const rows = nxCandidates(payload);
  const urls = rows.map((r) => r.url);

  assert.equal(urls[0], 'https://wts.itsnitrox.tech/x/index.m3u8', 'the good row leads');
  assert.equal(rows[0].quality, '1080p', '2160/1080/720 become the board shape');
  assert.equal(rows[0].claimedAudioLang, 'Hindi', 'a declared language is kept as a claim, not as verified audio');
  assert.equal(rows[0].audioLang, undefined, 'and never promoted to verified audio');

  for (const bad of ['workers.dev', 'edge-proxy', 'relay7', 'drive.google.com', 'usercontent', 'embed', '.mp4', 'http://', 'user:pass']) {
    assert.ok(!urls.some((u) => u.includes(bad)), `refused: ${bad}`);
  }
  assert.equal(rows.filter((r) => r.url.endsWith('.mpd')).length, 1, 'DASH is admitted');
  assert.equal(rows.filter((r) => r.type === 'dash').length, 1);
  assert.equal(urls.filter((u) => u.includes('itsnitrox')).length, 1, 'the duplicate collapses');
  assert.ok(rows.every((r) => typeof r.rank === 'number'), 'every row is ranked');
}

console.log('— a row’s own headers are forwarded, and nothing else is');
{
  const { nxCandidates } = await import('../../dist/backend/sources/nxsha.js');
  const rows = nxCandidates({
    sources: [
      {
        url: 'https://wts.itsnitrox.tech/a/index.m3u8',
        type: 'hls',
        // The CDN checks these two; the contract failed this adapter when they
        // were dropped, so they are asserted rather than assumed.
        language: 'English',
        headers: { Referer: 'https://nxsha.space/', Origin: 'https://nxsha.space' },
      },
      {
        url: 'https://cdn.example.com/b/index.m3u8',
        type: 'hls',
        language: 'English',
        // A provider must not be able to inject an arbitrary header.
        headers: { 'X-Injected': 'yes', Cookie: 'session=1', Referer: 'https://ok.example/' },
      },
    ],
  });
  assert.equal(rows[0].headers.Referer, 'https://nxsha.space/', 'the Referer survives');
  assert.equal(rows[0].headers.Origin, 'https://nxsha.space', 'the Origin survives');
  assert.ok(rows[0].headers['User-Agent'], 'a UA is always sent');
  assert.equal(rows[1].headers['X-Injected'], undefined, 'an injected header is dropped');
  assert.equal(rows[1].headers.Cookie, undefined, 'a cookie is never forwarded');
  assert.equal(rows[1].headers.Referer, 'https://ok.example/', 'a legitimate Referer still passes');

  // A header value that tries to split the request is refused outright.
  const hostile = nxCandidates({
    sources: [{ url: 'https://cdn.example.com/c/index.m3u8', language: 'English', headers: { Referer: 'https://a/\r\nX: y' } }],
  });
  assert.equal(hostile[0].headers.Referer, undefined, 'a CRLF in a header value is not forwarded');
}

console.log('— a resolve asks only lanes that exist, and never source-1’s');
{
  const { createNxshaAdapter } = await import('../../dist/backend/sources/nxsha.js');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const endpoint = String(url).includes('/api/servers') ? 'servers' : 'sources';
    if (endpoint === 'servers') {
      // The site lists source-1's lanes alongside its own. Both must be offered;
      // only its own may be requested.
      const body = { servers: [{ scraper: 'rive-citadel' }, { scraper: 'nitro' }, { scraper: 'ghost-lane' }] };
      // Seal the way the site does, so the adapter has to decode for real.
      const { seal } = await import('../../dist/backend/sources/nxsha.js');
      return new Response(JSON.stringify({ _hash: seal(body) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const { seal } = await import('../../dist/backend/sources/nxsha.js');
    return new Response(
      JSON.stringify({
        _hash: seal({
          sources: [{ url: 'https://wts.itsnitrox.tech/a/index.m3u8', type: 'hls', language: 'English' }],
        }),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const adapter = createNxshaAdapter({ fetchImpl });
  const result = await adapter.resolve({ type: 'movie', tmdbId: '550' });

  assert.equal(adapter.id, 'source-3');
  assert.equal(result.candidates.length, 1, 'one lane answered, one candidate');
  const requested = calls.filter((u) => u.includes('/api/sources')).length;
  assert.equal(requested, 1, `only nitro is requested — got ${requested} lane call(s)`);
  assert.ok(
    !calls.some((u) => decodeURIComponent(u).includes('rive-citadel')),
    'source-1’s lane is never requested',
  );
  assert.ok(!calls.some((u) => u.includes('ghost-lane')), 'a lane the allowlist does not know is never requested');
}

console.log('— a rotated key is reported, not guessed at');
{
  const { createNxshaAdapter } = await import('../../dist/backend/sources/nxsha.js');
  const { seal } = await import('../../dist/backend/sources/nxsha.js');
  const fetchImpl = async () =>
    new Response(JSON.stringify({ _hash: seal({ servers: [] }, 'a-key-this-build-has-never-seen') }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const adapter = createNxshaAdapter({ fetchImpl });
  const result = await adapter.resolve({ type: 'movie', tmdbId: '550' });
  // No throw, no invented candidates. The lane simply has nothing to say.
  assert.deepEqual(result.candidates, [], 'a key rotation yields no candidates rather than an exception');
}

console.log('\n✓ nxsha: sealed envelope, RiveStream excluded, own edge kept, foreign bridges and Drive refused');
