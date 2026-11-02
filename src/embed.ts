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
