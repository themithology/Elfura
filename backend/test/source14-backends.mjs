/**
 * Source 14 — per-backend health and captions.
 *
 * Everything here comes from real responses captured from
 * `scrapper.rivestream.app/api/provider?provider=...&id=550`:
 *
 *   citadel   -> 200, 2 sources, 26 captions        (answered fast)
 *   flowcast  -> 200, 3 sources, full caption set   (needed >1.1s)
 *   guru      -> 200, {"data":null}                 (nothing for this title)
 *   hindicast -> 500 {"error":"Internal Server Error"}
 *
 * The adapter used to merge every backend into one body map, so all four of these
 * looked identical: one "source-14" line with a row count. A backend that was
 * answering fine but had nothing for the title was indistinguishable from one
 * returning 500 and from one that never replied — and because the per-provider
 * leash was 1100 ms, flowcast (which genuinely works) was recorded as `timeout`
 * on every single resolve and its rows were thrown away.
 *
 * These cases pin the distinction, because the panel is only useful if "empty",
 * "error" and "did not answer" are different words.
 */
import assert from 'node:assert/strict';

const { captionsByProvider, fetchProviders, parseRiveRow } = await import('../../dist/backend/sources/source14.js');
const { normalizeLang } = await import('../../dist/backend/sources/lang.js');

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ---- Captured payload shapes ------------------------------------------------
const citadelBody = {
  data: {
    sources: [
      {
        quality: '720p | English',
        // Verbatim from the live API. Expiry is in the future by design.
        url: 'https://img1.hscow.com/hls/78164859/720/index_287.m3u8?Expires=1794874383&KeyName=Signature&Signature=Zb60Im-ZMwgxrgBbdSsocE4BjJHQQEgA1kHVrjNNrP9VgJXZviHn205QkRMGAMQyIUa-qudbOVPmTI-XB08xAw==',
        source: 'Citadel',
        format: 'hls',
      },
    ],
    captions: [
      { file: 'https://img1.bhcxy.com/subtitle/78164859/English.vtt', label: 'English - Citadel', language: 'English', type: 'vtt' },
      { file: 'https://img1.fhxod.com/subtitle/78164859/German.vtt', label: 'Germany - Citadel', language: 'Germany', type: 'vtt' },
      { file: 'https://img1.bhcxy.com/subtitle/78164859/Hindi.vtt', label: 'हिन्दी - Citadel', language: 'हिन्दी', type: 'vtt' },
    ],
  },
};

const flowcastBody = {
  data: {
    sources: [
      {
        quality: 720,
        // A relay URL: the adapter deliberately refuses to promote these as a
        // lane (somebody else's bandwidth), so this row is expected to be dropped.
        url: 'https://cors.corsflix.net/proxy?url=https%3A%2F%2Fbcdnw.hakunaymatata.com%2Fresource%2Feb63.mp4',
        source: 'FlowCast',
        format: 'mp4',
      },
    ],
    captions: [
      { label: 'हिन्दी - FlowCast', file: 'https://cacdn.hakunaymatata.com/msubt/88ea.srt?Policy=p&Signature=s' },
      { label: 'ਪੰਜਾਬੀ - FlowCast', file: 'https://cacdn.hakunaymatata.com/msubt/a169.srt?Policy=p&Signature=s' },
    ],
  },
};

const guruBody = { data: null };
const hindicastBody = { error: 'Internal Server Error' };

console.log('\nSource 14 — backends');

await check('citadel /hls/ paths are accepted, not just /hls_mps/ (regression)', () => {
  // The path pattern used to require `hls_mps`, so every direct `/hls/` row was
  // dropped — and in the live payload that is the 720p rendition, the best
  // quality citadel publishes. The symptom was a source that returned 26
  // captions and zero playable streams.
  const sig = 'Zb60Im-ZMwgxrgBbdSsocE4BjJHQQEgA1kHVrjNNrP9VgJXZviHn205QkRMGAMQyIUa-qudbOVPmTI-XB08xAw==';
  const mk = (path) =>
    `https://img1.hscow.com${path}?Expires=1794874383&KeyName=Signature&Signature=${sig}`;
  // citadel always names its audio in `quality` ("720p | English") and the
  // adapter refuses a citadel row that does not, so the fixture has to match.
  for (const path of ['/hls/78164859/720/index_287.m3u8', '/hls_mps/78164859/480/index_287.m3u8', '/myhls_mps/78164859/480/index_287.m3u8']) {
    const row = parseRiveRow({ quality: '720p | English', url: mk(path), format: 'hls' }, 'citadel', 20);
    assert.ok(row, `${path} must be accepted`);
    assert.equal(row.quality, '720p');
  }
  // A citadel row with no language is still refused: that rule is unchanged.
  assert.equal(parseRiveRow({ quality: '720p', url: mk('/hls/1/720/index_1.m3u8'), format: 'hls' }, 'citadel', 20), null);
  // Still rejects anything that is not a signed citadel rendition.
  assert.equal(parseRiveRow({ quality: '720p | English', url: 'https://img1.hscow.com/hls/1/720/other.m3u8', format: 'hls' }, 'citadel', 20), null);
  assert.equal(parseRiveRow({ quality: '720p | English', url: 'https://evil.example/hls/1/720/index_1.m3u8', format: 'hls' }, 'citadel', 20), null);
});

