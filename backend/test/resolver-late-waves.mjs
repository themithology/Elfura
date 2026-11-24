// Real media HTTP -> remote resolver client -> real resolver HTTP and registry.
// One resolver node: there is no pool to balance across any more.
// Providers are deterministic fixtures, not evidence of live provider health.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SourceRegistry} from '../../dist/backend/sources/registry.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createResolverServer} from '../../dist/backend/resolver-server.js';
import {createBackendServer} from '../../dist/backend/index.js';

const secret='test-late-waves-secret-0123456789';
const tmp=mkdtempSync(path.join(os.tmpdir(),'elfura-waves-'));
const oldFetch=globalThis.fetch;
const keepAlive=setInterval(()=>{},1000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const servers=[];
async function listen(server){servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
const counts=Array.from({length:1},()=>({}));
const fixture=(node,id,ms=0)=>({
  id,label:`Source ${id.slice(7)}`,enabled:()=>true,
  async resolve(){counts[node][id]=(counts[node][id]??0)+1;await sleep(ms);return {candidates:[{key:id,url:`https://cdn.example.org/${id}.mp4`,type:'mp4',quality:'auto',rank:0}]};},
});
globalThis.fetch=async (url,init)=>String(url).startsWith('https://cdn.example.org/')
  ? new Response(new Uint8Array(2048),{status:206,headers:{'content-type':'video/mp4'}})
  : oldFetch(url,init);
process.env.ROXY_DATA_DIR=tmp;
process.env.ELFURA_SECRET=secret;
process.env.ELFURA_RESOLVER_TOKEN=secret;
process.env.ELFURA_SELF_TEST='0';
process.env.REQUIRE_PLAYBACK_TOKEN='0';
process.env.ALLOWED_ORIGINS='*';
process.env.ELFURA_RESOLVER_ALLOW_LOCAL='0';
try {
  const cfg=loadBackendConfig({ELFURA_SECRET:secret,TMDB_API_KEY:'',OPENSUBTITLES_ENABLED:'0'});
  const nodes=[];
  for(let i=0;i<1;i++){
    const registry=new SourceRegistry(cfg);
    registry.adapters=[fixture(i,'source-1'),fixture(i,'source-3'),fixture(i,'source-4'),fixture(i,'source-29',4500)];
    nodes.push(await listen(createResolverServer({cfg,registry,token:secret,log:()=>{}}).server));
  }
  process.env.ELFURA_RESOLVER_URL=nodes[0];
  const media=createBackendServer({...cfg,requireToken:false});
  const base=await listen(media.server);
  async function get(q){const res=await oldFetch(`${base}/api/v1/playback?type=movie&tmdb=12345&nonce=viewer-a${q}`,{headers:{origin:base,'user-agent':'Mozilla/5.0'}});assert.equal(res.status,200,await res.clone().text());return res.json();}
  const first=await get('');
  assert(first.sources.some(s=>s.sourceId==='source-1'));
  assert(!first.sources.some(s=>s.sourceId==='source-29'),'slow fixture should miss the first response');
  assert(first.pendingSources.includes('source-29'));
  // The real player's per-source recovery overlaps the original slow adapter.
  // It must attach to the original in-flight promise, not trigger another node.
  const recovered=await get('&source=source-29');
  assert(recovered.sources.some(s=>s.sourceId==='source-29'));
  assert.deepEqual(counts.map(c=>c['source-29']??0),[1]);
  const late=await get('&late=1');
  assert(late.sources.some(s=>s.sourceId==='source-29'),'late wave must retrieve the finished source from its owner');
  assert.deepEqual(counts.map(c=>c['source-29']??0),[1]);
  console.log('real media/resolver HTTP + fixture registry: first wave, in-flight recovery and late wave OK');

  if(process.env.ELFURA_TEST_BROWSER==='1') {
    const {chromium}=await import('playwright-core');
    const chromiumBinary=(await import('@sparticuz/chromium')).default;
    const ffmpeg=(await import('@ffmpeg-installer/ffmpeg')).default;
    const {execFileSync}=await import('node:child_process');
    const {readFileSync}=await import('node:fs');
    const video=path.join(tmp,'fixture.mp4');
    execFileSync(ffmpeg.path,['-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=5','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','15','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',video]);
    const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
    try {
      const page=await browser.newPage();const playbackRequests=[];
      page.on('request',req=>{if(req.url().includes('/api/v1/playback?')) playbackRequests.push(req.url());});
      await page.route('**/api/proxy?**',route=>route.fulfill({status:200,contentType:'video/mp4',body:readFileSync(video)}));
      await page.goto(`${base}/embed/movie/12346?autoplay=1&muted=1`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>window.__elfura?.player?.getSources().some(s=>s.sourceId==='source-1'),null,{timeout:12000});
      const initial=await page.evaluate(()=>window.__elfura.player.getSources().map(s=>s.sourceId));
      assert(!initial.includes('source-29'),'slow fixture should not be in browser first wave');
      await page.waitForFunction(()=>window.__elfura?.player?.getSources().some(s=>s.sourceId==='source-29'),null,{timeout:16000});
      assert(playbackRequests.some(url=>new URL(url).searchParams.get('late')==='1'),'player must request the late wave');
      assert(!playbackRequests.some(url=>new URL(url).searchParams.has('source')),'modern wave polling must not launch a per-source recovery storm');
      assert.deepEqual(counts.map(c=>c['source-29']??0),[2],'browser late wave must reuse its discovery owner');
      console.log('browser: real player adds the late fixture source through the resolver');
    } finally {await browser.close();}
  }
} finally {
  for(const server of servers.reverse()){server.closeAllConnections();await new Promise(r=>server.close(r));}
  globalThis.fetch=oldFetch;clearInterval(keepAlive);rmSync(tmp,{recursive:true,force:true});
}
