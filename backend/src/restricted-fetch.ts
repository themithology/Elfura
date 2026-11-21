import dns from 'node:dns';
import net from 'node:net';
import {loadUndici} from './undici-loader.js';
import {isPublicMediaUrl} from './security.js';

/** Conservative IPv4-only egress for untrusted media references. */
export function isPublicMediaAddress(address: string): boolean {
  if (net.isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

let agentPromise: Promise<import('undici').Dispatcher> | undefined;
async function guardedAgent(): Promise<import('undici').Dispatcher> {
  if (!agentPromise) agentPromise = (async () => {
    const undici = await loadUndici();
    if (!undici) throw new Error('restricted egress unavailable');
    // The lookup is used at connection time; returning only validated IPv4
    // addresses prevents DNS rebinding between a check and the socket connect.
    const lookup = (hostname: string, opts: {all?: boolean}, done: (...args: any[]) => void) => {
      dns.lookup(hostname, {family: 4, all: true, verbatim: true}, (error, addresses) => {
        if (error || !addresses?.length || addresses.some(a => !isPublicMediaAddress(a.address))) {
          const e = error ?? Object.assign(new Error('blocked media DNS'), {code:'EACCES'});
          done(e); return;
        }
        if (opts.all) done(null, addresses);
        else done(null, addresses[0].address, 4);
      });
    };
    return new undici.Agent({connect:{lookup: lookup as never}, keepAliveTimeout: 10_000});
  })();
  return agentPromise;
}

/**
 * Never route this request through a Worker/HTTP proxy: those resolve DNS on
 * another machine where this check cannot control the destination address.
 * This is deliberately scoped to the new untrusted anime lanes.
 */
export async function restrictedFetch(input: string | URL, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = String(input);
  if (!isPublicMediaUrl(url)) throw new Error('blocked media target');
  const dispatcher = await guardedAgent();
  return fetchImpl(url, {...init, redirect: 'manual', dispatcher} as RequestInit);
}
