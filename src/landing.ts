import './landing.css';

document.documentElement.classList.add('js');

const $ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T => {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Landing element not found: ${selector}`);
  return node;
};
const $$ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll<T>(selector));

/* Navigation, scroll state, and section reveals */
const header = $('[data-header]');
const updateHeader = () => header.classList.toggle('scrolled', window.scrollY > 20);
window.addEventListener('scroll', updateHeader, { passive: true });
updateHeader();

const menuButton = $<HTMLButtonElement>('.menu-toggle');
const mobileNav = $('#mobile-nav');
const setMenu = (open: boolean) => {
  mobileNav.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  $('use', menuButton).setAttribute('href', open ? '#i-close' : '#i-menu');
  document.body.classList.toggle('menu-open', open);
};
menuButton.addEventListener('click', () => setMenu(mobileNav.hidden));
$$('a', mobileNav).forEach((link) => link.addEventListener('click', () => setMenu(false)));

const revealItems = $$('[data-reveal]');
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.08, rootMargin: '0px 0px -35px' },
  );
  revealItems.forEach((item) => observer.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add('revealed'));
}

/* Toasts and clipboard */
let toastTimer = 0;
const showToast = (message: string) => {
  const toast = $('[data-toast]');
  $('span', toast).textContent = message;
  toast.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2200);
};
const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  showToast('Copied to clipboard');
};
$$('[data-copy-target]').forEach((button) => {
  button.addEventListener('click', () => {
    const id = button.getAttribute('data-copy-target') || '';
    void copyText(document.getElementById(id)?.textContent || '');
  });
});

/* Live TMDB catalog, hero demo, poster rail, and builder picks */
type DemoKind = 'movie' | 'tv';
type CatalogItemType = 'movie' | 'tv' | 'anime';
type CatalogFilter = 'all' | CatalogItemType;
interface CatalogItem {
  tmdbId: string;
  type: CatalogItemType;
  title: string;
  year: string;
  overview: string;
  rating: number | null;
  poster: string | null;
  backdrop: string | null;
}
interface CatalogPayload {
  ok: boolean;
  generatedAt: string;
  movies: CatalogItem[];
  series: CatalogItem[];
  anime: CatalogItem[];
}

let catalog: CatalogPayload = { ok: false, generatedAt: '', movies: [], series: [], anime: [] };
let activeDemoKind: DemoKind = 'movie';
let activeDemoItem: CatalogItem | null = null;
let activeCatalogFilter: CatalogFilter = 'all';
let catalogLoading = false;
let builderTouched = false;
const demoFrame = $<HTMLIFrameElement>('[data-demo-iframe]');
const demoOverlay = $('[data-demo-overlay]');
const demoBackdrop = $<HTMLImageElement>('[data-demo-backdrop]');
const demoPlayButton = $<HTMLButtonElement>('[data-demo-play]');

const demoItems = (kind: DemoKind): CatalogItem[] =>
  kind === 'movie' ? catalog.movies : [...catalog.series, ...catalog.anime];
const embedPathFor = (item: CatalogItem): string =>
  item.type === 'movie' ? `/embed/movie/${item.tmdbId}` : `/embed/tv/${item.tmdbId}/1/1`;
const catalogFeed = (filter: CatalogFilter): CatalogItem[] => {
  if (filter === 'movie') return catalog.movies;
  if (filter === 'tv') return catalog.series;
  if (filter === 'anime') return catalog.anime;
  const mixed: CatalogItem[] = [];
  const lists = [catalog.movies, catalog.series, catalog.anime];
  for (let index = 0; index < 20; index++) {
    for (const list of lists) if (list[index]) mixed.push(list[index]);
  }
  return mixed;
};

const resetDemoFrame = () => {
  demoFrame.src = 'about:blank';
  demoFrame.hidden = true;
  demoOverlay.hidden = false;
};
const selectDemoItem = (item: CatalogItem, reset = true) => {
  activeDemoItem = item;
  activeDemoKind = item.type === 'movie' ? 'movie' : 'tv';
  $$('[data-demo-type]').forEach((tab) => {
    const selected = tab.getAttribute('data-demo-type') === activeDemoKind;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  $('[data-demo-kicker]').textContent = item.type === 'anime' ? 'POPULAR ANIME · LIVE TMDB PICK' : 'TRENDING THIS WEEK · LIVE TMDB PICK';
  $('[data-demo-title]').textContent = item.title;
  $('[data-demo-meta]').textContent = `${item.year || 'Now playing'}  ·  ${item.type === 'movie' ? 'Movie' : item.type === 'anime' ? 'Anime' : 'Series'}${item.rating ? `  ·  ★ ${item.rating}` : ''}  ·  Multi-audio`;
  const artwork = item.backdrop || item.poster;
  demoBackdrop.hidden = !artwork;
  if (artwork) demoBackdrop.src = artwork;
  demoBackdrop.alt = `${item.title} artwork`;
  demoPlayButton.disabled = false;
  $('span', demoPlayButton).textContent = 'Play demo';
  $<HTMLAnchorElement>('[data-demo-open]').href = `${embedPathFor(item)}?color=f4f4f4`;
  if (reset) resetDemoFrame();
};
demoBackdrop.addEventListener('error', () => { demoBackdrop.hidden = true; });

const loadDemo = () => {
  if (!activeDemoItem) {
    void loadCatalog();
    return;
  }
  demoFrame.src = `${embedPathFor(activeDemoItem)}?color=f4f4f4&autoplay=1`;
  demoFrame.hidden = false;
  demoOverlay.hidden = true;
};
demoPlayButton.addEventListener('click', loadDemo);
$$('[data-demo-type]').forEach((button) => {
  button.addEventListener('click', () => {
    const kind = button.getAttribute('data-demo-type') as DemoKind;
    activeDemoKind = kind;
    const current = activeDemoItem && demoItems(kind).some((item) => item.tmdbId === activeDemoItem?.tmdbId && item.type === activeDemoItem?.type)
      ? activeDemoItem
      : demoItems(kind)[0];
    if (current) selectDemoItem(current);
    else {
      activeDemoItem = null;
      $$('[data-demo-type]').forEach((tab) => {
        const selected = tab === button;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-selected', String(selected));
      });
      resetDemoFrame();
    }
  });
});
$('[data-demo-shuffle]').addEventListener('click', () => {
  const items = demoItems(activeDemoKind);
  if (!items.length) {
    void loadCatalog();
    return;
  }
  const currentIndex = activeDemoItem ? items.findIndex((item) => item.tmdbId === activeDemoItem?.tmdbId && item.type === activeDemoItem.type) : -1;
  const next = items[(currentIndex + 1 + items.length) % items.length];
  selectDemoItem(next);
});

const renderPosterRail = () => {
  const track = $('[data-poster-track]');
  const items = catalogFeed(activeCatalogFilter).slice(0, 18);
  track.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'catalog-loading';
    const message = document.createElement('p');
    message.textContent = catalogLoading ? 'Loading this week’s TMDB catalog…' : 'The live catalog is temporarily unavailable.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = catalogLoading ? 'Loading…' : 'Retry catalog';
    retry.disabled = catalogLoading;
    retry.addEventListener('click', () => void loadCatalog());
    empty.append(message, retry);
    track.append(empty);
    return;
  }
  // Two identical sets make the continuous rail seamless. Both sets remain
  // generated from the live response and clickable to the matching real demo.
  for (const item of [...items, ...items]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'poster-item';
    button.setAttribute('aria-label', `Load ${item.title} in the demo`);
    const image = document.createElement('img');
    image.src = item.poster || item.backdrop || '';
    image.alt = `${item.title} poster`;
    image.loading = 'lazy';
    image.addEventListener('error', () => button.classList.add('image-error'), { once: true });
    const info = document.createElement('span');
    info.className = 'poster-item-info';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const meta = document.createElement('small');
    meta.textContent = `${item.type} ${item.year ? `· ${item.year}` : ''} ${item.rating ? `· ★ ${item.rating}` : ''}`;
    info.append(title, meta);
    button.append(image, info);
    button.addEventListener('click', () => {
      selectDemoItem(item);
      $('#demo').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    track.append(button);
  }
};
$$('[data-catalog-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    activeCatalogFilter = button.getAttribute('data-catalog-filter') as CatalogFilter;
    $$('[data-catalog-filter]').forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    renderPosterRail();
  });
});

const renderBuilderPicks = () => {
  const host = $('[data-builder-picks]');
  host.replaceChildren();
  const items = demoItems(selectedMediaType()).slice(0, 3);
  if (!items.length) return;
  const label = document.createElement('span');
  label.textContent = 'TRENDING QUICK PICKS';
  host.append(label);
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${item.title}${item.year ? ` · ${item.year}` : ''}`;
    button.title = `Use ${item.title} (TMDB ${item.tmdbId})`;
    button.addEventListener('click', () => {
      field('tmdb').value = item.tmdbId;
      builderTouched = true;
      updateGeneratedCode();
      $$('button', host).forEach((pick) => pick.classList.toggle('active', pick === button));
    });
    host.append(button);
  }
};