await check('captions are extracted from a provider payload', () => {
  const tracks = captionsByProvider({ citadel: citadelBody });
  assert.equal(tracks.length, 3);
  assert.equal(tracks[0].format, 'vtt');
  assert.match(tracks[0].url, /^https:\/\/img1\./);
});

await check('the "- Provider" suffix is stripped from caption labels', () => {
  const tracks = captionsByProvider({ citadel: citadelBody });
  for (const track of tracks) {
    assert.ok(!/-\s*Citadel/.test(track.label), `provider suffix left in label: ${track.label}`);
  }
});

await check('native-script and country-name labels resolve to a language code', () => {
  const tracks = captionsByProvider({ citadel: citadelBody });
  const byUrl = Object.fromEntries(tracks.map((t) => [t.url.split('/').pop(), t]));
  assert.equal(byUrl['English.vtt'].lang, 'en');
  assert.equal(byUrl['German.vtt'].lang, 'de', '"Germany" is a country name, not a language');
  assert.equal(byUrl['Hindi.vtt'].lang, 'hi', 'हिन्दी must resolve, not fall through to und');
});

await check('flowcast captions survive the same path', () => {
  const tracks = captionsByProvider({ flowcast: flowcastBody });
  assert.equal(tracks.length, 2);
  const langs = tracks.map((t) => t.lang).sort();
  assert.deepEqual(langs, ['hi', 'pa']);
});

await check('data:null contributes no captions and does not throw', () => {
  assert.deepEqual(captionsByProvider({ guru: guruBody }), []);
  assert.deepEqual(captionsByProvider({ hindicast: hindicastBody }), []);
});

await check('caption URLs from an unexpected scheme are refused', () => {
  const tracks = captionsByProvider({
    x: { data: { sources: [], captions: [{ file: 'javascript:alert(1)', label: 'Hindi', type: 'vtt' }] } },
  });
  assert.deepEqual(tracks, [], 'only http(s) caption URLs may be exposed');
});

await check('empty, error and no-response are three different states', async () => {
  const realFetch = globalThis.fetch;
  const trace = [];
  globalThis.fetch = async (input) => {
    const provider = new URL(String(input)).searchParams.get('provider');
    if (provider === 'citadel') return Response.json(citadelBody);
    if (provider === 'flowcast') return Response.json(flowcastBody);
    if (provider === 'guru') return Response.json(guruBody);
    if (provider === 'hindicast') return new Response('{"error":"Internal Server Error"}', { status: 500 });
    // quasar / primevids: never answer
    return new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        reject(err);
      }, 5);
    });
  };
  try {
    const result = await fetchProviders({ type: 'movie', tmdbId: '550' }, trace);
    // citadel survives; flowcast's only row is a corsflix relay, which the
    // adapter refuses on purpose (it must not be promoted as a lane).
    assert.equal(result.candidates.length, 1, 'citadel row must survive; the relay row must not');
    assert.ok(result.subtitles.length >= 4, 'captions from both backends must be collected');

    const line = trace.join(' ');
    assert.match(line, /citadel=ok\/1/, `citadel should read ok/1, got: ${line}`);
    assert.match(line, /flowcast=ok\/1/, `flowcast should read ok/1 (it answered), got: ${line}`);
    assert.match(line, /guru=empty/, `guru returns data:null and must read "empty", got: ${line}`);
    assert.match(line, /hindicast=http=500/, `hindicast must read its status, got: ${line}`);
    assert.match(line, /timeout/, `a non-answering backend must read timeout, got: ${line}`);
    assert.match(line, /captions=5/, `captions must be counted, got: ${line}`);

    // The two dead backends must not have silently removed the live ones.
    const urls = result.candidates.map((c) => c.url);
    assert.ok(urls.some((u) => u.includes('hscow')), 'citadel row missing');
    assert.ok(!urls.some((u) => u.includes('corsflix')), 'relay rows must not be promoted');
    assert.equal(new Set(urls).size, urls.length, 'no duplicate URLs');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('a slow backend is not reported as a timeout at 1.1s', async () => {
  // The regression this guards: flowcast needs >1.1s and was therefore never
  // usable. Answer at 1.6s and assert the row survives.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const provider = new URL(String(input)).searchParams.get('provider');
    if (provider !== 'flowcast') {
      // The other backends must fail fast, not hang: the adapter awaits all of
      // them, so an unresolvable promise would block the test rather than the
      // code under test.
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1600));
    // A direct MP4 (not a relay) so the row is eligible; the point of this case
    // is timing, not URL filtering.
    return Response.json({
      data: {
        sources: [{ quality: 720, url: 'https://bcdnw.hakunaymatata.com/resource/eb63.mp4?sign=a', format: 'mp4', source: 'FlowCast' }],
        captions: [],
      },
    });
  };
  try {
    const result = await fetchProviders({ type: 'movie', tmdbId: '550' }, []);
    assert.equal(result.candidates.length, 1, 'a 1.6s backend must still contribute its row');
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('language aliases behave', () => {
  assert.equal(normalizeLang('Germany').code, 'de');
  assert.equal(normalizeLang('Deutsch').code, 'de');
  assert.equal(normalizeLang('हिन्दी').code, 'hi');
  assert.equal(normalizeLang('ਪੰਜਾਬੀ').code, 'pa');
  assert.equal(normalizeLang('বাংলা').code, 'bn');
  assert.equal(normalizeLang('Something Unmapped').code, 'und');
});

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'all checks passed'}\n`);
process.exit(failures.length ? 1 : 0);
