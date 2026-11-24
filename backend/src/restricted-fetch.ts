import dns from 'node:dns';
import net from 'node:net';
import {loadUndici} from './undici-loader.js';
import {isPublicMediaUrl, matchesRestrictedOrigin} from './security.js';

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

type GuardedEgress = { undici: typeof import('undici'); dispatcher: import('undici').Dispatcher };

let agentPromise: Promise<GuardedEgress> | undefined;
async function guardedAgent(): Promise<GuardedEgress> {
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
    const dispatcher = new undici.Agent({connect:{lookup: lookup as never}, keepAliveTimeout: 10_000});
    return { undici, dispatcher };
  })();
  return agentPromise;
}

/**
 * The fetch that belongs to `dispatcher`.
 *
 * A Dispatcher only works with the undici that created it. Handing it to a
 * different copy — for example Node's built-in fetch when the runtime bundles a
 * newer undici than the one in node_modules — is refused before any bytes leave
 * the process. undici 8's fetch hands its handler to a v6 Agent, v6's handler
 * validation finds no `onError`, and every request dies in ~6 ms with
 * `UND_ERR_INVALID_ARG: invalid onError method`, which reads exactly like every
 * provider going down at once. `undici.fetch` is that dispatcher's own, so the
 * pair always matches regardless of the Node version.
 */
function fetchForDispatcher(undici: typeof import('undici'), requested?: typeof fetch): typeof fetch {
  return (requested ?? testOverride ?? undici.fetch) as unknown as typeof fetch;
}

/**
 * Test seam, and nothing else.
 *
 * The restricted lane must always be driven by the undici that built its
 * dispatcher, so it cannot be observed by replacing `globalThis.fetch` the way
 * the rest of the app can. Tests that need to see these requests install their
 * stub here instead. Production never calls this.
 */
let testOverride: typeof fetch | null = null;
export function setRestrictedFetchForTests(impl: typeof fetch | null): void {
  testOverride = impl;
}

/**
 * Never route this request through a Worker/HTTP proxy: those resolve DNS on
 * another machine where this check cannot control the destination address.
 * This is deliberately scoped to the new untrusted anime lanes.
 */
export async function restrictedFetch(
  input: string | URL,
  init: RequestInit = {},
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const url = String(input);
  if (!isPublicMediaUrl(url)) throw new Error('blocked media target');
  const { undici, dispatcher } = await guardedAgent();
  const send = fetchForDispatcher(undici, fetchImpl);
  // The dispatcher comes from the npm undici package; a `RequestInit` that
  // carries one is a superset of what the DOM lib declares, so the cast goes
  // through `unknown` on purpose.
  return send(url, {...init, redirect: 'manual', dispatcher} as unknown as RequestInit);
}

/** Follow at most three validated hops, never forwarding secrets cross-origin. */
export async function restrictedFetchWithRedirects(
  raw: string,
  init: RequestInit,
  policy: string,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  let current=raw;
  let headers=new Headers(init.headers);
  for(let hop=0;hop<=3;hop++) {
    if(!matchesRestrictedOrigin(current,policy)) throw new Error('blocked media target');
    const response=await restrictedFetch(current,{...init,headers},fetchImpl);
    if(response.status<300 || response.status>=400) {
      if (!response.url) try {Object.defineProperty(response,'url',{value:current,configurable:true});} catch { /* optional metadata */ }
      return response;
    }
    const location=response.headers.get('location');
    await response.body?.cancel().catch(()=>{});
    if(!location || hop===3) throw new Error('media redirect limit');
    const next=new URL(location,current);
    if(!matchesRestrictedOrigin(next.href,policy)) throw new Error('blocked media redirect');
    if(next.origin!==new URL(current).origin) {
      headers=new Headers(headers);
      for(const name of ['authorization','cookie','proxy-authorization','x-api-key'])headers.delete(name);
    }
    current=next.href;
  }
  throw new Error('media redirect limit');
}