async function loadCatalog(): Promise<void> {
  if (catalogLoading) return;
  catalogLoading = true;
  renderPosterRail();
  try {
    const response = await fetch('/api/v1/catalog', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Catalog returned ${response.status}`);
    const payload = await response.json() as CatalogPayload;
    if (!payload.ok || ![...payload.movies, ...payload.series, ...payload.anime].length) {
      throw new Error('Catalog is empty');
    }
    catalog = payload;
    const first = demoItems(activeDemoKind)[0] || catalogFeed('all')[0];
    if (first) selectDemoItem(first);
    if (!builderTouched) {
      const pick = demoItems(selectedMediaType())[0];
      if (pick) field('tmdb').value = pick.tmdbId;
      updateGeneratedCode();
    }
    renderBuilderPicks();
    const featureItem = catalogFeed('all').find((item) => item.poster);
    const featureArt = $<HTMLImageElement>('[data-catalog-feature-art]');
    if (featureItem?.poster) {
      featureArt.src = featureItem.poster;
      featureArt.alt = `${featureItem.title} poster`;
      featureArt.hidden = false;
    }
    const updated = new Date(payload.generatedAt);
    $('.catalog-heading-side > p').textContent = `LIVE TMDB CATALOG · UPDATED ${updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    $('[data-demo-kicker]').textContent = 'LIVE CATALOG TEMPORARILY UNAVAILABLE';
    $('[data-demo-title]').textContent = 'The next great story is one retry away.';
    $('[data-demo-meta]').textContent = 'Check the API connection and retry the live catalog.';
    demoPlayButton.disabled = false;
    $('span', demoPlayButton).textContent = 'Retry catalog';
  } finally {
    catalogLoading = false;
    renderPosterRail();
  }
}

/* Feature demonstrations */
$$('[data-audio]').forEach((button) => {
  button.addEventListener('click', () => {
    $$('[data-audio]').forEach((row) => row.classList.toggle('active', row === button));
    $('[data-audio-status]').textContent = `${button.getAttribute('data-audio')} selected`;
  });
});
$$('[data-quality]').forEach((button) => {
  button.addEventListener('click', () => {
    const quality = button.getAttribute('data-quality') || 'Auto';
    $$('[data-quality]').forEach((item) => item.classList.toggle('active', item === button));
    $('[data-quality-label]').textContent = quality;
    const heights = quality === '720p' ? [20, 28, 32, 38, 45, 51, 58, 61, 66, 72] : quality === 'Auto' ? [24, 45, 31, 62, 48, 76, 55, 88, 69, 100] : [24, 36, 31, 55, 47, 72, 66, 88, 78, 100];
    $$('.quality-chart i').forEach((bar, index) => bar.style.setProperty('--h', `${heights[index]}%`));
  });
});
$$('[data-caption]').forEach((button) => {
  button.addEventListener('click', () => {
    const style = button.getAttribute('data-caption') || '';
    $$('[data-caption]').forEach((item) => item.classList.toggle('active', item === button));
    $('[data-sample-caption]').className = `sample-caption ${style}`;
  });
});
let skipDemoStep = 0;
$('[data-skip-demo]').addEventListener('click', () => {
  skipDemoStep = (skipDemoStep + 1) % 3;
  const button = $('[data-skip-demo]');
  const marker = $('.skip-timeline b');
  if (skipDemoStep === 1) {
    button.innerHTML = 'Skip Outro <span>»</span>';
    marker.style.left = '85%';
  } else if (skipDemoStep === 2) {
    button.innerHTML = 'Next Episode · E02 <span>»</span>';
    marker.style.left = '96%';
  } else {
    button.innerHTML = 'Skip Intro <span>»</span>';
    marker.style.left = '10%';
  }
});

/* Embed builder */
const form = $<HTMLFormElement>('#embed-form');
const builderFrame = $<HTMLIFrameElement>('[data-builder-iframe]');
const builderEmpty = $('[data-builder-empty]');
let lastDefaults: DemoKind = 'movie';
const field = <T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string): T =>
  form.elements.namedItem(name) as T;
const selectedMediaType = (): DemoKind =>
  (form.querySelector<HTMLInputElement>('input[name="mediaType"]:checked')?.value || 'movie') as DemoKind;
const buildEmbedUrl = (): string => {
  const type = selectedMediaType();
  const id = field('tmdb').value.trim() || '{tmdbId}';
  const season = Math.max(1, Number(field('season').value) || 1);
  const episode = Math.max(1, Number(field('episode').value) || 1);
  const path = type === 'movie' ? `/embed/movie/${encodeURIComponent(id)}` : `/embed/tv/${encodeURIComponent(id)}/${season}/${episode}`;
  const url = new URL(path, window.location.origin);
  const color = field('color').value.replace('#', '');
  url.searchParams.set('color', color);
  const lang = field<HTMLSelectElement>('lang').value;
  const sublang = field<HTMLSelectElement>('sublang').value;
  const start = Math.max(0, Number(field('start').value) || 0);
  if (lang) url.searchParams.set('lang', lang);
  if (sublang) url.searchParams.set('sublang', sublang);
  if (start) url.searchParams.set('t', String(start));
  if (field('autoplay').checked) url.searchParams.set('autoplay', '1');
  if (type === 'tv') url.searchParams.set('episodeSelector', '1');
  if (type === 'tv' && field('autoNext').checked) url.searchParams.set('autoplayNextEp', '1');
  return url.toString();
};
const updateGeneratedCode = () => {
  const url = buildEmbedUrl();
  const code = `<iframe\n  src="${url}"\n  title="TheOGPirateBot player"\n  width="100%"\n  height="100%"\n  style="aspect-ratio:16/9;border:0;border-radius:12px"\n  allow="autoplay; fullscreen; picture-in-picture; encrypted-media"\n  allowfullscreen\n></iframe>`;
  $('[data-generated-url]').textContent = url;
  $('[data-generated-iframe]').textContent = code;
  $('[data-color-value]').textContent = field('color').value.toUpperCase();
};
const updateMediaFields = () => {
  const type = selectedMediaType();
  $$('.tv-fields').forEach((row) => { (row as HTMLElement).hidden = type !== 'tv'; });
  if (type !== lastDefaults) {
    field('tmdb').value = demoItems(type)[0]?.tmdbId || '';
    lastDefaults = type;
  }
  updateGeneratedCode();
  renderBuilderPicks();
};
form.addEventListener('input', (event) => {
  const inputName = (event.target as HTMLInputElement).name;
  if (inputName === 'tmdb' || inputName === 'mediaType') builderTouched = true;
  if (inputName === 'mediaType') updateMediaFields();
  else updateGeneratedCode();
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  updateGeneratedCode();
  builderEmpty.hidden = true;
  builderFrame.src = buildEmbedUrl();
});
updateGeneratedCode();

/* Documentation examples and tabs */
const origin = window.location.origin;
const codeExamples: Record<string, string> = {
  movie: `<iframe\n  src="${origin}/embed/movie/533535?color=f4f4f4"\n  title="Movie player"\n  width="100%"\n  height="100%"\n  style="aspect-ratio:16/9;border:0"\n  allow="autoplay; fullscreen; picture-in-picture"\n  allowfullscreen\n></iframe>`,
  tv: `<iframe\n  src="${origin}/embed/tv/94605/1/1?episodeSelector=1&autoplayNextEp=1"\n  title="Episode player"\n  width="100%"\n  height="100%"\n  style="aspect-ratio:16/9;border:0"\n  allow="autoplay; fullscreen; picture-in-picture"\n  allowfullscreen\n></iframe>`,
  sdk: `import { Elfura } from '${origin}/lib/elfura.js';\nimport '${origin}/lib/elfura-player.css';\n\nconst { player, ui, destroy } = Elfura.mount(\n  document.querySelector('#player'),\n  {\n    tmdb: '94605',\n    mediaType: 'tv',\n    season: 1,\n    episode: 1,\n    lang: 'hi',\n    sublang: 'en',\n    color: '#f4f4f4',\n    autoplayNextEp: true,\n  }\n);\n\nconst state = player.getState();\nconsole.log(state.audioLang, state.qualityMode);`,
  events: `window.addEventListener('message', (event) => {\n  // Always pin the sender to your player origin.\n  if (event.origin !== '${origin}') return;\n  const message = event.data;\n  if (message?.__elfura !== 1 || message.kind !== 'event') return;\n\n  analytics.track(\`player:\${message.name}\`, {\n    ...message.data,\n    sessionId: message.sessionId,\n  });\n});\n\n// Commands use the same versioned, origin-locked envelope.\n// The player acknowledges every command with its reqId.`,
};
$$('[data-code]').forEach((code) => {
  code.textContent = codeExamples[code.getAttribute('data-code') || 'movie'];
});
const selectDocTab = (name: string) => {
  $$('[data-doc]').forEach((button) => {
    const selected = button.getAttribute('data-doc') === name;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  $$('[data-doc-panel]').forEach((panel) => {
    (panel as HTMLElement).hidden = panel.getAttribute('data-doc-panel') !== name;
  });
};
$$('[data-doc]').forEach((button) => button.addEventListener('click', () => selectDocTab(button.getAttribute('data-doc') || 'movie')));
$$('[data-open-events]').forEach((link) => link.addEventListener('click', () => selectDocTab('events')));

/* Real PostMessage telemetry */
interface PlayerMessage {
  __elfura?: number;
  kind?: string;
  name?: string;
  data?: unknown;
}
let lastTimeUpdate = 0;
const compactPayload = (data: unknown): string => {
  if (data == null) return '—';
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') return String(data);
  try {
    const json = JSON.stringify(data);
    return json.length > 72 ? `${json.slice(0, 69)}…` : json;
  } catch {
    return 'event payload';
  }
};
const addPlayerEvent = (name: string, data: unknown) => {
  const list = $('[data-event-list]');
  list.querySelector('.event-empty')?.remove();
  const row = document.createElement('div');
  row.className = 'event-row';
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const eventName = document.createElement('strong');
  eventName.textContent = name;
  const payload = document.createElement('code');
  payload.textContent = compactPayload(data);
  payload.title = compactPayload(data);
  row.append(time, eventName, payload);
  list.prepend(row);
  while (list.children.length > 12) list.lastElementChild?.remove();
};
window.addEventListener('message', (event: MessageEvent<PlayerMessage>) => {
  if (event.origin !== window.location.origin) return;
  const message = event.data;
  if (!message || message.__elfura !== 1 || message.kind !== 'event' || !message.name) return;
  if (message.name === 'timeupdate') {
    const now = performance.now();
    if (now - lastTimeUpdate < 1800) return;
    lastTimeUpdate = now;
  }
  addPlayerEvent(message.name, message.data);
});
$('[data-clear-events]').addEventListener('click', () => {
  $('[data-event-list]').innerHTML = '<div class="event-empty"><span>↳</span><p>Waiting for a player event…<small>Start either live preview on this page.</small></p></div>';
});

/* Health-backed service status */
const setStatusPill = (element: HTMLElement, state: 'operational' | 'checking' | 'down') => {
  element.className = `service-pill ${state}`;
  element.textContent = state === 'operational' ? 'OPERATIONAL' : state === 'down' ? 'UNREACHABLE' : 'CHECKING';
};
const refreshStatus = async () => {
  const button = $('[data-refresh-status]');
  button.classList.add('loading');
  button.setAttribute('aria-busy', 'true');
  $('[data-status-summary]').textContent = 'Checking services…';
  $('[data-status-orb]').className = 'status-orb checking';
  $$('[data-service]').forEach((pill) => setStatusPill(pill, 'checking'));
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6500);
  const started = performance.now();
  try {
    const response = await fetch('/api/v1/health', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`Health returned ${response.status}`);
    const health = await response.json() as { ok?: boolean; sources?: { id: string; label: string }[] };
    if (!health.ok) throw new Error('Health response was not operational');
    const latency = Math.max(1, Math.round(performance.now() - started));
    $('[data-status-summary]').textContent = 'All reported services operational';
    $('[data-status-orb]').className = 'status-orb operational';
    $('[data-status-latency]').textContent = `${latency} ms`;
    setStatusPill($('[data-service="api"]'), 'operational');
    const sourceIds = new Set((health.sources || []).map((source) => source.id));
    for (const id of ['source-1', 'source-2']) setStatusPill($(`[data-service="${id}"]`), sourceIds.has(id) ? 'operational' : 'down');
  } catch {
    $('[data-status-summary]').textContent = 'Status endpoint unreachable';
    $('[data-status-orb]').className = 'status-orb down';
    $('[data-status-latency]').textContent = '—';
    $$('[data-service]').forEach((pill) => setStatusPill(pill, 'down'));
  } finally {
    window.clearTimeout(timeout);
    $('[data-status-time]').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    button.classList.remove('loading');
    button.removeAttribute('aria-busy');
  }
};
$('[data-refresh-status]').addEventListener('click', () => void refreshStatus());
void refreshStatus();
window.setInterval(() => { if (!document.hidden) void refreshStatus(); }, 60_000);
void loadCatalog();

/* Keep accordions concise and support direct documentation/status routes. */
$$<HTMLDetailsElement>('.faq-list details').forEach((details) => {
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    $$<HTMLDetailsElement>('.faq-list details').forEach((other) => { if (other !== details) other.open = false; });
  });
});
$('[data-year]').textContent = String(new Date().getFullYear());
const routeTarget = window.location.pathname === '/docs' ? '#docs' : window.location.pathname === '/status' ? '#status' : window.location.pathname === '/demo' ? '#demo' : '';
if (routeTarget) window.setTimeout(() => document.querySelector(routeTarget)?.scrollIntoView(), 120);
