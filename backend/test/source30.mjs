import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createSource30Adapter} from '../../dist/backend/sources/source30.js';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
import {selectPlaybackCandidates} from '../../dist/backend/sources/selection.js';
const registry=new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test'}));
for(const id of ['source-29','source-30'])assert(registry.listPublicSources().some(s=>s.id===id));
for(const [id,flag] of [['source-29','ELFURA_ANIME_29_ENABLED'],['source-30','ELFURA_ANIME_30_ENABLED']]) assert(!new SourceRegistry(loadBackendConfig({ELFURA_SECRET:'test',[flag]:'0'})).listPublicSources().some(s=>s.id===id));
const calls=[];const origin='https://megaplay.buzz';const key='fixture',iv='1234567890123456';
const encrypt=(value)=>{const buf=Buffer.alloc(32);Buffer.from(key).copy(buf);const cipher=crypto.createCipheriv('aes-256-cbc',buf,Buffer.from(iv));return Buffer.concat([cipher.update(JSON.stringify({file:value}),'utf8'),cipher.final()]).toString('base64url')};
const f=async(input,init)=>{const u=new URL(input);calls.push(u.href);assert.equal(init.redirect,'manual');assert.equal(u.origin,origin);
 if(u.pathname.startsWith('/stream/ani/'))return new Response(`<div data-id="file-${u.pathname.split('/').at(-1)}"></div><script src="/client.js"></script><script src="http://169.254.169.254/bad.js"></script>`);
 if(u.pathname==='/client.js')return new Response(`const route='stream/getSources'; const method='AES-CBC'; const key='${key}'; const iv='${iv}';`);
 if(u.pathname==='/stream/getSources'){const mode=u.searchParams.get('id').endsWith('dub')?'dub':'sub';return Response.json({enc:encrypt(`https://cdn.example/${mode}.m3u8`),tracks:[{kind:'captions',label:'English',file:'https://sub.example/english.vtt'},{kind:'captions',label:'English',file:'http://169.254.169.254/x.vtt'}]});}
 throw Error('unexpected');
};
const adapter=createSource30Adapter(()=>true,{fetchImpl:f,mapEpisode:async()=>({anilistId:'20',episode:1})});
const result=await adapter.resolve({type:'tv',tmdbId:'46260',season:1,episode:1});
assert.deepEqual(result.candidates.map(c=>c.audioVariant),['sub','dub']);
assert(result.candidates.every(c=>c.restrictedOrigin==='*public*' && c.subtitles.length===1 && !c.audioLang));
assert(calls.every(url=>new URL(url).origin===origin));
assert.deepEqual((await createSource30Adapter(()=>false,{mapEpisode:async()=>{throw Error('disabled')}}).resolve({type:'tv',tmdbId:'1'})).candidates,[]);
const oldFetch=globalThis.fetch;
try {
 globalThis.fetch=async()=>new Response('#EXTM3U\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST');
 const other=['sub','dub'].map(mode=>({key:'other-'+mode,url:`https://novuscloud.buzz/${mode}.m3u8`,type:'hls',quality:'auto',rank:1,restrictedOrigin:'https://novuscloud.buzz',audioVariant:mode}));
 const checked=await verifyAndFilterCandidatesDetailed([...other,...result.candidates]);
 const selected=selectPlaybackCandidates(checked.candidates.map(c=>({adapter:{id:c.key.startsWith('other-')?'source-29':'source-30',label:'Source',enabled:()=>true},candidate:c})));
 for(const id of ['source-29','source-30']) for(const mode of ['sub','dub'])assert(selected.some(x=>x.adapter.id===id&&x.candidate.audioVariant===mode),`${id} ${mode} must remain selectable`);
} finally {globalThis.fetch=oldFetch;}
console.log('source30 bounded static extractor fixtures passed');
