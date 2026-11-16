/**
 * DVD-style bouncing title logo for the startup screen.
 *
 * The classic screensaver: the logo travels across the screen at a constant
 * speed, bounces off the edges, and shifts colour on every bounce. Here the
 * "logo" is the title's own TMDB logo, so the wait looks like it belongs to the
 * title you pressed play on instead of a spinner.
 *
 * Deliberate constraints:
 *  - a single requestAnimationFrame loop, paused while the tab is hidden;
 *  - it only exists while the loading screen is visible;
 *  - `prefers-reduced-motion: reduce` gets the logo centred and still;
 *  - it never blocks pointer events on anything underneath.
 */

export interface DvdBounce {
  /** Swap the artwork (metadata often arrives after the screen opens). */
  setImage(url: string | null): void;
  /** Start or resume the loop. */
  start(): void;
  /** Stop the loop without removing the artwork. */
  stop(): void;
  destroy(): void;
}

const SPEED_PX_PER_SEC = 118;

export function mountDvdBounce(layer: HTMLElement): DvdBounce {
  const reducedMotion = (): boolean =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const art = document.createElement('img');
  art.className = 'elf-dvd-art';
  art.alt = '';
  art.decoding = 'async';
  art.fetchPriority = 'high';
  art.draggable = false;
  // Hidden until the image actually decodes; the backdrop carries the screen
  // meanwhile, so there is never an empty frame.
  art.style.visibility = 'hidden';

  layer.appendChild(art);

  let x = 0;
  let y = 0;
  let vx = SPEED_PX_PER_SEC;
  let vy = SPEED_PX_PER_SEC * 0.72;
  // Non-browser harnesses (and very old engines) may lack rAF: then the logo is
  // simply placed once instead of animating.
  const canAnimate = typeof window.requestAnimationFrame === 'function';
  let frame: number | null = null;
  let last = 0;
  let running = false;

  const size = (node: HTMLElement): { w: number; h: number } => {
    const rect = node.getBoundingClientRect();
    return { w: rect.width || 160, h: rect.height || 72 };
  };

  const paint = (): void => {
    const node = art;
    const { w, h } = size(node);
    const boundsW = Math.max(0, layer.clientWidth - w);
    const boundsH = Math.max(0, layer.clientHeight - h);
    if (x > boundsW) x = boundsW;
    if (y > boundsH) y = boundsH;
    // Movement only. No hue shift, no rotation filter, no glow tricks — the
    // logo keeps its own artwork and simply travels.
    node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };

  const placeCentre = (): void => {
    const node = art;
    const { w, h } = size(node);
    x = Math.max(0, (layer.clientWidth - w) / 2);
    y = Math.max(0, (layer.clientHeight - h) / 2);
    node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };

  const step = (now: number): void => {
    if (!running) return;
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const node = art;
    const { w, h } = size(node);
    const boundsW = Math.max(0, layer.clientWidth - w);
    const boundsH = Math.max(0, layer.clientHeight - h);

    x += vx * dt;
    y += vy * dt;

    if (x <= 0) {
      x = 0;
      vx = Math.abs(vx);
    } else if (x >= boundsW) {
      x = boundsW;
      vx = -Math.abs(vx);
    }
    if (y <= 0) {
      y = 0;
      vy = Math.abs(vy);
    } else if (y >= boundsH) {
      y = boundsH;
      vy = -Math.abs(vy);
    }

    paint();
    frame = window.requestAnimationFrame(step);
  };

  const start = (): void => {
    if (running) return;
    running = true;
    last = 0;
    if (!canAnimate || reducedMotion()) {
      placeCentre();
      return;
    }
    frame = window.requestAnimationFrame(step);
  };

  const stop = (): void => {
    running = false;
    if (frame !== null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') stop();
    else if (running) start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const onResize = (): void => {
    if (reducedMotion()) placeCentre();
  };
  window.addEventListener('resize', onResize);

  return {
    setImage(url: string | null): void {
      if (!url) {
        art.removeAttribute('src');
        art.style.visibility = 'hidden';
        if (reducedMotion()) placeCentre();
        return;
      }
      if (art.getAttribute('src') === url) return;
      art.onload = () => {
        art.style.visibility = 'visible';
        layer.dataset.ready = 'true';
        if (reducedMotion()) placeCentre();
        else paint();
      };
      // No text fallback by design: if the logo never arrives, the backdrop is
      // the screen. Nothing else is shown.
      art.onerror = () => {
        art.style.visibility = 'hidden';
      };
      art.src = url;
    },
    start,
    stop,
    destroy(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      art.remove();
    },
  };
}
