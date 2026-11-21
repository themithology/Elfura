// Synthetic audio verifies the real menu and source switching, not spoken language.
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
const tmp=mkdtempSync(path.join(tmpdir(),'elfura-anime-audio-'));
for (const [name,hz] of [['ja',440],['en',880]]) execFileSync(ffmpeg.path,['-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=5','-f','lavfi','-i',`sine=frequency=${hz}:sample_rate=44100`,'-t','12','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-f','mpegts',path.join(tmp,`${name}.ts`)]);
const {server}=createBackendServer({...loadBackendConfig(),isProd:false,requireToken:false});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const sub={id:'source-30:1',sourceId:'source-30',label:'Source 30 · Sub',type:'hls',url:'/fixture/ja.m3u8',quality:'auto',fingerprint:'sub30',audioVariant:'sub',audioTracks:[],subtitles:[{lang:'en',label:'English',url:'/fixture/sub.vtt'}]};
const dub={...sub,id:'source-30:2',label:'Source 30 · Dub',url:'/fixture/en.m3u8',fingerprint:'dub30',audioVariant:'dub'};
const duplicate={...sub,id:'source-29:1',sourceId:'source-29',fingerprint:'sub29'};
let browser,page,step='start';const requests=[];
try {
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});page=await browser.newPage();
 await page.route('**/api/v1/playback**',route=>route.fulfill({json:{ok:true,primary:sub,sources:[sub,dub,duplicate],sourceGroups:[],pendingSources:[],media:{type:'tv',tmdbId:'46260',season:1,episode:1}}}));
 await page.route('**/fixture/**',route=>{const file=path.basename(new URL(route.request().url()).pathname);requests.push(file);if(file.endsWith('.vtt'))return route.fulfill({status:200,contentType:'text/vtt',body:'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nSample subtitle\n'});const name=file.startsWith('ja')?'ja':'en';return route.fulfill(file.endsWith('.m3u8')?{status:200,contentType:'application/vnd.apple.mpegurl',body:`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXTINF:12,\n${name}.ts\n#EXT-X-ENDLIST\n`}:{status:200,contentType:'video/mp2t',body:readFileSync(path.join(tmp,`${name}.ts`))});});
 await page.goto(`${base}/embed/tv/46260/1/1?autoplay=1&muted=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__elfura?.player?.video?.readyState>=2,null,{timeout:20000});
 step='menu';await page.getByRole('button',{name:'Change audio and subtitles'}).evaluate(button=>button.click());
 const labels=await page.locator('.elf-audio-option').allTextContents();
 assert.equal(labels.filter(s=>s.includes('Japanese')).length,1,'Japanese should appear only once');
 assert.equal(labels.filter(s=>s.includes('English')).length,1,'English should appear only once');
 assert(!labels.some(s=>/SUB|DUB/i.test(s)),'no separate sub/dub source rows');
 assert.equal(await page.locator('.elf-col-heading').filter({hasText:'Anime source version'}).count(),0);
 step='switch to English';await page.locator('.elf-audio-option').filter({hasText:'English'}).click();
 await page.waitForFunction(()=>{const p=window.__elfura.player;return p.currentSource?.audioVariant==='dub'&&p.video.readyState>=2&&p.getState().audioLang==='en'},null,{timeout:20000});
 assert(requests.includes('en.ts'),'dub media must be loaded');
 step='switch to Japanese';await page.locator('.elf-audio-option').filter({hasText:'Japanese'}).click();
 await page.waitForFunction(()=>{const p=window.__elfura.player;return p.currentSource?.audioVariant==='sub'&&p.video.readyState>=2&&p.getState().audioLang==='ja'},null,{timeout:20000});
 assert(requests.includes('ja.ts'),'sub media must be loaded');
 const state=await page.evaluate(()=>{const p=window.__elfura.player;const mismatch=p.applyHlsProbeAudioSelection({opt:p.getSources().find(s=>s.audioVariant==='sub'),targetLang:'ja'},[{id:0,lang:'en',name:'English'}],{audioTrack:-1});return {mismatch,sources:p.getSources().map(s=>({id:s.id,lang:s.audioLang})),tracks:p.getAudioTracks().map(t=>({lang:t.lang,providerHint:t.providerHint})),subtitleCount:p.getSubtitleTracks().length}});
 assert.equal(state.mismatch,false,'tagged contradictory manifest must override the provider hint');
 assert(state.sources.every(s=>!s.lang),'provider hints must not become verified source audio');
 assert(state.tracks.some(t=>t.lang==='ja'&&t.providerHint));assert(state.tracks.some(t=>t.lang==='en'&&t.providerHint));
 assert(state.subtitleCount>0,'subtitle choices remain available');
 console.log('::notice title=Anime language menu::'+JSON.stringify({ok:true,state,labels}));
}catch(e){const state=await page?.evaluate(()=>({source:window.__elfura?.player?.currentSource?.id,tracks:window.__elfura?.player?.getAudioTracks(),audio:window.__elfura?.player?.getState().audioLang,ready:window.__elfura?.player?.video?.readyState})).catch(()=>null);console.log('::error title=Anime language menu::'+JSON.stringify({step,error:String(e).slice(0,240),state,requests}));process.exitCode=1;}
finally{await browser?.close();await new Promise(r=>server.close(r));rmSync(tmp,{recursive:true,force:true});}
