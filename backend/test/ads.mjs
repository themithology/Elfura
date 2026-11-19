import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Pop-under ad policy.
 *
 * Ads belong in the embed player and nowhere else. These tests pin the rules the
 * operator asked for: per-site ad-free switches, no ads on localhost, and the
 * two brand domains always exempt. They also pin the negative: no referrer means
 * no ad, because unattributed pop-unders get ad accounts banned.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elfura-ads-'));
process.env.ROXY_DATA_DIR = dir;
process.env.ELFURA_SECRET = 'ads-test-secret';
process.env.ALLOWED_ORIGINS = '*';
process.env.OPENSUBTITLES_ENABLED = '0';
process.env.ELFURA_SELF_TEST = '0';
process.env.TMDB_API_BASE = 'https://tmdb.fake';
process.env.TMDB_API_KEY = 'x';
delete process.env.ELFURA_POPUNDER_SRC;

const { AdSettingsStore, decideAds, isLocalHostname, normalizeHost, siteMatches, ALWAYS_AD_FREE } =
  await import('../../dist/backend/ads.js');

// ── helpers ────────────────────────────────────────────────────────────────
assert.equal(normalizeHost('https://WWW.Example.COM:8443/watch?x=1'), 'example.com');
assert.equal(normalizeHost(' example.com. '), 'example.com');
assert.equal(normalizeHost('http://user:pw@player.example.com/a'), 'player.example.com');

for (const local of ['localhost', '127.0.0.1', '::1', '10.0.0.5', '192.168.1.9', '172.16.4.2', 'box.local', 'app.internal']) {
  assert.ok(isLocalHostname(local), `${local} must count as local`);
}
for (const publicHost of ['theogpiratebot.online', 'example.com', '8.8.8.8']) {
  assert.ok(!isLocalHostname(publicHost), `${publicHost} must not count as local`);
}
assert.ok(siteMatches('player.example.com', ['example.com']));

// ── policy ─────────────────────────────────────────────────────────────────
const on = { enabled: true, adFreeSites: [] };

assert.equal(decideAds({ parentSite: 'https://partner.example.com', requestHost: 'player.elfura.app' }, on).serve, true);
assert.equal(
  decideAds({ parentSite: 'https://theogpiratebot.online', requestHost: 'player.x' }, on).serve,
  false,
  'brand domain is always ad-free',
);
assert.equal(decideAds({ parentSite: 'https://www.theogpiratebot.to/watch', requestHost: 'player.x' }, on).serve, false);
assert.equal(decideAds({ parentSite: 'http://localhost:5173', requestHost: 'player.x' }, on).serve, false);
assert.equal(decideAds({ parentSite: 'https://partner.example.com', requestHost: 'localhost:8787' }, on).serve, false);
assert.equal(decideAds({ parentSite: '', requestHost: 'player.x' }, on).serve, false, 'no referrer, no ad');
assert.equal(decideAds({ parentSite: 'https://partner.example.com', requestHost: 'player.x' }, { enabled: false, adFreeSites: [] }).serve, false);
assert.equal(
  decideAds({ parentSite: 'https://partner.example.com', requestHost: 'player.x' }, { enabled: true, adFreeSites: ['partner.example.com'] }).serve,
  false,
  'site marked ad-free in the panel',
);

// ── persistence (admin panel writes) ───────────────────────────────────────
const store = new AdSettingsStore(dir);
assert.equal(store.get().enabled, true, 'ads default on');
store.setSiteAdFree('https://www.Partner.Example.com/watch', true);
assert.deepEqual(store.get().adFreeSites, ['partner.example.com']);
const reopened = new AdSettingsStore(dir);
assert.deepEqual(reopened.get().adFreeSites, ['partner.example.com'], 'settings survive a restart');
reopened.setSiteAdFree('partner.example.com', false);
assert.deepEqual(new AdSettingsStore(dir).get().adFreeSites, []);
reopened.setEnabled(false);
assert.equal(new AdSettingsStore(dir).get().enabled, false);

