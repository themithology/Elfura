import assert from 'node:assert/strict';
import { decodeBingrPayload, fetchFromBingr } from '../../dist/backend/sources/source4.js';
function encode(value) {
  const iv=Buffer.alloc(12,42), seed=Buffer.concat([Buffer.from('vY7#qL2!mZ9@wK4$'),iv]);
  let state=Array.from({length:4},(_,i)=>{let x=(0x811c9dc5^Math.imul(0x9e3779b9,i))>>>0;for(const b of seed)x=Math.imul(x^b,0x1000193)>>>0;return x});
  const data=Buffer.from(JSON.stringify(value));let word=0;
  for(let i=0;i<data.length;i++){if(i%4===0){let [a,b,c,d]=state;d=(d+1)>>>0;word=(a+b+d)>>>0;state=[(b^(b>>>9))>>>0,Math.imul(c,9)>>>0,(((c<<21)|(c>>>11))+word)>>>0,d]};data[i]^=(word>>>((i%4)*8))&255;}
  return 'v1.'+Buffer.concat([iv,data]).toString('base64url');
}
const first={servers:[{id:'evion'}],streams:[{url:'https://example.org/hindi.m3u8',language:'Hindi'},{url:'http://127.0.0.1/evil.m3u8'},{url:'https://example.org/embed/123'}]};
const page='self.__next_f.push([1,'+JSON.stringify(JSON.stringify({token:'test',payload:encode(first)}))+'])';
const old=globalThis.fetch;
globalThis.fetch=async url=>String(url).includes('/api/sources?') ? new Response(encode({streams:[{url:'https://example.org/other.m3u8',language:'English'}]})) : new Response(page);
try {
  assert.deepEqual(decodeBingrPayload(encode(first)),first);
  const rows=await fetchFromBingr({type:'movie',tmdbId:'872585',diag:[]});
  assert.equal(rows.length,2);assert.equal(rows[0].audioLang,'hi');assert.equal(rows[1].audioLang,'en');assert.equal(rows[0].multiAudio,undefined);
  assert.deepEqual(await fetchFromBingr({type:'movie',tmdbId:'../../bad'}),[]);
  assert.throws(()=>decodeBingrPayload('v1.bad'));
} finally { globalThis.fetch=old; }
console.log('✓ Bingr protocol, separate-language hints, URL filtering, and input validation');
