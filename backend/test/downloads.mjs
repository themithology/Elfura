import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {labelLanguages,normalizeDownloadResponse,issueDownloadTicket,openDownloadTicket,resolveDownloads} from '../../dist/backend/downloads.js';
const wrap=url=>'https://tgdl.lovable.app/dl?u='+Buffer.from(url).toString('base64url');
const query={type:'movie',tmdb:'550'};
const input={success:true,type:'movie',tmdb_id:550,downloads:[
 {name:'Fight Club Hindi + English.mkv',quality:'720p',size:'1 GB',download_url:wrap('https://pixeldrain.dev/api/file/123?download')},
 {name:'Playlist',quality:'1080p',download_url:wrap('https://hdhub.thevolecitor.qzz.io/resolve/a.m3u8')},
 {name:'unsafe',download_url:wrap('http://127.0.0.1/secret')},
 {name:'open redirect',download_url:'https://example.com/dl?u=abc'},
 {name:'subs',quality:'720p',download_url:wrap('https://pixeldrain.dev/api/file/456?download')},
]};
const items=normalizeDownloadResponse(input,query);assert.equal(items.length,2);assert.deepEqual(items[0].languages,['Hindi','English']);assert.deepEqual(items[1].languages,['Unknown']);
assert.deepEqual(labelLanguages('movie Hindi English subtitles.mkv'),['Hindi']);
assert.equal(normalizeDownloadResponse({...input,tmdb_id:551},query).length,0);
assert.equal(normalizeDownloadResponse({...input,type:'tv',season:2,episode:1},{type:'tv',tmdb:'550',season:1,episode:1}).length,0);
const secret=crypto.randomBytes(32);const ticket=issueDownloadTicket(secret,items[0]);assert(!ticket.includes('pixeldrain'));assert.equal(openDownloadTicket(secret,ticket)?.name,items[0].name);assert.equal(openDownloadTicket(crypto.randomBytes(32),ticket),null);assert.equal(openDownloadTicket(secret,ticket.slice(0,-3)+'xxx'),null);
const original=globalThis.fetch;let calls=0;globalThis.fetch=async url=>{calls++;if(String(url).includes('/v2/'))throw Error('unreachable');return {ok:true,json:async()=>({...input,tmdb_id:123})};};
try{const r=await resolveDownloads({type:'movie',tmdb:'123'});assert.equal(r.length,2);assert.equal(calls,2);}finally{globalThis.fetch=original;}
console.log('✓ Download identity, language hints, HLS/unsafe filtering, tickets, and fallback.');
