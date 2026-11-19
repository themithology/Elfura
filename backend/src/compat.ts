/**
 * Runtime compatibility shims.
 *
 * Pterodactyl images are not all on a current Node release. `AbortSignal.any`
 * arrived in Node 20.3; on anything older every adapter throws a TypeError on
 * its first upstream call and the whole source list silently collapses to zero
 * rows — the worst possible failure mode, because it looks like "no sources
 * have this title". Installing the shim costs nothing and removes an entire
 * class of silent breakage.
 */

type AbortSignalStatic = typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal };

const signalStatic = AbortSignal as AbortSignalStatic;

if (typeof signalStatic.any !== 'function') {
  signalStatic.any = (signals: AbortSignal[]): AbortSignal => {
    const controller = new AbortController();
    const listeners: { signal: AbortSignal; handler: () => void }[] = [];
    const detach = () => {
      for (const { signal, handler } of listeners) signal.removeEventListener('abort', handler);
      listeners.length = 0;
    };
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
      const handler = () => {
        detach();
        controller.abort(signal.reason);
      };
      signal.addEventListener('abort', handler, { once: true });
      listeners.push({ signal, handler });
    }
    return controller.signal;
  };
}

export const runtimeSummary = (): string =>
  `node=${process.version} abortSignalAny=${typeof signalStatic.any === 'function' ? 'native' : 'shimmed'}`;
