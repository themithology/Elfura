// Synthetic audio fixtures test the real browser UI and source switching. They
// do not claim to verify the spoken language in a provider's stream.
import assert from 'node:assert/strict';
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const tmp=mkdtempSync(path.join(tmpdir(),'elfura-audio-'));
for (const [name,hz] of [['en',440],['hi',880]]) {
 execFileSync(ffmpeg.path,['-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=5','-f','lavfi','-i',`sine=frequency=${hz}:sample_rate=44100`,'-t','12','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-f','mpegts',path.join(tmp,`${name}.ts`)]);
}
const cfg=loadBackendConfig();
const {server}=createBackendServer({...cfg,isProd:false,requireToken:false});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const unknown={id:'source-26:1',sourceId:'source-26',label:'Source 26 · 720P',type:'hls',url:'/fixture/en.m3u8',quality:'720p',fingerprint:'eng',audioTracks:[],subtitles:[]};
const english={...unknown,label:'Source 26 · English',audioLang:'en',availableAudioLangs:['en']};
const hindi={...unknown,id:'source-26:2',label:'Source 26 · Hindi',url:'/fixture/hi.m3u8',quality:'auto',fingerprint:'hin',audioLang:'hi',availableAudioLangs:['hi']};
let browser,page,requests=[],step='open';
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 page=await browser.newPage();
 await page.route('**/api/v1/playback**',async route=>{const group=new URL(route.request().url()).searchParams.get('source');const sources=group==='source-26'?[english,hindi]:[unknown];return route.fulfill({json:{ok:true,primary:sources[0],sources,sourceGroups:['source-26'],pendingSources:[],media:{type:'movie',tmdbId:'550'}}});});
 await page.route('**/fixture/**',route=>{const file=path.basename(new URL(route.request().url()).pathname);requests.push(file);const name=file.startsWith('hi')?'hi':'en';return route.fulfill(file.endsWith('.m3u8')?{status:200,contentType:'application/vnd.apple.mpegurl',body:`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXTINF:12,\n${name}.ts\n#EXT-X-ENDLIST\n`}:{status:200,contentType:'video/mp2t',body:readFileSync(path.join(tmp,`${name}.ts`))});});
 await page.goto(`${base}/embed/movie/550?autoplay=1&muted=1`,{waitUntil:'domcontentloaded'});
 step='late labels';
 await page.waitForFunction(()=>{const p=window.__elfura?.player;return p?.getSources().some(s=>s.fingerprint==='eng'&&s.audioLang==='en')&&p?.getAudioTracks().some(t=>t.lang==='hi')&&p?.getAudioTracks().some(t=>t.lang==='en');},null,{timeout:25000});
 step='menu';
 await page.getByRole('button',{name:'Change audio and subtitles'}).evaluate(button=>button.click());
 await page.locator('.elf-audio-option').filter({hasText:'Hindi'}).click();
 step='switch';
 await page.waitForFunction(()=>window.__elfura.player.currentSource?.audioLang==='hi'&&window.__elfura.player.video.readyState>=2,null,{timeout:25000});
 assert(requests.includes('hi.ts'),'Hindi fixture media must be fetched');
 const state=await page.evaluate(()=>({audio:window.__elfura.player.getState().audioLang,source:window.__elfura.player.currentSource?.audioLang,tracks:window.__elfura.player.getAudioTracks().map(t=>t.lang)}));
 assert.equal(state.source,'hi');
 console.log('::notice title=MovieBoxAudioBrowser::'+JSON.stringify({ok:true,state,requestedHindi:true}));
} catch(e) {
 const state=await page?.evaluate(()=>({source:window.__elfura?.player?.currentSource?.audioLang,sources:window.__elfura?.player?.getSources().map(s=>({label:s.label,lang:s.audioLang})),tracks:window.__elfura?.player?.getAudioTracks().map(t=>({lang:t.lang,kind:t.kind})),ready:window.__elfura?.player?.video?.readyState})).catch(()=>null);
 console.log('::error title=MovieBoxAudioBrowser::'+JSON.stringify({ok:false,step,error:String(e).slice(0,300),state,requests}));process.exitCode=1;
} finally {await browser?.close();await new Promise(r=>server.close(r));rmSync(tmp,{recursive:true,force:true});}
