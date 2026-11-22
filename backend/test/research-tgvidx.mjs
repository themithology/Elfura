// Research TGVIDX's server-function discovery protocol. Never print signed URLs,
// auth values, request bodies containing credentials, or the response payload.
import { chromium } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';
const base='https://tgvidx.lovable.app';
const browser=await chromium.launch({executablePath:await chromiumBinary.executablePath(),args:[...chromiumBinary.args,'--autoplay-policy=no-user-gesture-required']});
function safe(v){
 if(typeof v==='string'){
  if(/^https?:\/\//i.test(v)){try{const u=new URL(v);return `URL(${u.hostname}${u.pathname},keys:${[...u.searchParams.keys()].join(',')})`}catch{return 'URL(invalid)'}}
  if(v.length>100||/^[\w+\-/=]{100,}$/.test(v))return `<string:${v.length}>`;
  if(/token|secret|signature|authorization|key-pair|policy/i.test(v))return '<sensitive-name>';
  return v;
 }
 if(Array.isArray(v))return v.slice(0,20).map(safe);
 if(v && typeof v==='object')return Object.fromEntries(Object.entries(v).slice(0,40).map(([k,x])=>[k,/token|secret|signature|authorization|policy/i.test(k)?'<redacted>':safe(x)]));
 return v;
}
function summarize(label,v){console.log(`::notice title=${label}::${JSON.stringify(v).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,12000)}`)}
for(const route of ['/embed/movie/1303331','/embed/movie/550','/embed/tv/1396/1/1']){
 const page=await browser.newPage();const pending=[];const rpcs=[];const streams=[];
 page.on('response',r=>{const url=new URL(r.url());if(url.hostname==='tgvidx.lovable.app'&&url.pathname.startsWith('/_serverFn/')){
   pending.push((async()=>{try{const text=await r.text(); const req=r.request();let body;try{body=JSON.parse(req.postData()||'null')}catch{body='<non-json>'}let data;try{data=JSON.parse(text)}catch{data='<non-json>'}
    rpcs.push({path:url.pathname,method:req.method(),queryKeys:[...url.searchParams.keys()],requestHeaders:Object.keys(req.headers()),body:safe(body),response:safe(data),bytes:text.length});
   }catch{}})());
 }else if(['xhr','fetch','media'].includes(r.request().resourceType())&&!url.hostname.endsWith('lovable.app'))streams.push({host:url.hostname,path:url.pathname,status:r.status(),type:r.headers()['content-type']?.split(';')[0]});});
 try{await page.goto(base+route,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(25000);await Promise.allSettled(pending); const ui=await page.evaluate(()=>document.body.innerText.slice(0,600));summarize('TGVIDX '+route+' routes',streams.slice(0,15));summarize('TGVIDX '+route+' UI',ui);
 for(const rpc of rpcs) summarize('TGVIDX '+route+' RPC',rpc);
 }catch(e){summarize('TGVIDX error',{route,name:e.name,message:e.message.slice(0,150)})}finally{await page.close()}
}
await browser.close();
