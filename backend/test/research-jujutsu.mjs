// Sanitize all results: no stream URLs, signed tickets, cookies or response bodies.
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
function log(title,object){console.log(`::notice title=${title}::${JSON.stringify(object).replace(/%/g,'%25').replace(/\n/g,'%0A')}`)}
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36';
const site='https://embed.theogpiratebot.online';
try{
 const session=await fetch(site+'/api/v1/session',{method:'POST',headers:{'User-Agent':ua,Origin:site,Referer:site+'/embed/tv/95479/1/1','Content-Type':'application/json'},body:JSON.stringify({type:'tv',tmdb:'95479',season:1,episode:1}),signal:AbortSignal.timeout(15000)}).then(r=>r.json());
 for(const source of ['','source-1','source-2','source-3']){
  const start=Date.now();try{const q=new URLSearchParams({type:'tv',tmdb:'95479',s:'1',e:'1',...(source?{source}:{})});const r=await fetch(site+'/api/v1/playback?'+q,{headers:{'User-Agent':ua,Origin:site,Referer:site+'/', 'X-Playback-Token':session.pltoken||''},signal:AbortSignal.timeout(15000)});const d=await r.json();log('JJKDeployed',{source:source||'combined',status:r.status,ms:Date.now()-start,options:(d.sources||[]).map(s=>({id:s.sourceId,label:s.label,multi:s.multiAudio,langs:s.availableAudioLangs||[]}))});}catch(e){log('JJKDeployed',{source,error:e.name})}
 }
}catch(e){log('JJKSession',{error:e.name})}
for(const lane of ['orion','vega','quantum','callisto','quasar']){
 try{const q=new URLSearchParams({type:'tv',id:'95479',season:'1',episode:'1',only:lane,hevc:'0'});const r=await fetch('https://vidbolt.xyz/api/resolve?'+q,{headers:{'User-Agent':ua,Referer:'https://vidbolt.xyz/',Origin:'https://vidbolt.xyz'},signal:AbortSignal.timeout(10000)});const d=await r.json();const sources=d?.stream?.sources||[];let probes=[];for(const s of sources.slice(0,2)){try{const p=await fetch(s.url,{headers:{'User-Agent':ua,Referer:'https://vidbolt.xyz/'},signal:AbortSignal.timeout(8000)});const t=await p.text();const aud=t.split(/\r?\n/).filter(x=>/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(x));probes.push({host:new URL(s.url).hostname,status:p.status,audio:aud.length,languages:aud.map(x=>x.match(/LANGUAGE="([^"]+)"/i)?.[1]).filter(Boolean)});}catch(e){probes.push({error:e.name})}}log('JJKProvider',{lane,status:r.status,count:sources.length,probes});}catch(e){log('JJKProvider',{lane,error:e.name})}
}
let browser;
try{
 browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
 for(const url of ['https://animesalttv.to/episode/jujutsu-kaisen-1x1/','https://player.nekomux.com/episode/354']){
  const page=await browser.newPage({userAgent:ua});const reqs=[],manifests=[];
  page.on('response',async r=>{try{const u=new URL(r.url());if(reqs.length<60 && (/nekomux|\.m3u8|\.ts|\.m4s|animesalttv/.test(u.hostname+u.pathname))) reqs.push({host:u.hostname,path:u.pathname.replace(/\d+/g,':id').slice(0,100),status:r.status(),type:r.request().resourceType()});if(/\.m3u8(?:$|\?)/i.test(r.url())){const t=await r.text();const aud=t.split(/\r?\n/).filter(x=>/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(x));manifests.push({status:r.status(),audio:aud.length,languages:aud.map(x=>x.match(/LANGUAGE="([^"]+)"/i)?.[1]).filter(Boolean)});}}catch{}});
  try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});await page.waitForTimeout(18000);const state=await page.evaluate(()=>({title:document.title,videos:[...document.querySelectorAll('video')].map(v=>({time:v.currentTime,ready:v.readyState,paused:v.paused,error:v.error?.code})),frames:[...document.querySelectorAll('iframe')].map(f=>{try{return new URL(f.src).hostname}catch{return 'invalid'}})}));log('JJKBrowser',{host:new URL(url).hostname,state,reqs,manifests});}catch(e){log('JJKBrowser',{host:new URL(url).hostname,error:e.name,reqs,manifests})}await page.close();
 }
}finally{await browser?.close()}
