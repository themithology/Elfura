import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import { localVidlinkToken, createSource24Adapter } from '../../dist/backend/sources/source24.js';

const key=Buffer.from('c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd','hex');
const token=localVidlinkToken('1396',1_700_000_000_000);
const bytes=Buffer.from(token,'base64url');
const plaintext=Buffer.from(nacl.secretbox.open(bytes.subarray(24),bytes.subarray(0,24),key));
assert.equal(plaintext.subarray(0,-8).toString(),'1396');
assert.equal(Number(plaintext.readBigUInt64BE(plaintext.length-8)),1_700_000_480);
assert.equal(localVidlinkToken('../123'),null);
const original=globalThis.fetch;
const cfg={enabled:true,origin:'https://vidlink.pro/api/b',timeoutMs:3000,rank:4};
const q={type:'tv',tmdbId:'1396',season:2,episode:3};
const calls=[];
let mode='local';
globalThis.fetch=async url=>{
 const u=new URL(url);calls.push(u);
 if(u.hostname==='enc-dec.app')return Response.json({result:'remote-token'});
 if(mode==='remote' && !u.pathname.includes('remote-token'))return Response.json(null);
 if(mode==='unsafe' && !u.pathname.includes('remote-token'))return Response.json({stream:{playlist:'http://127.0.0.1/private.m3u8'}});
 if(mode==='throttle')return new Response('',{status:429});
 if(mode==='outage')return new Response('',{status:503});
 return Response.json({stream:{playlist:'https://media.example/master.m3u8'}});
};
try{
 let r=await createSource24Adapter(cfg).resolve(q);
 assert.equal(r.candidates.length,1);
 assert.equal(calls.length,1);assert.match(calls[0].pathname,/\/tv\/[^/]+\/2\/3$/);
 assert.equal(r.candidates[0].headers.Referer,'https://vidlink.pro/');
 calls.length=0;mode='remote';
 r=await createSource24Adapter(cfg).resolve(q);
 assert.equal(r.candidates.length,1);
 assert.equal(calls.length,3);assert.equal(calls[1].hostname,'enc-dec.app');assert.match(calls[2].pathname,/\/tv\/remote-token\/2\/3$/);
 calls.length=0;mode='unsafe';
 r=await createSource24Adapter(cfg).resolve(q);
 assert.equal(r.candidates.length,1);assert.equal(calls.length,3);assert.equal(calls[1].hostname,'enc-dec.app');
 for(const failure of ['throttle','outage']) {
  calls.length=0;mode=failure;
  r=await createSource24Adapter(cfg).resolve(q);
  assert.equal(r.candidates.length,0);assert.equal(calls.length,1);
 }
}finally{globalThis.fetch=original;}
console.log('vidlink-local-token: ok');
