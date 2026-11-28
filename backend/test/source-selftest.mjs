import assert from 'node:assert/strict';
import http from 'node:http';
import { loadBackendConfig } from '../../dist/backend/config.js';
import { SourceRegistry } from '../../dist/backend/sources/registry.js';
import { runSourceSelfTest } from '../../dist/backend/sources/self-test.js';
import { RemotePlaybackResolver } from '../../dist/backend/playback-resolver-remote.js';

const requests = [];
const server = http.createServer((req,res) => {
  requests.push(req.url);
  if (req.url.startsWith('/resolver/')) return; // force a client-side timeout
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(req.url.includes('/episode/')
    ? {name:'Enter: Naruto Uzumaki!'}
    : {name:'Naruto',original_language:'ja',genres:[{name:'Animation'}],images:{logos:[]}}));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const registry = new SourceRegistry(loadBackendConfig({TMDB_API_BASE:base, ELFURA_SECRET:'test'}));
  const seen = [];
  // These synthetic lanes exercise the generic episode-trait skip and shared metadata lookup.
  registry.adapters = ['fixture-anime-a','fixture-anime-b','fixture-anime-c'].map(id => ({
    id, label:`Fixture ${id}`, traits:['animeEpisode'], enabled:()=>true,
    resolve:async query=>{
      seen.push([id,query.type]);
      const meta=await query.resolveMetaFallback();
      assert.equal(meta.originalLanguage,'ja');
      assert.deepEqual(meta.genres,['Animation']);
      assert.equal(meta.episodeName,'Enter: Naruto Uzumaki!');
      return {candidates:[{}]};
    },
  }));
  const movies=await registry.selfTestAll({type:'movie',tmdbId:'550'});
  assert.equal(seen.length,0);
  assert.ok(movies.every(r=>r.skipped==='TV anime only'));
  assert.equal(requests.length,0);
  const tv=await registry.selfTestAll({type:'tv',tmdbId:'46260',season:1,episode:1});
  assert.equal(seen.length,3);
  assert.ok(tv.every(r=>r.raw===1&&!r.skipped));
  assert.equal(requests.length,2,'shared metadata should issue one main and one episode request');

  const logs=[]; const original=console.log; console.log=(...a)=>logs.push(a.join(' '));
  try { await runSourceSelfTest({selfTestAll:async()=>movies}); } finally {console.log=original;}
  assert.ok(logs.some(s=>s.includes('skipped: TV anime only')));
  assert.ok(logs.some(s=>s.includes('not playback verification')));
  assert.ok(!logs.some(s=>s.includes('fixture-anime-b')&&s.includes('raw=0')));
  const remote=new RemotePlaybackResolver(base,'token',()=>{});
  await assert.rejects(remote.resolve({type:'movie',tmdbId:'1'},40), /timed out after 40ms before a complete response/);
  console.log('source self-test and resolver timeout diagnostics passed');
} finally {
  server.closeAllConnections();
  await new Promise(r=>server.close(r));
}
