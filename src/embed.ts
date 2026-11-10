/**
 * Elfura Player — embed entry
 * ===========================
 * The iframe surface. It passes NO options: everything arrives through the URL
 * (see core/params.ts), which is what makes the embed and the JS SDK the same
 * product with one schema.
 *
 *   <iframe src="https://play.example.com/embed.html?src=...&lang=hi&color=00b4ff"
 *           allow="autoplay; fullscreen; picture-in-picture"
 *           allowfullscreen></iframe>
 */

import { Elfura } from './index';

const host = document.getElementById('player');
if (!host) throw new Error('[elfura] embed.html requires <div id="player">');

const mounted = Elfura.mount(host, {});

// Let the host page learn about us without polling.
window.addEventListener('load', () => {
  document.body.dataset.ready = 'true';
});

// Escape hatch for debugging from the console, namespaced so it never collides.
declare global {
  interface Window {
    __elfura?: typeof mounted;
  }
}
window.__elfura = mounted;

// The server issues an opaque, title-bound analytics ticket for embed pages.
// Calls are fire-and-forget and never delay resolving or starting playback.
const analyticsTicket = (window as unknown as { __ELFURA_BOOT__?: { analyticsTicket?: string } }).__ELFURA_BOOT__?.analyticsTicket;
if (analyticsTicket) {
  const send = (event: 'play' | 'heartbeat' | 'stop' | 'failure') => {
    void fetch('/api/v1/analytics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: analyticsTicket, event, title: mounted.player.getMediaInfo()?.title }), keepalive: true,
    }).catch(() => {});
  };
  mounted.player.video.addEventListener('playing', () => send('play'));
  mounted.player.video.addEventListener('pause', () => send('stop'));
  mounted.player.video.addEventListener('ended', () => send('stop'));
  window.addEventListener('pagehide', () => send('stop'));
  mounted.player.bus.on('error', (data) => {
    const code = (data as { code?: string })?.code;
    if (code === 'all-sources-failed' || code === 'no-sources' || code === 'resolve-failed') send('failure');
  });
  window.setInterval(() => {
    const video = mounted.player.video;
    if (!video.paused && !video.ended && video.readyState >= 2) send('heartbeat');
  }, 20_000);
}