// ── injection: the tag lands in the embed document only ────────────────────
// Start from a clean, ads-on state, then drive every switch through the admin
// API the panel itself uses — that is the path an operator actually clicks.
new AdSettingsStore(dir).setEnabled(true);
const { createBackendServer } = await import('../../dist/backend/index.js');
const realFetch = globalThis.fetch;
const { server } = createBackendServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// Behind a proxy the public host arrives as X-Forwarded-Host. Without it the
// request host is 127.0.0.1 — which is exactly the "no ads while developing"
// case, covered separately below.
const get = (p, referer, publicHost = 'player.elfura.app') =>
  realFetch(`http://127.0.0.1:${port}${p}`, {
    headers: {
      Accept: 'text/html',
      ...(publicHost ? { 'X-Forwarded-Host': publicHost } : {}),
      ...(referer ? { Referer: referer } : {}),
    },
  });

try {
  const login = await realFetch(`http://127.0.0.1:${port}/roxy/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` },
    body: JSON.stringify({ password: 'ads-test-secret' }),
  });
  assert.equal(login.status, 200, 'admin login works');
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  const admin = (method, body) =>
    realFetch(`http://127.0.0.1:${port}/roxy/api/ads`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}`, Cookie: cookie },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const initial = await (await admin('GET')).json();
  assert.equal(initial.enabled, true);
  assert.deepEqual(initial.alwaysAdFree, ['theogpiratebot.online', 'theogpiratebot.to']);
  assert.equal(initial.localhostExempt, true);

  const partner = await (await get('/embed/movie/550', 'https://partner.example.com/watch')).text();
  assert.ok(partner.includes('4xfreedom.com'), 'partner embed carries the pop-under tag');
  assert.equal(partner.split('4xfreedom.com').length - 1, 1, 'exactly one ad tag');
  assert.ok(/<script data-cfasync="false" src="https:\/\/4xfreedom\.com\/1\/[a-f0-9]+" async><\/script>/.test(partner));

  const brand = await (await get('/embed/movie/550', 'https://theogpiratebot.online/movie/550')).text();
  assert.ok(!brand.includes('4xfreedom.com'), 'brand domain never carries ads');
  const brandTo = await (await get('/embed/movie/550', 'https://www.theogpiratebot.to/watch')).text();
  assert.ok(!brandTo.includes('4xfreedom.com'), 'second brand domain never carries ads');

  const localReferer = await (await get('/embed/movie/550', 'http://localhost:3000/movie/550')).text();
  assert.ok(!localReferer.includes('4xfreedom.com'), 'localhost referer is exempt');

  const noReferer = await (await get('/embed/movie/550')).text();
  assert.ok(!noReferer.includes('4xfreedom.com'), 'unattributed embed carries no ads');

  // Panel switch: mark the partner site ad-free, next load is clean.
  assert.equal((await admin('POST', { site: 'https://partner.example.com/watch', adFree: true })).status, 200);
  const afterSwitch = await (await get('/embed/movie/550', 'https://partner.example.com/watch')).text();
  assert.ok(!afterSwitch.includes('4xfreedom.com'), 'site marked ad-free gets no tag');

  // And back on again.
  await admin('POST', { site: 'partner.example.com', adFree: false });
  const backOn = await (await get('/embed/movie/550', 'https://partner.example.com/watch')).text();
  assert.ok(backOn.includes('4xfreedom.com'), 'removing the exemption restores ads');

  // Global switch wins over everything.
  await admin('POST', { enabled: false });
  const globallyOff = await (await get('/embed/movie/550', 'https://partner.example.com/watch')).text();
  assert.ok(!globallyOff.includes('4xfreedom.com'), 'global switch off means no ads anywhere');
  await admin('POST', { enabled: true });

  // Other surfaces stay clean: the website is not the player.
  const landing = await (await get('/', 'https://partner.example.com/watch')).text();
  assert.ok(!landing.includes('4xfreedom.com'), 'the website itself never carries the ad script');

  // Same embed, no proxy header: the request host is 127.0.0.1, so no ads.
  const devBox = await (await get('/embed/movie/550', 'https://partner.example.com/watch', '')).text();
  assert.ok(!devBox.includes('4xfreedom.com'), 'a loopback request host is always exempt');

  console.log('✓ pop-under ads: embed only, per-site ad-free switch, localhost and brand domains exempt');
} finally {
  globalThis.fetch = realFetch;
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.ok(ALWAYS_AD_FREE.length === 2);
}
