import assert from 'node:assert/strict';
import { classifyUpstreamHost, classifyUpstreamUrl, RELAY_RANK_PENALTY } from '../../dist/backend/sources/provenance.js';

// Relay fronts: somebody else serves the bytes, so they may never outrank origin lanes.
for (const host of [
  'patient-cherry.workerscloud32.workers.dev',
  'bitter-sun-89a6.pfgqml56272-813.workers.dev',
  'cdn.pages.dev',
  'edge.vercel.app',
  'cors.corsflix.net',
  'prx-1566-ant-r.vmpx.online',
  'proxy.example.com',
  'relay.example.com',
]) {
  assert.equal(classifyUpstreamHost(host), 'relay', `${host} is a relay front`);
}

// Origin CDNs and provider-hosted edges are direct.
for (const host of [
  'hugh.cdn.rumble.cloud',
  'img1.hscow.com',
  'img.hscow.com',
  'cdn.slowcloud.live',
  'paretocdn.site',
  'vidzen.fun',
  'one.kmcloud.lol',
  'cdn.example.net',
]) {
  assert.equal(classifyUpstreamHost(host), 'direct', `${host} is a direct edge`);
}

assert.equal(classifyUpstreamUrl('not a url'), 'direct', 'invalid URLs are left to the caller');
assert.equal(classifyUpstreamUrl('https://WWW.Workers.DEV/x'), 'relay', 'classification is case-insensitive');
assert.equal(RELAY_RANK_PENALTY, 40);

console.log('✓ Provenance classification separates origin CDNs from worker/proxy relay fronts');
