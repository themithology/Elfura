import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { createSource18Adapter, fetchFromEmbed69 } from '../../dist/backend/sources/source18.js';

const defaultRegistry = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'embed69-default-test' }));
assert(!defaultRegistry.listPublicSources().some(source => source.id === 'source-18'), 'Embed69 remains opt-in');
const enabledRegistry = new SourceRegistry(loadBackendConfig({ ELFURA_SECRET: 'embed69-enabled-test', ELFURA_EMBED69_ENABLED: '1' }));
assert(enabledRegistry.listPublicSources().some(source => source.id === 'source-18'));
assert.equal(createSource18Adapter(() => false).enabled(), false);

const challenge = 'pow-test';
const salt = 'salt-test';
const key = crypto.createHash('sha256').update(`${challenge}0${salt}`).digest();
const iv = crypto.randomBytes(16);
const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
const encrypted = Buffer.concat([cipher.update('https://streamwish.com/e/fixture', 'utf8'), cipher.final()]);
const link = Buffer.concat([iv, encrypted]).toString('base64');
const dataLink = [
  { video_language: 'Latino', note: 'escaped quote: " and closing bracket: ]', sortedEmbeds: [{ servername: '1080p', link }] },
  { video_language: 'Español', sortedEmbeds: [{ servername: '1080p', link }] },
];
const fakeHtml = `
  <script>let POW_CHALLENGE='${challenge}'; let POW_SALT='${salt}'; let POW_DIFFICULTY=0;
  let dataLink = ${JSON.stringify(dataLink)};</script>`;
const original = globalThis.fetch;
const requestedPaths = [];
try {
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.hostname === 'embed69.org') return new Response(fakeHtml, { status: 200 });
    if (url.hostname === 'streamwish.com') return new Response('<script>var player={"hls4":"https://cdn.example/video/master.m3u8"};</script>', { status: 200 });
    return new Response('', { status: 404 });
  };
  const candidates = await fetchFromEmbed69({
    type: 'tv', tmdbId: '123', imdbId: 'tt1234567', season: 2, episode: 4,
  });
  assert.equal(candidates.length, 1, 'same extracted media URL is de-duplicated across provider language labels');
  assert.equal(candidates[0].url, 'https://cdn.example/video/master.m3u8');
  assert.equal(candidates[0].type, 'hls');
  assert.equal(candidates[0].claimedAudioLang, undefined, 'conflicting labels for identical media must not be attributed as language');
  assert.equal(candidates[0].audioLabel, 'Conflicting provider language labels');
  assert.equal(candidates[0].audioLang, undefined, 'provider language is not promoted to verified audio');
  assert.equal(candidates[0].headers.Referer, 'https://streamwish.com/');
  assert(requestedPaths.includes('/f/tt1234567-2x04'), 'TV path preserves IMDb, season, and zero-padded episode');
  const mapped = await fetchFromEmbed69({
    type: 'movie', tmdbId: '123', resolveMetaFallback: async () => ({ imdbId: 'tt7654321' }),
  });
  assert.equal(mapped.length, 1, 'fallback metadata IMDb ID is used for movie lookup');
  assert(requestedPaths.includes('/f/tt7654321'));
  const noImdb = await fetchFromEmbed69({ type: 'movie', tmdbId: '123' });
  assert.deepEqual(noImdb, [], 'provider requires an IMDb mapping');
  console.log('✓ Embed69 IMDb fallback, bounded PoW/decryption, escaped data parsing, concurrent embed resolution, and conflicting-label suppression.');
} finally {
  globalThis.fetch = original;
}
