import assert from 'node:assert/strict';
import { createSource26Adapter } from '../../dist/backend/sources/source26.js';
import { verifyAndFilterCandidates } from '../../dist/backend/sources/liveness.js';
import { selectPlaybackCandidates } from '../../dist/backend/sources/selection.js';
const original = globalThis.fetch;
const requests = [];
const cookie = name => `Edge-Cache-Cookie=urlprefix=${Buffer.from(`https://cdn.example.com/dash/${name}/`).toString('base64url')}:sign=abc:t=1`;
const mpd = (lang, heights) => `<MPD><Period><AdaptationSet contentType="video">${heights.map(height=>`<Representation height="${height}" />`).join('')}</AdaptationSet><AdaptationSet contentType="audio" lang="${lang}"><Representation /></AdaptationSet></Period></MPD>`;
globalThis.fetch = async (url, options = {}) => {
 const u = new URL(String(url)); requests.push(u);
 if (u.pathname.endsWith('/visitor-login')) return Response.json({data:{token:'mock'}});
 if (u.pathname.endsWith('/search/v2')) return Response.json({data:{results:[{subjects:[{subjectId:'123',title:'Example',subjectType:1,releaseDate:'2020-01-01'}]}]}});
 if (u.pathname.endsWith('/subject-api/get')) return Response.json({data:{subject:{
   dubs:[{subjectId:'123',original:true,lanCode:'en'}, {subjectId:'456',original:false,lanCode:'hi'}, {subjectId:'789',original:false,lanCode:'esla'}, {subjectId:'bad',original:false,lanCode:'ja'}],
   resourceDetectors:[{resolutionList:[{se:0,ep:0,resolution:720,resourceLink:'https://cdn.example.com/720.mp4'}, {se:0,ep:0,resolution:1080,resourceLink:'https://macdn.aoneroom.com/other/notice.mp4'}, {se:1,ep:1,resolution:1080,resourceLink:'https://cdn.example.com/wrong.mp4'}, {se:0,ep:0,resolution:1080,resourceLink:'https://cdn.example.com/wrong.mkv'}]}],
 }}});
 if (u.pathname.endsWith('/resource/v2')) return Response.json({data:{list:[]}});
 if (u.pathname.endsWith('/play-info/v2')) {
  if (u.searchParams.get('subjectId') === '123') return Response.json({data:{streams:[{url:'https://macdn.aoneroom.com/other/notice.mp4',signCookie:cookie('original')}],displayResolutions:'480,720,1080'}});
  if (u.searchParams.get('subjectId') === '456') return Response.json({data:{streams:[{url:'https://macdn.aoneroom.com/other/notice.mp4',signCookie:cookie('hindi')}]}});
  if (u.searchParams.get('subjectId') === '789') return Response.json({data:{streams:[{url:'https://cdn.example.com/spanish.mp4'}]}});
  throw Error('Unexpected subject');
 }
 if (u.pathname.includes('/dash/original/')) return new Response(mpd('eng',[480]),{headers:{'content-type':'application/dash+xml'}});
 if (u.pathname.includes('/dash/hindi/')) return new Response(mpd('hin',[1080,720,480]),{headers:{'content-type':'application/dash+xml'}});
 if (u.pathname.endsWith('.mp4')) return new Response(new Uint8Array([0,0,0,16,102,116,121,112]),{status:206,headers:{'content-type':'video/mp4'}});
 throw Error('Unexpected request');
};
try {
 const adapter=createSource26Adapter(()=>true);
 const raw=await adapter.resolve({type:'movie',tmdbId:'1',title:'Example',year:'2020'});
 assert.equal(raw.candidates.length,4);
 assert.equal(raw.candidates.filter(c=>c.claimedAudioLang==='hi').length,1);
 assert.equal(raw.candidates.find(c=>c.claimedAudioLang==='hi').audioLang,undefined, 'provider label alone is not verified audio');
 assert(raw.candidates.some(c=>c.quality==='720p'&&c.url.endsWith('/720.mp4')));
 assert(!raw.candidates.some(c=>c.url.endsWith('.mkv') || c.url.includes('wrong') || c.url.includes('notice.mp4')));
 const verified=await verifyAndFilterCandidates(raw.candidates,AbortSignal.timeout(4000));
 const hindi=verified.find(c=>c.audioLang==='hi');
 assert(hindi, 'manifest language is promoted for source switching');
 assert.deepEqual(hindi.qualityLadder,[1080,720,480]);
 assert.equal(hindi.multiAudio,false, 'separate dubs are not fake multi-track manifests');
 const spanish=verified.find(c=>c.claimedAudioLang==='es-419');
 assert(spanish); assert.equal(spanish.audioLang,undefined,'unverified MP4 language must not be invented');
 const selection=selectPlaybackCandidates(verified.map(candidate=>({adapter,candidate})));
 assert(selection.some(row=>row.candidate.audioLang==='hi'), 'verified Hindi remains selectable');
 assert(requests.some(u=>u.pathname.endsWith('play-info/v2') && u.searchParams.get('subjectId')==='456'));
 console.log('MovieBox dubs: linked subjects, verified language, MP4 claims and quality ladder OK');
} finally {globalThis.fetch=original;}
