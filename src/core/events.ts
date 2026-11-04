/**
 * Elfura Player — Events & postMessage bridge
 * ===========================================
 *
 * A versioned envelope so a host page can tell our messages apart from other
 * iframes on the page, and so we can evolve the payload without breaking
 * existing integrations.
 *
 *   -> parent   { __elfura: 1, v: 1, kind: 'event', name, data, sessionId }
 *   <- parent   { __elfura: 1, v: 1, kind: 'cmd',   name, data, reqId }
 *   -> parent   { __elfura: 1, v: 1, kind: 'ack',   reqId, ok, data | error }
 *
 * Commands are acked, so a host can `await` a command instead of guessing.
 */

export type EventName =
  | 'ready'
  | 'state'
  | 'timeupdate'
  | 'progress'
  | 'durationchange'
  | 'play'
  | 'pause'
  | 'ended'
  | 'buffering'
  | 'buffered'
  | 'error'
  | 'server:switch'
  | 'sources'
  | 'sourceChange'
  | 'audioTracks'
  | 'audioChange'
  | 'audio:searching'
  | 'audio:unavailable'
  | 'subtitleTracks'
  | 'subtitleChange'
  | 'subtitleStyle'
  | 'qualityLevels'
  | 'qualityChange'
  | 'qualityEffective'
  | 'volumechange'
  | 'speedchange'
  | 'segments:invalidate'
  | 'autoplay:blocked'
  | 'fullscreen'
  | 'zoomChange'
  | 'audioBoostChange'
  | 'subtitleOffsetChange'
  | 'episodesCatalog'
  | 'episodeChange'
  | 'nextEpisodeReady'
  | 'back'
  | 'episode:next'
  | 'media'
  | 'config';

export type CommandName =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'seek'
  | 'skip'
  | 'setVolume'
  | 'mute'
  | 'setSpeed'
  | 'setQuality'
  | 'setSource'
  | 'setAudio'
  | 'setSubtitle'
  | 'setSubtitleOffset'
  | 'setAudioBoost'
  | 'setZoomMode'
  | 'loadEpisode'
  | 'setSubtitleStyle'
  | 'resetSubtitleStyle'
  | 'setConfig'
  | 'getState'
  | 'getSchema'
  | 'fullscreen'
  | 'pip'
  | 'setEpisodes'
  | 'next';

export interface Envelope<T = unknown> {
  __elfura: 1;
  v: 1;
  kind: 'event' | 'cmd' | 'ack';
  name: string;
  data?: T;
  sessionId?: string;
  reqId?: string;
  ok?: boolean;
  error?: string;
}

export const isEnvelope = (msg: unknown): msg is Envelope =>
  !!msg && typeof msg === 'object' && (msg as Envelope).__elfura === 1;

type Handler<T = unknown> = (data: T) => void;

/** In-process typed event bus. Also the source that feeds postMessage. */
export class EventBus {
  private map = new Map<string, Set<Handler>>();

  on<T = unknown>(name: string, fn: Handler<T>): () => void {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name)!.add(fn as Handler);
    return () => this.off(name, fn);
  }

  off<T = unknown>(name: string, fn: Handler<T>): void {
    this.map.get(name)?.delete(fn as Handler);
  }

  emit<T = unknown>(name: string, data?: T): void {
    this.map.get(name)?.forEach((fn) => {
      try {
        fn(data);
      } catch (err) {
        // A throwing listener must never break playback.
        console.error(`[elfura] listener for "${name}" threw`, err);
      }
    });
  }

  clear(): void {
    this.map.clear();
  }
}

export interface BridgeOptions {
  sessionId: string;
  /** Only post to / accept from this origin. '*' disables the check. */
  targetOrigin: string;
  enabled: boolean;
  debug?: boolean;
  /** Throttling for high-frequency events (ms). 0 = every frame. */
  timeupdateHz?: number;
}

/**
 * Bridges the EventBus to window.parent, and dispatches inbound commands.
 * Origin-locked in both directions — we never post to an unknown parent and
 * never execute a command from an unknown sender.
 */
