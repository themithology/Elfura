// Investigate OFC public playback without logging signed URLs or credentials.
import {chromium} from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
import ffprobe from '@ffprobe-installer/ffprobe';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),id=process.env.OFC_ID||'317614306860908496',params=process.env.OFC_PARAMS||'';
const base='https://ofcmovies.com',pageUrl=`${base}/watch.php?id=${id}${params}`;
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();const statuses=[];
page.on('response',r=>{try{const u=new URL(r.url());if(u.pathname.endsWith('/stream.php')||u.hostname.endsWith('hakunaymatata.com'))statuses.push({host:u.hostname,status:r.status(),contentType:r.headers()['content-type']||'',range:!!r.headers()['content-range']})}catch{}});
try{
 await page.goto(pageUrl,{waitUntil:'domcontentloaded',timeout:35000});
 const info=await page.evaluate(()=>({title:document.title,stream:[...document.querySelectorAll('a[href*="stream.php"]')].map(a=>a.href).find(u=>new URL(u).searchParams.has('u')),videoCount:document.querySelectorAll('video').length}));
 let direct,proxy,probe;
 if(info.stream){const u=new URL(info.stream);const encoded=u.searchParams.get('u');const media=Buffer.from(encoded,'base64').toString();const cdn=new URL(media);const fingerprint=createHash('sha256').update(cdn.origin+cdn.pathname).digest('hex').slice(0,12);
  async function range(url,headers={}){try{const r=await fetch(url,{headers:{...headers,Range:'bytes=0-4095'},signal:AbortSignal.timeout(9000)});const type=r.headers.get('content-type');const size=r.headers.get('content-range');await r.body?.cancel();return{status:r.status,type,partial:!!size};}catch(e){return{error:e.name}}}
  [proxy,direct]=await Promise.all([range(info.stream,{Referer:pageUrl}),range(media,{Referer:'https://movieboxonline.net/','User-Agent':'Mozilla/5.0'})]);
  try{const {stdout}=await exec(ffprobe.path,['-v','error','-rw_timeout','7000000','-headers',`Referer: ${pageUrl}\r\n`,'-probesize','1500000','-analyzeduration','3000000','-show_entries','stream=index,codec_type,codec_name:stream_tags=language','-of','json',info.stream],{timeout:18000,maxBuffer:100000});const parsed=JSON.parse(stdout);probe={streams:(parsed.streams||[]).map(x=>({type:x.codec_type,codec:x.codec_name,language:x.tags?.language||null}))};}catch(e){probe={error:e.killed?'timeout':'failed',exitCode:e.code??null};}
  info.mediaHost=cdn.hostname;info.fingerprint=fingerprint;delete info.stream;
 }
 const play=await page.evaluate(()=>{const v=document.querySelector('video');if(!v)return 'no-video';v.muted=true;void v.play().catch(()=>{});return 'requested'});await page.waitForTimeout(15000);
 const playback=await page.evaluate(()=>{const v=document.querySelector('video');return v?{time:v.currentTime,ready:v.readyState,error:v.error?.code||null,width:v.videoWidth,height:v.videoHeight,paused:v.paused,audioTracks:v.audioTracks?.length??null}:null;});
 console.log('::notice title=OFCResearch::'+JSON.stringify({id,info,direct,proxy,probe,play,playback,statuses:statuses.slice(0,12)}));
}catch(e){console.log('::notice title=OFCResearch::'+JSON.stringify({id,error:e.name,statuses:statuses.slice(0,12)}));process.exitCode=1;}
finally{await browser.close();}
