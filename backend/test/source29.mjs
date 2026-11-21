import assert from 'node:assert/strict';
import {resolveDirectAnimeEpisode} from '../../dist/backend/sources/anime-direct-mapping.js';
import {createSource29Adapter,novusSourceReference} from '../../dist/backend/sources/source29.js';

const metadata={originalLanguage:'ja',genres:['Animation'],episodeName:'Enter: Naruto Uzumaki!'};
const query={type:'tv',tmdbId:'46260',season:1,episode:1,resolveMetaFallback:async()=>metadata};
const mapped=async()=>Response.json({mappings:{anilist_id:20},episodes:{'1':{title:{en:'Enter: Naruto Uzumaki!'}}}});
assert.deepEqual(await resolveDirectAnimeEpisode(query,mapped),{anilistId:'20',episode:1});
assert.equal(await resolveDirectAnimeEpisode({...query,season:2},mapped),null);
assert.equal(await resolveDirectAnimeEpisode({...query,episode:9999},mapped),null);
assert.equal(await resolveDirectAnimeEpisode({...query,resolveMetaFallback:async()=>({...metadata,episodeName:'Episode 1'})},mapped),null);
assert.equal(await resolveDirectAnimeEpisode({...query,resolveMetaFallback:async()=>({...metadata,originalLanguage:'en'})},mapped),null);
assert.equal(await resolveDirectAnimeEpisode(query,async()=>Response.json({mappings:{anilist_id:20},episodes:{'1':{title:{en:'Different episode'}}}})),null);
assert.equal(novusSourceReference(`var sourcesUrl = '/stream/getSources?t=abc';`),'https://novuscloud.buzz/stream/getSources?t=abc');
for(const ref of ['https://127.0.0.1/stream/getSources?t=abc','https://evil.test/stream/getSources?t=abc','/stream/getSources?t=a&t=b','/stream/getSources?t=a&extra=b','/other?t=abc']) {
  assert.equal(novusSourceReference(`var sourcesUrl = '${ref}';`),null);
}
const calls=[];
const fakeFetch=async(input,init)=>{
 const u=new URL(input);calls.push(u.pathname);assert.equal(init.redirect,'error');
 if(u.pathname.startsWith('/embed/')) {
   const mode=u.pathname.split('/').at(-1);
   return new Response(`var sourcesUrl = '/stream/getSources?t=${mode}';`,{status:200});
 }
 if(u.pathname==='/stream/getSources'){
   const mode=u.searchParams.get('t');
   if(mode==='hsub')return new Response('',{status:404});
   return Response.json({sources:[{file:`https://novuscloud.buzz/proxy/${mode}?t=opaque`}],tracks:[
    {file:'https://novuscloud.buzz/caption.ass',kind:'captions',label:'English'},
    {file:'https://novuscloud.buzz/thumb.vtt',kind:'thumbnails',label:'English'},
    {file:'https://evil.example/caption.vtt',kind:'captions',label:'English'},
   ]});
 }
 throw Error('unexpected');
};
const adapter=createSource29Adapter(()=>true,{fetchImpl:fakeFetch,mapEpisode:async()=>({anilistId:'20',episode:1})});
const result=await adapter.resolve(query);
assert.equal(result.candidates.length,2);
assert.deepEqual(result.candidates.map(c=>c.audioVariant),['sub','dub']);
assert.deepEqual(result.candidates.map(c=>c.claimedAudioLang),['ja','en']);
assert.ok(result.candidates.every(c=>!c.audioLang&&c.subtitles.length===1&&c.subtitles[0].format==='ass'));
assert.equal(calls.length,6);
const hardFetch=async(input,init)=>{
 const u=new URL(input);
 if(u.pathname.startsWith('/embed/'))return new Response(`var sourcesUrl = '/stream/getSources?t=${u.pathname.split('/').at(-1)}';`);
 return Response.json({sources:[{file:`https://novuscloud.buzz/proxy/${u.searchParams.get('t')}`}],tracks:[]});
};
const hard=await createSource29Adapter(()=>true,{fetchImpl:hardFetch,mapEpisode:async()=>({anilistId:'20',episode:1})}).resolve(query);
assert.equal(hard.candidates.length,3);assert.equal(hard.candidates[0].audioLabel,'Hard Sub');assert.ok(hard.candidates[0].url.endsWith('/hsub'));assert.ok(hard.candidates[1].url.endsWith('/sub'));
const disabled=await createSource29Adapter(()=>false,{fetchImpl:fakeFetch,mapEpisode:async()=>{throw Error('should not map')}}).resolve(query);
assert.deepEqual(disabled.candidates,[]);
console.log('source29 fixture tests passed');
