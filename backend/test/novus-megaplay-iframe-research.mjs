// Isolated iframe/player reconnaissance. No URLs, tokens, cookies, scripts or
// media are printed or retained as artifacts. In-memory manifests are used only
// to count actually requested playlists, not to claim an Elfura integration.
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const cases=[['Naruto','20'],['Jujutsu Kaisen','113415']];
const hosts=[['Novus','https://novuscloud.buzz','hsub'],['Novus','https://novuscloud.buzz','sub'],['Novus','https://novuscloud.buzz','dub'],['MegaPlay','https://megaplay.buzz','sub'],['MegaPlay','https://megaplay.buzz','dub']];
const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><body></body></html>')});
let browser;const all=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 for(const [title,aid] of cases){const rows=[];
  for(const [host,origin,lane] of hosts){const row={title,host,lane,playlists:0,playlistOk:0,apiResponses:[],video:null};let step='load';const pending=[];
   const response=res=>{try{const u=new URL(res.url()),status=res.status(),mime=(res.headers()['content-type']??'').toLowerCase();
    if(/\.m3u8(?:$|\?)/i.test(u.href)||/mpegurl/.test(mime)){row.playlists++;if(status>=200&&status<300)row.playlistOk++;}
    if(u.origin===origin&&/getSources|\/api\/|\/proxy\//i.test(u.pathname)&&row.apiResponses.length<8){
     const info={kind:/getSources/i.test(u.pathname)?'sources':/\/proxy\//i.test(u.pathname)?'proxy':'api',status,path:u.pathname.replace(/\d+/g,'#'),params:[...new Set(u.searchParams.keys())].slice(0,12)};row.apiResponses.push(info);
     if(/json/.test(mime)&&status===200)pending.push(res.json().then(data=>{info.keys=Object.keys(data??{}).filter(k=>/^[a-zA-Z_]{1,32}$/.test(k)).slice(0,20);info.encrypted=typeof data?.enc==='string';info.hasSources=!!data?.sources;}).catch(()=>{}));
    }
   }catch{}};
   page.on('response',response);
   try{
    await page.goto(base,{waitUntil:'domcontentloaded'});
    const embed=host==='Novus'?`${origin}/embed/ani/${aid}/1/${lane}?k=1&autoplay=1`:`${origin}/stream/ani/${aid}/1/${lane}?autoplay=1`;
    await page.evaluate(src=>{const f=document.createElement('iframe');f.src=src;f.allow='autoplay; fullscreen';f.style='width:960px;height:540px;border:0';document.body.append(f)},embed);
    step='frame';await page.waitForFunction(o=>[...document.querySelectorAll('iframe')].some(f=>f.src.startsWith(o)),origin,{timeout:5000});
    await page.waitForTimeout(2500);
    const frame=page.frames().find(f=>f.url().startsWith(origin));if(!frame)throw Error('no-frame');
    await frame.evaluate(()=>{for(const v of document.querySelectorAll('video'))v.play().catch(()=>{})}).catch(()=>{});
    step='video';await frame.waitForFunction(()=>{const v=document.querySelector('video');return v?.videoWidth>0&&v.currentTime>1},null,{timeout:30000});
    row.video=await frame.evaluate(()=>{const v=document.querySelector('video');return {width:v.videoWidth,height:v.videoHeight,duration:v.duration,textTracks:v.textTracks.length,time:Math.round(v.currentTime),frames:v.getVideoPlaybackQuality?.().totalVideoFrames??null}});
    row.ok=true;
   }catch(e){row.ok=false;row.step=step;row.error=e.name==='TimeoutError'?'timeout':e.message==='no-frame'?'no-frame':e.name;}
   page.off('response',response);await Promise.allSettled(pending);rows.push(row);await page.goto(base).catch(()=>{});
  }
  all.push(...rows);console.log('::notice title=Requested anime iframe research::'+JSON.stringify(rows));
 }
}finally{await browser?.close();await new Promise(r=>server.close(r));}
