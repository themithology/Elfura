import assert from 'node:assert/strict';
import { extractMp4SingleAudioLanguage } from '../../dist/backend/sources/mp4-audio.js';
import { verifyAndFilterCandidates } from '../../dist/backend/sources/liveness.js';
const box=(type,...payload)=>{const data=Buffer.concat(payload), h=Buffer.alloc(8);h.writeUInt32BE(data.length+8);h.write(type,4);return Buffer.concat([h,data]);};
const audio=(lang,version=0)=>{const h=Buffer.alloc(12);h.write('soun',8);const md=Buffer.alloc(version?36:24);md[0]=version;const n=[...lang].reduce((v,c)=>(v<<5)|(c.charCodeAt(0)-96),0);md.writeUInt16BE(n,version?32:20);return box('trak',box('mdia',box('mdhd',md),box('hdlr',h)));};
const ftyp=box('ftyp',Buffer.from('isom0000'));
const eng=box('moov',audio('eng')), hin=box('moov',audio('hin',1));
assert.equal(extractMp4SingleAudioLanguage(Buffer.concat([ftyp,eng,Buffer.from([0,0,1,0,109,100,97,116])])),'eng');
assert.equal(extractMp4SingleAudioLanguage(Buffer.concat([Buffer.alloc(31),hin]),true),'hin');
assert.equal(extractMp4SingleAudioLanguage(box('moov',audio('eng'),audio('hin'))),null);
assert.equal(extractMp4SingleAudioLanguage(box('moov',audio('und'))),null);
assert.equal(extractMp4SingleAudioLanguage(eng.subarray(0,eng.length-2)),null);
assert.equal(extractMp4SingleAudioLanguage(Buffer.concat([Buffer.alloc(31),hin,Buffer.alloc(1)]),true),null);
const original=globalThis.fetch;let ranges=[];
const size=1024*1024;
globalThis.fetch=async (_url, opts)=>{const range=opts.headers.Range;ranges.push(range);if(range==='bytes=0-524287')return new Response(Buffer.concat([ftyp,Buffer.from([0,16,0,0,109,100,97,116])]),{status:206,headers:{'content-range':`bytes 0-524287/${size}`,'content-type':'video/mp4'}});return new Response(Buffer.concat([Buffer.alloc(100),eng]),{status:206,headers:{'content-range':`bytes 524288-1048575/${size}`,'content-type':'video/mp4'}});};
try {
 const [result]=await verifyAndFilterCandidates([{key:'mp4',url:'https://cdn.example.org/one.mp4',type:'mp4',quality:'720p',rank:0,probeMp4Audio:true}],AbortSignal.timeout(4000));
 assert.equal(result.audioLang,'en');assert.equal(result.audioLabel,'English');assert.deepEqual(ranges,['bytes=0-524287','bytes=524288-1048575']);
} finally {globalThis.fetch=original;}
console.log('MovieBox MP4: bounded head/tail, genuine language and ambiguous tracks OK');
