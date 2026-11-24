// Live check of the exact episode requested by the user. Do not log raw URLs,
// source payloads, stream tickets, cookies or provider credentials.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
import {installEgressProfile} from '../../dist/backend/egress.js';
import {lookup} from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

const origin='https://greyboxtv.duckdns.org';
const endpoint=`${origin}/api/player/sources?media=tv&id=71446&season=1&episode=1`;
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const row={api:{},network:{},adapter:{},liveness:{},registry:{},browser:{tested:0,played:false}};
const cfg=loadBackendConfig({ELFURA_SECRET:'test-only-greybox-secret',TMDB_API_KEY:'',OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:false});
const source=registry.adapters.find(a=>a.id==='source-25');
let raw=[];let browser;
try {
  let start=Date.now();
  try {
    const response=await fetch(endpoint,{headers:{'User-Agent':ua,Accept:'application/json, text/plain, */*',Referer:`${origin}/`,Origin:origin},signal:AbortSignal.timeout(15000)});
    row.api.status=response.status;row.api.ms=Date.now()-start;
    const json=await response.json().catch(()=>null);
    const sources=Array.isArray(json?.sources)?json.sources:[];
    row.api.rows=sources.length;
    row.api.relative=sources.filter(x=>typeof x.url==='string'&&x.url.startsWith('/')).length;
    row.api.absolute=sources.filter(x=>typeof x.url==='string'&&/^https?:\/\//i.test(x.url)).length;
  } catch(e) {row.api.ms=Date.now()-start;row.api.error=e.cause?.code||e.name;}

  // Distinguish network/TLS failure from a rejected API request, without
  // printing IP addresses, provider payloads or signed URLs.
  if (row.api.error) {
    row.network.dnsFamilies = await lookup('greyboxtv.duckdns.org',{all:true}).then(xs=>[...new Set(xs.map(x=>x.family))]).catch(e=>e.code||e.name);
    const connect = (secure) => new Promise(resolve => {
      const socket = secure ? tls.connect({host:'greyboxtv.duckdns.org',port:443,servername:'greyboxtv.duckdns.org'}) : net.connect({host:'greyboxtv.duckdns.org',port:443});
      socket.setTimeout(5000);
      const finish = value => { socket.destroy(); resolve(value); };
      socket.once(secure?'secureConnect':'connect',()=>finish('connected'));
      socket.once('error',e=>finish(e.code||e.name));
      socket.once('timeout',()=>finish('timeout'));
    });
    [row.network.tcp443,row.network.tls443] = await Promise.all([connect(false),connect(true)]);
    // A raw handshake and a browser-shaped TLS request are different checks.
    // Record only status/count, never the response or signed media URLs.
    try {
      const {fetch: browserFetch} = await import('wreq-js');
      const response = await browserFetch(endpoint,{browser:'chrome_149',os:'windows',headers:{'User-Agent':ua,Accept:'application/json, text/plain, */*',Referer:`${origin}/`,Origin:origin},timeout:15000,signal:AbortSignal.timeout(16000)});
      row.network.browserTlsStatus = response.status;
      row.network.browserTlsContentType = (response.headers.get('content-type') || '').split(';')[0];
      const text = await response.text();
      row.network.browserTlsBytes = Buffer.byteLength(text);
      let json;
      try { json = JSON.parse(text); row.network.browserTlsJson = true; }
      catch { row.network.browserTlsJson = false; row.network.browserTlsHtml = /^\s*<!?html/i.test(text); }
      row.network.browserTlsRows = Array.isArray(json?.sources) ? json.sources.length : 0;
      row.network.browserTlsFailures = Array.isArray(json?.failures) ? json.failures.length : null;
    } catch(e) {
      row.network.browserTlsError = e.cause?.code || e.name;
      row.network.browserTlsErrorClass = /decompress|decod|encoding/i.test(String(e.message)) ? 'decode' : /reset|closed|incomplete|body|stream/i.test(String(e.message)) ? 'body-or-connection' : 'other';
    }
    // Some origins mishandle compression; probe identity without logging bodies.
    const headers={'User-Agent':ua,Accept:'application/json, text/plain, */*',Referer:`${origin}/`,Origin:origin,'Accept-Encoding':'identity'};
    for (const kind of ['nodeIdentity','browserIdentity']) {
      const item = {};
      try {
        const request = kind === 'browserIdentity' ? (await import('wreq-js')).fetch : globalThis.fetch;
        const response = await request(endpoint,{headers,signal:AbortSignal.timeout(12000),...(kind === 'browserIdentity' ? {browser:'chrome_149',os:'windows',timeout:11000} : {})});
        item.status = response.status;
        const json = await response.json();
        item.rows = Array.isArray(json?.sources) ? json.sources.length : 0;
      } catch(e) {item.error = e.cause?.code || e.name;}
      row.network[kind] = item;
    }
  }
  // Real resolver startup installs the egress profile; createBackendServer alone
  // does not. Install it explicitly so this test covers the production path.
  row.network.egressProfile = await installEgressProfile(()=>{});
  if (!source) throw Error('source-25 not registered');
  const wrapped={...source,async resolve(q){
    const start=Date.now();const diag=[];
    const result=await source.resolve({...q,diag});
    row.adapter={enabled:source.enabled(),ms:Date.now()-start,candidates:result.candidates.length,diagnostic:diag.map(d=>d.detail)};
    raw=result.candidates;return result;
  }};
  registry.adapters=[wrapped];
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  start=Date.now();
  const result=await registry.resolvePlayback({type:'tv',tmdbId:'71446',season:1,episode:1,sourceId:'source-25'});
  row.registry={ms:Date.now()-start,options:result?.sources.length??0};
  if(raw.length){
    const checked=await verifyAndFilterCandidatesDetailed(raw.slice(0,20),AbortSignal.timeout(4000));
    row.liveness={tested:Math.min(raw.length,20),manifestReachable:checked.verifiedAliveCount,confirmedDead:checked.probedDead.size,unknown:checked.candidates.length-checked.verifiedAliveCount};
  }
  if(result?.sources.length){
    browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();
    for(const option of result.sources.slice(0,2)) {
      row.browser.tested++;
      await page.route('**/api/v1/playback**',route=>route.fulfill({json:{...result,primary:option,sources:[option],sourceGroups:[],pendingSources:[],waveUpdates:false}}));
      try {
        await page.goto(`${base}/embed/tv/71446/1/1?autoplay=1&muted=1`,{waitUntil:'domcontentloaded',timeout:15000});
        await page.waitForFunction(()=>{const v=window.__elfura?.player?.video;return v?.videoWidth>0&&v.currentTime>1&&v.getVideoPlaybackQuality().totalVideoFrames>0;},null,{timeout:20000});
        Object.assign(row.browser,await page.evaluate(()=>{const v=window.__elfura.player.video;return {played:true,width:v.videoWidth,height:v.videoHeight,seconds:Math.round(v.currentTime),frames:v.getVideoPlaybackQuality().totalVideoFrames};}));
      } catch(e) {row.browser.error=e.name;}
      await page.unroute('**/api/v1/playback**');
      if(row.browser.played)break;
    }
  }
} catch(e) {row.error=e.name;}
finally {
  await browser?.close().catch(()=>{});
  if(server.listening)await new Promise(r=>server.close(r));
  console.log('::notice title=Greybox Source 25 live check::'+JSON.stringify(row));
  if(!row.api.rows || !row.adapter.candidates || !row.registry.options || !row.browser.played)process.exitCode=1;
}
