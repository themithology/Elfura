// Isolated public Vidara example: browser playback and track switching only.
// This is not a production adapter or a TMDB catalogue.
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import {readFile} from 'node:fs/promises';
const headers={Referer:'https://vidara.to/',Origin:'https://vidara.to'};
const api=await fetch('https://vidara.to/api/stream',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({filecode:'fea967f75055',device:'web'}),signal:AbortSignal.timeout(10000)});
const data=await api.json();if(!data.streaming_url)throw new Error('No stream');
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage();const urls=new Map();let counter=0;const statuses=[];
function ticket(url){const u=new URL(url);if(u.protocol!=='https:' || !/(^|\.)(s1q2105\.com|97bf1\.com)$/.test(u.hostname))throw new Error('Unknown CDN');const key=String(++counter);urls.set(key,u.toString());return `https://fixture.invalid/media/${key}`;}
const master=ticket(data.streaming_url);
try{
 await page.route('https://fixture.invalid/**',async route=>{try{
  const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><video muted playsinline></video>'});
  const target=urls.get(u.pathname.split('/').pop());if(!target)return route.fulfill({status:404});
  const res=await fetch(target,{headers:{...headers,...(route.request().headers().range?{Range:route.request().headers().range}:{})},signal:AbortSignal.timeout(12000)});
  statuses.push(res.status);if(!res.ok)return route.fulfill({status:res.status});
  const ct=res.headers.get('content-type')||'application/octet-stream';
  const bytes=Buffer.from(await res.arrayBuffer());if(bytes.length>12000000)throw new Error('media too large');
  if(bytes.subarray(0,200).toString().trimStart().startsWith('#EXTM3U')){
   const text=bytes.toString().split('\n').map(line=>{if(line.startsWith('#'))return line.replace(/URI="([^"]+)"/g,(_,v)=>`URI="${ticket(new URL(v,target))}"`);return line.trim()?ticket(new URL(line.trim(),target)):line;}).join('\n');
   return route.fulfill({status:200,contentType:'application/vnd.apple.mpegurl',body:text});
  }
  return route.fulfill({status:res.status,contentType:ct,body:bytes});
 }catch{statuses.push('proxy-error');return route.abort().catch(()=>{});}});
 await page.goto('https://fixture.invalid/');await page.addScriptTag({content:await readFile('node_modules/hls.js/dist/hls.min.js','utf8')});
 await page.evaluate(src=>{const v=document.querySelector('video'),h=new window.Hls();window.testHls=h;h.loadSource(src);h.attachMedia(v);void v.play().catch(()=>{});},master);
 await page.waitForFunction(()=>document.querySelector('video').currentTime>2,null,{timeout:30000});
 const before=await page.evaluate(()=>({time:document.querySelector('video').currentTime,tracks:window.testHls.audioTracks.map(x=>({lang:x.lang,name:x.name})),current:window.testHls.audioTrack}));
 const switched=await page.evaluate(()=>{const h=window.testHls;const idx=h.audioTracks.findIndex(x=>/telugu/i.test(x.lang||x.name||''));if(idx<0)return false;h.audioTrack=idx;return true;});
 await page.waitForTimeout(6000);
 const after=await page.evaluate(()=>({time:document.querySelector('video').currentTime,ready:document.querySelector('video').readyState,current:window.testHls.audioTrack}));
 console.log('::notice title=VidaraBrowser::'+JSON.stringify({title:data.title,before,after,switched,progress:after.time-before.time,statuses:[...new Set(statuses)]}));
}catch(e){console.log('::notice title=VidaraBrowser::'+JSON.stringify({error:e.name,statuses:[...new Set(statuses)]}));process.exitCode=1;}
finally{await browser.close();}