export class PostMessageBridge {
  private opts: BridgeOptions;
  private commands = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  private lastTimePost = 0;
  private bound = false;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
  }

  bind(bus: EventBus, window_: Window = window): void {
    if (this.bound) return;
    this.bound = true;

    // Outbound: forward every bus event to the parent.
    const forward = (name: EventName) => (data: unknown) => this.post('event', name, data);
    const EVENTS: EventName[] = [
      'ready', 'state', 'timeupdate', 'progress', 'durationchange', 'play', 'pause', 'ended',
      'buffering', 'buffered', 'error', 'server:switch', 'sources', 'sourceChange',
      'audioTracks', 'audioChange', 'audio:searching', 'audio:unavailable',
      'subtitleTracks', 'subtitleChange', 'subtitleStyle',
      'qualityLevels', 'qualityChange', 'qualityEffective', 'volumechange', 'speedchange',
      'autoplay:blocked', 'fullscreen', 'back', 'episode:next', 'config',
    ];
    for (const e of EVENTS) bus.on(e, forward(e));

    // Inbound: commands from the parent.
    window_.addEventListener('message', (ev: MessageEvent) => {
      if (!this.originAllowed(ev.origin)) {
        if (this.opts.debug) console.warn('[elfura] ignored message from disallowed origin', ev.origin);
        return;
      }
      if (!isEnvelope(ev.data) || ev.data.kind !== 'cmd') return;
      void this.handleCommand(ev.data, ev.origin);
    });
  }

  register(name: CommandName, fn: (data: unknown) => unknown | Promise<unknown>): void {
    this.commands.set(name, fn);
  }

  /** Update the allowed parent origin (learned from referrer or handshake). */
  setTargetOrigin(origin: string): void {
    this.opts.targetOrigin = origin;
  }

  private originAllowed(origin: string): boolean {
    if (!this.opts.enabled) return false;
    if (this.opts.targetOrigin === '*') return true;
    return origin === this.opts.targetOrigin;
  }

  private async handleCommand(msg: Envelope, origin: string): Promise<void> {
    const fn = this.commands.get(msg.name);
    if (!fn) {
      this.postTo(origin, 'ack', msg.name, undefined, { reqId: msg.reqId, ok: false, error: `unknown command "${msg.name}"` });
      return;
    }
    try {
      const result = await fn(msg.data);
      this.postTo(origin, 'ack', msg.name, result, { reqId: msg.reqId, ok: true });
    } catch (err) {
      this.postTo(origin, 'ack', msg.name, undefined, {
        reqId: msg.reqId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  post(kind: Envelope['kind'], name: string, data?: unknown, extra: Partial<Envelope> = {}): void {
    if (!this.opts.enabled) return;
    this.postTo(this.opts.targetOrigin, kind, name, data, extra);
  }

  private postTo(origin: string, kind: Envelope['kind'], name: string, data?: unknown, extra: Partial<Envelope> = {}): void {
    if (window.parent === window) return; // not embedded
    const target = origin && origin !== '*' ? origin : '*';
    const envelope: Envelope = {
      __elfura: 1,
      v: 1,
      kind,
      name,
      data,
      sessionId: this.opts.sessionId,
      ...extra,
    };
    if (this.opts.debug) console.debug('[elfura] ->', envelope);
    try {
      window.parent.postMessage(envelope, target);
    } catch (err) {
      console.warn('[elfura] postMessage failed', err);
    }
  }

  /** Rate-limited helper for timeupdate, which otherwise fires ~4x/second per player. */
  postTime(data: unknown): void {
    const hz = this.opts.timeupdateHz ?? 250;
    const now = performance.now();
    if (hz > 0 && now - this.lastTimePost < hz) return;
    this.lastTimePost = now;
    this.post('event', 'timeupdate', data);
  }
}

/** Small helper a host site can drop in to talk to the iframe with promises. */
export function createHostClient(iframe: HTMLIFrameElement, targetOrigin = '*') {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  window.addEventListener('message', (ev: MessageEvent) => {
    if (!isEnvelope(ev.data)) return;
    if (ev.data.kind === 'ack' && ev.data.reqId) {
      const p = pending.get(ev.data.reqId);
      if (!p) return;
      pending.delete(ev.data.reqId);
      if (ev.data.ok) p.resolve(ev.data.data);
      else p.reject(new Error(ev.data.error ?? 'command failed'));
    }
  });

  let seq = 0;
  return {
    send(name: CommandName, data?: unknown): Promise<unknown> {
      const reqId = `r${++seq}`;
      return new Promise((resolve, reject) => {
        pending.set(reqId, { resolve, reject });
        iframe.contentWindow?.postMessage({ __elfura: 1, v: 1, kind: 'cmd', name, data, reqId } satisfies Envelope, targetOrigin);
        setTimeout(() => {
          if (pending.delete(reqId)) reject(new Error(`command "${name}" timed out`));
        }, 8000);
      });
    },
    on(name: EventName, fn: (data: unknown) => void): () => void {
      const h = (ev: MessageEvent) => {
        if (isEnvelope(ev.data) && ev.data.kind === 'event' && ev.data.name === name) fn(ev.data.data);
      };
      window.addEventListener('message', h);
      return () => window.removeEventListener('message', h);
    },
  };
}
