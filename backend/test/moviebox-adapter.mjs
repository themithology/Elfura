import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSource26Adapter, movieBoxDashFromCookie, movieBoxHeaders } from '../../dist/backend/sources/source26.js';

// Default-on, but an explicit deployment setting always wins.
const previousFlag = process.env.ELFURA_MOVIEBOX_ENABLED;
try {
 delete process.env.ELFURA_MOVIEBOX_ENABLED;
 assert.equal(createSource26Adapter().enabled(), true);
 process.env.ELFURA_MOVIEBOX_ENABLED = '0';
 assert.equal(createSource26Adapter().enabled(), false);
 process.env.ELFURA_MOVIEBOX_ENABLED = '1';
 assert.equal(createSource26Adapter().enabled(), true);
} finally {
 if (previousFlag === undefined) delete process.env.ELFURA_MOVIEBOX_ENABLED;
 else process.env.ELFURA_MOVIEBOX_ENABLED = previousFlag;
}

const original = globalThis.fetch;
const calls = [];
const prefix = Buffer.from('https://cdn.example.com/dash/movie/').toString('base64url');
const cookie = `Edge-Cache-Cookie=urlprefix=${prefix}:sign=abc:t=123`;
assert.equal(movieBoxDashFromCookie(cookie), 'https://cdn.example.com/dash/movie/index.mpd');
assert.equal(movieBoxDashFromCookie(`Edge-Cache-Cookie=urlprefix=${Buffer.from('http://127.0.0.1/dash/x').toString('base64url')}:sign=x`), null);
assert.equal(movieBoxDashFromCookie(`Edge-Cache-Cookie=urlprefix=${Buffer.from('https://cdn.example.com/hls/x').toString('base64url')}:sign=x`), null);
const h = movieBoxHeaders('GET', 'https://example.com/path?z=1&a=two%20words', undefined, 'tok', 12345);
const canonical = 'GET\napplication/json\napplication/json\n\n12345\n\n/path?a=two words&z=1';
assert.equal(h['x-tr-signature'], `12345|2|${crypto.createHmac('md5', Buffer.from('efa891974eecd3148df63aa611602defd101259ba521022c57ae0566bd8e','hex')).update(canonical).digest('base64')}`);
let mode = 'movie';
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), opts });
  const u = new URL(url);
  if (u.pathname.endsWith('/visitor-login')) return Response.json({ data: { token: 'test-session' } });
  if (u.pathname.endsWith('/search/v2')) return Response.json({ data: { results: [{ subjects: [
    { subjectId: '123', title: mode === 'movie' ? 'Example' : 'Example Show S1', subjectType: mode === 'movie' ? 1 : 2, releaseDate: '2020-01-01' },
  ] }] } });
  if (u.pathname.endsWith('/play-info/v2')) return Response.json({ data: { streams: mode === 'movie' ? [
    { url: 'https://macdn.aoneroom.com/other/notice.mp4', signCookie: cookie },
    { url: 'https://cdn.example.com/file.mkv' },
    { url: 'http://127.0.0.1/x.mp4' },
  ] : [] } });
  if (u.pathname.endsWith('/resource/v2')) return Response.json({ data: { list: mode === 'tv' ? [
    { se: 1, ep: 2, resourceId: '456', resourceLink: 'https://macdn.aoneroom.com/other/notice.mp4', resolution: 720 },
  ] : [] } });
  if (u.pathname.endsWith('/resource-position/v2')) return Response.json({ data: { list: [
    { se: 1, ep: 1, resourceId: '456', url: 'https://cdn.example.com/wrong.mp4' },
    { se: 1, ep: 2, resourceId: '999', url: 'https://cdn.example.com/wrong2.mp4' },
    { se: 1, ep: 2, resourceId: '456', url: 'https://cdn.example.com/episode.mp4' },
  ] } });
  throw new Error('unexpected request');
};
try {
 const adapter = createSource26Adapter(() => true);
 const movie = await adapter.resolve({ type:'movie', tmdbId:'1', title:'Example', year:'2020' });
 assert.equal(movie.candidates.length, 1); assert.equal(movie.candidates[0].type, 'dash'); assert.equal(movie.candidates[0].headers.Cookie, cookie);
 mode = 'tv';
 const tv = await adapter.resolve({ type:'tv', tmdbId:'2', title:'Example Show', year:'2020', season:1, episode:2 });
 assert.equal(tv.candidates.length, 1); assert.equal(tv.candidates[0].url, 'https://cdn.example.com/episode.mp4'); assert.equal(tv.candidates[0].type, 'mp4');
 assert.equal(calls.filter(c => c.url.includes('visitor-login')).length, 1);
 assert.match(calls.find(c => c.url.includes('play-info') && c.url.includes('se=1')).url, /ep=2/);
 const wrongYear = await adapter.resolve({ type:'movie', tmdbId:'1', title:'Example Show', year:'1999' });
 assert.deepEqual(wrongYear.candidates, []);
 const disabled = createSource26Adapter(() => false); const count = calls.length;
 await disabled.resolve({type:'movie',tmdbId:'1'}); assert.equal(calls.length, count);
} finally { globalThis.fetch = original; }
console.log('MovieBox: signing, safety, title matching, episode-scoped recovery and session reuse OK');

// Signed cookies must never follow cross-origin playlist references.
const { rewriteHlsManifest, rewriteDashManifest, decodeProxyHeaders } = await import('../../dist/backend/stream-proxy.js');
const headers = { Cookie: 'signed=secret', Authorization: 'Bearer secret', Referer:'https://player.example/' };
const hls = rewriteHlsManifest('#EXTM3U\n#EXTINF:1,\nhttps://other.example/part.ts\n#EXTINF:1,\nlocal.ts', 'https://cdn.example.com/master.m3u8', headers, '/api/proxy');
const urls = hls.split('\n').filter(x => x.startsWith('/api/proxy')).map(x => new URL(x, 'https://elfura.test'));
const firstHeaders = decodeProxyHeaders(urls[0].searchParams.get('h'));
const secondHeaders = decodeProxyHeaders(urls[1].searchParams.get('h'));
assert.equal(firstHeaders.cookie, undefined); assert.equal(firstHeaders.authorization, undefined); assert.equal(firstHeaders.referer, headers.Referer);
assert.equal(secondHeaders.cookie, headers.Cookie);
const dash = rewriteDashManifest('<MPD><Period><BaseURL>https://other.example/</BaseURL><Representation><SegmentTemplate media="v/$Number$.m4s" initialization="init.mp4"/></Representation></Period></MPD>', 'https://cdn.example.com/index.mpd', headers, '/api/proxy');
const match = dash.match(/media="([^"]+)"/)[1].replaceAll('&amp;','&');
const dashHeaders = decodeProxyHeaders(new URL(match, 'https://elfura.test').searchParams.get('h'));
assert.equal(dashHeaders.cookie, undefined);
console.log('Signed headers stay scoped to the manifest origin');
