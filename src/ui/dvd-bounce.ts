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
  setImage(url: string | null, label?: string): void;
  /** Start or resume the loop. */
  start(): void;
  /** Stop the loop without removing the artwork. */
  stop(): void;
  destroy(): void;
}

const SPEED_PX_PER_SEC = 118;
const HUE_STEP_DEG = 47;

export function mountDvdBounce(layer: HTMLElement, label = 'Loading'): DvdBounce {
  const reducedMotion = (): boolean =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const art = document.createElement('img');
  art.className = 'elf-dvd-art';
  art.alt = '';
  art.decoding = 'async';
  art.draggable = false;
  art.hidden = true;

  const fallback = document.createElement('span');
  fallback.className = 'elf-dvd-wordmark';
  fallback.textContent = label;
  fallback.hidden = true;

  layer.appendChild(art);
  layer.appendChild(fallback);

  let x = 0;
  let y = 0;
  let vx = SPEED_PX_PER_SEC;
  let vy = SPEED_PX_PER_SEC * 0.72;
  let hue = 0;
  let tilt = -6;
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
    const node = art.hidden ? fallback : art;
    const { w, h } = size(node);
    const boundsW = Math.max(0, layer.clientWidth - w);
    const boundsH = Math.max(0, layer.clientHeight - h);
    if (x > boundsW) x = boundsW;
    if (y > boundsH) y = boundsH;
    node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) rotate(${tilt}deg)`;
    node.style.filter = hue ? `hue-rotate(${hue}deg) saturate(1.15)` : 'none';
  };

  const placeCentre = (): void => {
    const node = art.hidden ? fallback : art;
    const { w, h } = size(node);
    x = Math.max(0, (layer.clientWidth - w) / 2);
    y = Math.max(0, (layer.clientHeight - h) / 2);
    tilt = 0;
    hue = 0;
    node.style.filter = 'none';
    node.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  };

  const step = (now: number): void => {
    if (!running) return;
    if (!last) last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const node = art.hidden ? fallback : art;
    const { w, h } = size(node);
    const boundsW = Math.max(0, layer.clientWidth - w);
    const boundsH = Math.max(0, layer.clientHeight - h);

    x += vx * dt;
    y += vy * dt;

    let bounced = false;
    if (x <= 0) {
      x = 0;
      vx = Math.abs(vx);
      bounced = true;
    } else if (x >= boundsW) {
      x = boundsW;
      vx = -Math.abs(vx);
      bounced = true;
    }
    if (y <= 0) {
      y = 0;
      vy = Math.abs(vy);
      bounced = true;
    } else if (y >= boundsH) {
      y = boundsH;
      vy = -Math.abs(vy);
      bounced = true;
    }
    if (bounced) {
      hue = (hue + HUE_STEP_DEG) % 360;
      tilt = tilt === 0 ? -6 : 0;
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
    setImage(url: string | null, nextLabel?: string): void {
      if (nextLabel) fallback.textContent = nextLabel;
      if (!url) {
        art.removeAttribute('src');
        art.hidden = true;
        fallback.hidden = false;
        if (reducedMotion()) placeCentre();
        return;
      }
      if (art.src !== url) {
        art.onload = () => {
          art.hidden = false;
          fallback.hidden = true;
          layer.dataset.ready = 'true';
          if (reducedMotion()) placeCentre();
          else paint();
        };
        art.onerror = () => {
          art.hidden = true;
          fallback.hidden = false;
          if (reducedMotion()) placeCentre();
        };
        art.src = url;
      }
    },
    start,
    stop,
    destroy(): void {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      art.remove();
      fallback.remove();
    },
  };
}
