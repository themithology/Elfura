/**
 * vidly adapter — the rules that decide what this lane may say.
 *
 * No network. The page markup is fed in as a string, and every refusal is tested
 * by putting the thing it must refuse into that markup. That matters more than
 * usual here, because the pages measurably DO embed a third-party bridge
 * (`dash-hls-bridge.john1mc.workers.dev`) next to the provider's own hosts, and
 * the bridge answers 502. An adapter that took "the first m3u8 in the HTML"
 * would ship a dead lane and never notice.
 *
 * The other assertion that matters is the positive one: the two measured media
 * hosts must survive, because a stricter allowlist that refuses everything also
 * passes a refusal test.
 */
import assert from 'node:assert/strict';

const { vidlyCandidates, embeddedManifests, qualityOf } = await import('../../dist/backend/sources/vidly.js');
const PAGE = 'https://vidly.pro/watch/tv/1399/1/1';

console.log('— the measured media host is accepted, and the rest of the page is not');
{
  const html = `
    <video data-src="https://img.rousav.tech/media/84ba08366bab854da1bf/index.m3u8"></video>
    <script>{"u":"https://gzip.rousav.tech/media/9/index.m3u8\\"}</script>
    <div data-x="https://dash-hls-bridge.john1mc.workers.dev/hls/abc.m3u8"></div>
    <div data-y="https://evil.example.com/x/index.m3u8"></div>
    <div data-z="http://img.rousav.tech/insecure/index.m3u8"></div>
    <div data-w="https://img.rousav.tech.evil.com/x/index.m3u8"></div>
    <div data-v="https://rousav.tech/media/9/index.m3u8"></div>
    <div data-u="https://img.rousav.tech/media/84ba08366bab854da1bf/index.m3u8"></div>
  `;

  const embedded = embeddedManifests(html);
  const rows = vidlyCandidates(html, PAGE);

  assert.equal(rows.length, 2, `exactly the two own-host rows survive, got ${rows.length}`);
  assert.deepEqual(
    rows.map((r) => new URL(r.url).hostname).sort(),
    ['gzip.rousav.tech', 'img.rousav.tech'],
    'both measured hosts are kept — a refusal-only allowlist would pass every other test and serve nothing',
  );

  const refused = embedded.filter((u) => !rows.some((r) => r.url === u));
  const refusedHosts = refused.map((u) => safeHost(u));
  // The bridge is the documented reason this allowlist exists, not an edge case.
  assert.ok(
    refusedHosts.includes('dash-hls-bridge.john1mc.workers.dev'),
    'the third-party bridge that 502s must be refused',
  );
  assert.ok(refusedHosts.includes('evil.example.com'), 'an unrelated host is refused');
  assert.ok(refusedHosts.includes('img.rousav.tech.evil.com'), 'a suffix spoof is not the own host');
  assert.ok(refusedHosts.includes('rousav.tech'), 'the bare apex is not one of the two measured media hosts');

  // A duplicate embedded URL collapses to one row; otherwise a page that repeats
  // the same manifest in markup and JSON would look like two sources of supply.
  const dupes = embedded.filter((u) => u === 'https://img.rousav.tech/media/84ba08366bab854da1bf/index.m3u8');
  assert.equal(dupes.length, 1, 'the URL set is de-duplicated before rows are built');

  for (const row of rows) {
    assert.equal(row.restrictedOrigin, `https://${new URL(row.url).hostname}`, 'the relay is scoped to the media host');
    assert.equal(row.type, 'hls', 'an .m3u8 is HLS');
    assert.ok(row.headers?.Referer === PAGE, 'the page is the referer, not the site root');
  }
}

console.log('— a page with no manifest yields no rows, and never a fabricated one');
{
  assert.equal(vidlyCandidates('<html><body>404 not found</body></html>', PAGE).length, 0);
  // An embed of somebody else's player is not media.
  assert.equal(vidlyCandidates('<iframe src="https://vidly.pro/embed/550"></iframe>', PAGE).length, 0);
  // A .mp4 is not a stream this board seeks in; only manifests are.
  assert.equal(vidlyCandidates('<a href="https://img.rousav.tech/x.mp4">x</a>', PAGE).length, 0);
  // DASH would be accepted if the own host ever served it.
  const dash = vidlyCandidates('<x data-src="https://img.rousav.tech/m/x.mpd">', PAGE);
  assert.equal(dash.length, 1);
  assert.equal(dash[0].type, 'dash', 'a .mpd is DASH');
}

console.log('— quality comes from the path only when the provider put it there');
{
  assert.equal(qualityOf('https://img.rousav.tech/media/1080p/index.m3u8'), '1080p');
  assert.equal(qualityOf('https://img.rousav.tech/media/84ba08366bab854da1bf/index.m3u8'), 'auto');
  assert.equal(qualityOf('https://img.rousav.tech/720/index.m3u8'), 'auto', 'a bare number in a path segment is not a height');
}

console.log('— the adapter never invents rows when the page cannot be read');
{
  const { createVidlyAdapter } = await import('../../dist/backend/sources/vidly.js');
  const calls = [];
  const adapter = createVidlyAdapter({
    origin: 'https://vidly.pro',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response('<html>nope</html>', { status: 200 });
    },
  });

  assert.equal(adapter.id, 'source-4');
  const result = await adapter.resolve({ type: 'tv', tmdbId: '1399', season: 2, episode: 5 });
  assert.deepEqual(result.candidates, [], 'a page with no manifest is an empty result, not an error and not a guess');
  assert.equal(calls[0], 'https://vidly.pro/watch/tv/1399/2/5', 'TV routes by season and episode');

  await adapter.resolve({ type: 'movie', tmdbId: '550' });
  assert.equal(calls.at(-1), 'https://vidly.pro/watch/movie/550', 'movies route by tmdb only');

  // A rejected TMDB id must not cost a request.
  const before = calls.length;
  await adapter.resolve({ type: 'movie', tmdbId: '../../etc/passwd' });
  assert.equal(calls.length, before, 'a non-numeric id is refused before the network');

  // A failing fetch is an empty result, never a throw into the resolver.
  const broken = createVidlyAdapter({
    fetchImpl: async () => {
      throw new Error('ECONNRESET');
    },
  });
  assert.deepEqual((await broken.resolve({ type: 'movie', tmdbId: '550' })).candidates, []);

  // An oversized Content-Length is refused without reading the body.
  const huge = createVidlyAdapter({
    fetchImpl: async () =>
      new Response('x', { status: 200, headers: { 'content-length': '9000000' } }),
  });
  assert.deepEqual((await huge.resolve({ type: 'movie', tmdbId: '550' })).candidates, []);
}

function safeHost(raw) {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

console.log('✓ vidly: own media hosts kept, third-party bridge and spoofs refused, no fabricated rows');
