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
// A large video sample table before the audio trak must be skipped with a
// small range request, not downloaded in full.
const video=box('trak',box('mdia',box('hdlr',Buffer.alloc(12)),box('minf',box('stbl',box('free',Buffer.alloc(700000))))));
const large=Buffer.concat([ftyp,box('moov',video,audio('eng')),box('mdat',Buffer.alloc(100))]);
const original=globalThis.fetch;let ranges=[];
globalThis.fetch=async (_url, opts)=>{const range=opts.headers.Range;ranges.push(range);const match=range.match(/^bytes=(\d+)-(\d+)$/);const start=Number(match[1]),end=Math.min(Number(match[2]),large.length-1);return new Response(large.subarray(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${large.length}`,'content-type':'video/mp4'}});};
try {
 const [result]=await verifyAndFilterCandidates([{key:'mp4',url:'https://cdn.example.org/one.mp4',type:'mp4',quality:'720p',rank:0,probeMp4Audio:true}],AbortSignal.timeout(4000));
 assert.equal(result.audioLang,'en');assert.equal(result.audioLabel,'English');assert(ranges.length>=2 && ranges.length<=9);assert.equal(ranges[0],'bytes=0-65535');
} finally {globalThis.fetch=original;}
console.log('MovieBox MP4: bounded head/tail, genuine language and ambiguous tracks OK');
