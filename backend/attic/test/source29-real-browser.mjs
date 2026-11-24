// Research-only injection of the actual adapter, real playback API, relay and player.
// TMDB metadata is a fixture; no upstream URLs, captions or media are logged.
import {createBackendServer} from '../../../dist/backend/index.js';
import {loadBackendConfig} from '../../../dist/backend/config.js';
import {createSource29Adapter} from '../../../dist/backend/sources/source29.js';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const samples=[{id:'46260',title:'Naruto',year:'2002',ep:1,episode:'Enter: Naruto Uzumaki!'},{id:'46260',title:'Naruto',year:'2002',ep:2,episode:'My Name is Konohamaru'},{id:'95479',title:'Jujutsu Kaisen',year:'2020',ep:1,episode:'Ryomen Sukuna'}];
const orig=globalThis.fetch;
const liveTmdb=process.env.ELFURA_TEST_LIVE_TMDB==='1';
if(!liveTmdb) globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input.url??String(input));if(u.hostname!=='tmdb-fixture.example')return orig(input,init);
 const p=u.pathname.split('/'),i=p.indexOf('tv'),e=p.indexOf('episode'),sample=samples.find(x=>x.id===p[i+1]&&(e<0||x.ep===Number(p[e+1])));if(!sample)return new Response(null,{status:404});
 if(e>=0)return Response.json({name:sample.episode,runtime:24});
 return Response.json({id:Number(sample.id),name:sample.title,original_name:sample.title,first_air_date:sample.year+'-01-01',original_language:'ja',genres:[{name:'Animation'}],episode_run_time:[24],images:{logos:[]}});
};
const cfg=loadBackendConfig({ELFURA_SECRET:'fixture-only-test-secret',...(liveTmdb?{}:{TMDB_API_BASE:'https://tmdb-fixture.example',TMDB_API_KEY:'fixture'}),OPENSUBTITLES_ENABLED:'0'});
const {server,registry}=createBackendServer({...cfg,isProd:false,requireToken:true});registry.adapters=[createSource29Adapter()];
let browser;const rows=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 for(const sample of samples){const row={title:sample.title,episode:sample.ep,lanes:[]};let step='start';try{
  await page.goto(`${base}/embed/tv/${sample.id}/1/${sample.ep}?autoplay=1&source=source-29`,{waitUntil:'domcontentloaded',timeout:15000});
  step='variants';await page.waitForFunction(()=>{const a=window.__elfura?.player?.getSources?.()??[];return a.some(s=>s.audioVariant==='sub')&&a.some(s=>s.audioVariant==='dub')},null,{timeout:35000});
  row.options=await page.evaluate(()=>window.__elfura.player.getSources().map(s=>({variant:s.audioVariant,label:s.label,subtitleCount:s.subtitles.length,claimedAsAudioLang:!!s.audioLang})));
  step='language-menu';await page.waitForFunction(()=>{const t=window.__elfura.player.getAudioTracks();return t.some(x=>x.lang==='ja')&&t.some(x=>x.lang==='en')},null,{timeout:15000});
  await page.getByRole('button',{name:'Change audio and subtitles'}).evaluate(button=>button.click());
  const menu=await page.locator('.elf-audio-option').allTextContents();
  if(menu.filter(x=>x.includes('Japanese')).length!==1||menu.filter(x=>x.includes('English')).length!==1||await page.locator('.elf-col-heading').filter({hasText:'Anime source version'}).count())throw Error('language-menu');
  for(const mode of ['sub','dub','sub']){
   step='switch-'+mode;const lang=mode==='sub'?'ja':'en';const label=mode==='sub'?'Japanese':'English';
   await page.locator('.elf-audio-option').filter({hasText:label}).click();
   await page.waitForFunction(({mode,lang})=>{const p=window.__elfura.player,v=p.video;return p.currentSource?.audioVariant===mode&&p.getState().audioLang===lang&&v.videoWidth>0&&v.readyState>=2},{mode,lang},{timeout:30000});
   const id=await page.evaluate(()=>window.__elfura.player.currentSource?.id);if(!id)throw Error('no-variant');
   await page.evaluate(()=>{const v=window.__elfura.player.video;v.currentTime=420;v.play().catch(()=>{})});
   await page.waitForFunction(id=>{const p=window.__elfura.player,v=p.video;return p.currentSource?.id===id&&!v.seeking&&v.currentTime>=420&&v.readyState>=2},id,{timeout:25000});
   const metrics=await page.evaluate(async()=>{const p=window.__elfura.player,v=p.video,ctx=new AudioContext(),a=ctx.createAnalyser(),src=ctx.createMediaStreamSource(v.captureStream());src.connect(a);const x=new Float32Array(a.fftSize);let rms=0;for(let i=0;i<30;i++){a.getFloatTimeDomainData(x);rms=Math.max(rms,Math.sqrt(x.reduce((n,v)=>n+v*v,0)/x.length));await new Promise(r=>setTimeout(r,100))}src.disconnect();await ctx.close();return {rms:Math.round(rms*100000)/100000,current:p.currentSource?.id,video:v.videoWidth>0,duration:v.duration,subtitleTracks:p.getSubtitleTracks().length}});
   if(metrics.current!==id||metrics.rms<0.0001||metrics.duration<1000||metrics.duration>1900)throw Error('playback');
   const entry={mode,rms:metrics.rms,subtitleTracks:metrics.subtitleTracks};
   if(mode==='sub'&&sample.ep===1){step='subtitle';const en=await page.evaluate(()=>window.__elfura.player.getSubtitleTracks().find(t=>t.lang==='en')?.id??null);if(!en)throw Error('subtitle-absent');const selected=await page.evaluate(id=>window.__elfura.player.setSubtitle(id),en);if(!selected)throw Error('subtitle-refused');step='subtitle-load';await page.waitForFunction(()=>window.__elfura.player.getCues()?.length>0,null,{timeout:12000});entry.parsedSubtitle=true;
    const cueTime=await page.evaluate(()=>{const p=window.__elfura.player;const cue=p.getCues().find(c=>c.start>420&&c.start<p.video.duration-5&&c.end-c.start>=2&&c.spans.some(s=>s.text.trim()));return cue?cue.start+0.4:null});if(cueTime===null)throw Error('subtitle-no-cue');
    await page.evaluate(t=>{const v=window.__elfura.player.video;v.currentTime=t;v.pause()},cueTime);
    step='subtitle-render';await page.waitForFunction(()=>{const box=document.querySelector('.elf-sub-root[data-state="showing"] .elf-sub-box');const rect=box?.getBoundingClientRect();return !!(box?.textContent?.trim()&&rect?.width&&rect?.height)},null,{timeout:12000});entry.visibleSubtitle=true;
   }
   row.lanes.push(entry);
  }
  row.ok=true;
 }catch(e){row.ok=false;row.step=step;row.error=e.name==='TimeoutError'?'timeout':['no-variant','playback','subtitle-absent','subtitle-refused'].includes(e.message)?e.message:e.name;row.playerState=await page.evaluate(()=>{const p=window.__elfura?.player,v=p?.video;return {current:p?.currentSource?.audioVariant,audio:p?.getState().audioLang,tracks:p?.getAudioTracks().map(t=>({lang:t.lang,kind:t.kind,providerHint:t.providerHint})),ready:v?.readyState,paused:v?.paused,seeking:v?.seeking,time:v?.currentTime}}).catch(()=>null);}rows.push(row);}
 console.log('::notice title=Novus actual adapter player test::'+JSON.stringify(rows));
 if(rows.some(row=>!row.ok)) process.exitCode=1;
}finally{await browser?.close();await new Promise(r=>server.close(r));globalThis.fetch=orig;}
