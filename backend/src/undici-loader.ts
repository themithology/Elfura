/**
 * undici loader — one import, two locations, never a silent dead end
 * ================================================================
 * The deployment ZIP ships undici twice on purpose:
 *
 *   node_modules/undici/   what a normal `node index.js` resolves first
 *   vendor/undici/         a copy outside node_modules
 *
 * Panels differ in what they do at boot. Some only run `node index.js`. Others
 * run `npm install` first, and npm treats a package that is present on disk but
 * absent from `package.json` as extraneous and prunes it — which used to delete
 * undici and take the egress profile, the proxy support and the DNS rescue with
 * it, with no console line explaining why every source had gone quiet.
 *
 * So resolution is tried in order and the reason is logged when both fail.
 * Nothing here changes what a request does; it only decides which dispatcher
 * implementation is available.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type UndiciModule = typeof import('undici');

let resolved: UndiciModule | null | undefined;
let failureReason = '';

/** Path to the copy that does not live under node_modules. */
export function vendoredUndiciPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/undici/index.js');
}

/** True when the fallback copy is present on disk. */
export function hasVendoredUndici(): boolean {
  try {
    return fs.statSync(vendoredUndiciPath()).isFile();
  } catch {
    return false;
  }
}

/**
 * The strongest undici available, or null. Null means requests keep using
 * Node's built-in fetch: the app still runs, but with no proxy and no custom
 * resolver, so callers should say so once rather than fail silently.
 */
export async function loadUndici(): Promise<UndiciModule | null> {
  if (resolved !== undefined) return resolved;
  try {
    resolved = (await import('undici')) as unknown as UndiciModule;
    return resolved;
  } catch (error) {
    const first = error as NodeJS.ErrnoException;
    if (hasVendoredUndici()) {
      try {
        // The vendored copy is CommonJS. Node exposes its named exports here,
        // but wrap it so a bundler that only surfaces `default` still works.
        const loaded = (await import(pathToFileURL(vendoredUndiciPath()).href)) as unknown as
          | UndiciModule
          | { default: UndiciModule };
        if (typeof (loaded as UndiciModule).fetch !== 'function') {
          const fallback = (loaded as { default?: UndiciModule }).default;
          if (!fallback || typeof fallback.fetch !== 'function') throw new Error('unusable module shape');
          resolved = fallback;
        } else {
          resolved = loaded as unknown as UndiciModule;
        }
        return resolved;
      } catch (fallbackError) {
        failureReason =
          `node_modules/undici: ${first.code || first.message}; vendor/undici: ` +
          `${(fallbackError as Error).message}`;
        resolved = null;
        return null;
      }
    }
    failureReason = `node_modules/undici: ${first.code || first.message}; no vendor/undici copy`;
    resolved = null;
    return null;
  }
}

/** Why undici could not be loaded, for the operator-facing log line. */
export function undiciUnavailableReason(): string {
  return failureReason || 'undici is not installed';
}

/** Test hook. */
export function resetUndiciLoaderForTest(): void {
  resolved = undefined;
  failureReason = '';
}
