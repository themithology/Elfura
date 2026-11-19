import assert from 'node:assert/strict';
import {parseIntroDbMarkers, fetchSkipMarkers} from '../../dist/backend/segments.js';
assert.deepEqual(parseIntroDbMarkers({intro:[{start_ms:435985,end_ms:535607}],credits:[{start_ms:3629920,end_ms:null}]},3720),{intro:[435.985,535.607],outro:[3629.92,3720]});
assert.deepEqual(parseIntroDbMarkers({intro:[{start_ms:null,end_ms:90000}],credits:[{start_ms:1000,end_ms:5000000}]},3600),{intro:[0,90]});
assert.deepEqual(parseIntroDbMarkers({intro:[{start_ms:3000,end_ms:2000}],credits:[{start_ms:'1',end_ms:null}]},3600),{});
assert.deepEqual(parseIntroDbMarkers(null,3600),{});
const original=globalThis.fetch;let calls=0;
globalThis.fetch=async url=>{calls++;assert.equal(new URL(url).searchParams.get('duration_ms'),'3720000');return {ok:true,json:async()=>({type:'tv',season:1,episode:1,intro:[{start_ms:1000,end_ms:2000}]})};};
try {const q={tmdbId:'1399',season:1,episode:1,duration:3720};const result=await Promise.all([fetchSkipMarkers(q),fetchSkipMarkers(q)]);assert.deepEqual(result[0],{intro:[1,2]});assert.equal(calls,1);await fetchSkipMarkers(q);assert.equal(calls,1);}finally{globalThis.fetch=original;}
console.log('✓ Skip markers validate boundaries and cache concurrent results.');
