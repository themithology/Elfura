import assert from 'node:assert/strict';
import {createSource28Adapter,findPlayer,matchesEpisodeTitle,titleSlug} from '../../dist/backend/sources/source28.js';
assert.equal(titleSlug('Jujutsu Kaisen'),'jujutsu-kaisen');
assert.equal(titleSlug(''),null);
assert(matchesEpisodeTitle('<title>Enter: Naruto Uzumaki! - Anime Salt</title>','Enter: Naruto Uzumaki!'));
assert(!matchesEpisodeTitle('<title>My Name is Konohamaru - Anime Salt</title>','Enter: Naruto Uzumaki!'));
assert(!matchesEpisodeTitle('<title>Episode 1 - Anime Salt</title>','Episode 1'));
const iframe='<title>Enter: Naruto Uzumaki! - Anime Salt</title><iframe src="https://ravok.buzz/video/0123456789abcdef0123456789abcdef"></iframe>';
assert.equal(new URL(findPlayer(iframe)).hostname,'ravok.buzz');
assert.equal(findPlayer('<iframe src="https://ravok.buzz.evil.example/video/0123456789abcdef"></iframe>'),null);
assert.equal(findPlayer('<iframe src="http://127.0.0.1/video/0123456789abcdef"></iframe>'),null);
const orig=globalThis.fetch;let calls=0;
globalThis.fetch=async(url,init)=>{calls++;assert.equal(new URL(url).origin,'https://ravok.buzz');assert.equal(init.redirect,'error');return Response.json({videoSource:'https://media.example/master.m3u8'});};
try {
 const adapter=createSource28Adapter(()=>true,{fetchPage:async()=>iframe});
 const query={type:'tv',tmdbId:'46260',season:1,episode:1,resolveMetaFallback:async()=>({rawTitle:'Naruto',episodeName:'Enter: Naruto Uzumaki!'})};
 const ok=await adapter.resolve(query);assert.equal(ok.candidates.length,1);assert.equal(ok.candidates[0].type,'hls');assert.equal(ok.candidates[0].quality,'auto');assert.equal(ok.candidates[0].audioLang,undefined);
 const before=calls;
 for(const changed of [{season:2},{type:'movie'},{episode:0},{resolveMetaFallback:async()=>({rawTitle:'Naruto',episodeName:'Different'})},{resolveMetaFallback:async()=>({rawTitle:'Naruto'})}]) assert.deepEqual((await adapter.resolve({...query,...changed})).candidates,[]);
 assert.equal(calls,before,'unsafe mappings must not reach the player API');
 const malicious=createSource28Adapter(()=>true,{fetchPage:async()=>iframe});
 globalThis.fetch=async()=>Response.json({videoSource:'http://127.0.0.1/private'});
 assert.deepEqual((await malicious.resolve(query)).candidates,[]);
} finally {globalThis.fetch=orig;}
console.log('source 28 conservative identity, URL restrictions and manifest candidates passed');
