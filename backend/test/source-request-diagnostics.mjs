import assert from 'node:assert/strict';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {describeFailure} from '../../dist/backend/sources/net-tap.js';

assert.equal(describeFailure(new DOMException('timed out','TimeoutError')),'timeout');
assert.equal(describeFailure(new DOMException('aborted','AbortError')),'timeout');
assert.equal(describeFailure(new TypeError('fetch failed',{cause:{code:'ECONNRESET'}})),'tls-reset');

const oldFetch=globalThis.fetch, oldWarn=console.warn;
const keepAlive=setInterval(()=>{},1000);
const logs=[];
let calls=0, release;
const waiting=new Promise(resolve=>{release=resolve;});
globalThis.fetch=async input=>{
 if(!String(input).includes('diagnostic.invalid')) return new Response('not found',{status:404});
 calls++; await waiting; return new Response('blocked',{status:403});
};
console.warn=(...args)=>logs.push(args.join(' '));
try {
 const registry=new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'diagnostic-test-secret',TMDB_API_KEY:'',OPENSUBTITLES_ENABLED:'0'}));
 registry.adapters=[{id:'source-3',label:'Source 3',enabled:()=>true,resolve:async()=>{
   await fetch('https://diagnostic.invalid/provider'); return {candidates:[]};
 }}];
 const query={type:'movie',tmdbId:'1234567'};
 const a=registry.resolvePlayback(query), b=registry.resolvePlayback(query);
 await new Promise(r=>setTimeout(r,50));
 assert.equal(calls,1,'concurrent lookups share the same underlying adapter');
 release();
 await Promise.all([a,b]);
 const initial=logs.filter(s=>s.includes('[elfura-sources] source-3'));
 assert(initial.some(s=>s.includes('1 req')&&s.includes('lookup=fresh')), 'fresh lookup reports its observed fetch');
 assert(initial.some(s=>s.includes('0 req')&&s.includes('lookup=shared')), 'shared lookup explains that its fetch is attributed elsewhere');
 await registry.resolvePlayback(query);
 assert.equal(calls,2,'an empty result is not retained in the adapter payload cache');
 assert(logs.filter(s=>s.includes('lookup=fresh')).length>=2,'next lookup is fresh');
 console.log('✓ source diagnostics: fresh and shared requests distinguished; empty results not payload-cached');
} finally {globalThis.fetch=oldFetch;console.warn=oldWarn;clearInterval(keepAlive);}
