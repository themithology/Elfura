// Compare TGVIDX web client and backend HTTP transports. No tokens or media
// URLs are emitted; a status or decodable inventory is not playback proof.
import {installEgressProfile} from '../../dist/backend/egress.js';
import {decodeTgvidxResponse} from '../../dist/backend/sources/source17.js';
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
import {fetch as browserFetch} from 'wreq-js';
const origin='https://tgvidx.lovable.app',rpc='/_serverFn/ff183e1ad6d02c4c08e8e73151c60e5dcc23f8f4c9db53eac9d271b87a56e121';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const makeBody=p=>JSON.stringify({t:{t:10,i:0,p:{k:['data'],v:[{t:10,i:1,p:{k:['path'],v:[{t:1,s:p}]},o:0}]},o:0},f:127,m:[]});
const headers={Accept:'application/json','Content-Type':'application/json','x-tsr-serverfn':'true','User-Agent':ua,Referer:origin+'/',Origin:origin};
const original=globalThis.fetch;await installEgressProfile(()=>{});const profiled=globalThis.fetch;
const report=(title,o)=>console.log(`::notice title=${title}::${JSON.stringify(o).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,9000)}`);
async function run(name,f,path){const start=Date.now();try{const res=await f(origin+rpc,{method:'POST',redirect:'manual',headers,body:makeBody(path),signal:AbortSignal.timeout(12000)});const text=await res.text();const payload=decodeTgvidxResponse(text);return {name,path,ms:Date.now()-start,status:res.status,server:res.headers.get('server'),challenge:res.headers.get('cf-mitigated'),contentType:(res.headers.get('content-type')||'').split(';')[0],length:text.length,challengeBody:/challenge|cloudflare|just a moment/i.test(text.slice(0,1000)),decoded:!!payload,identity:payload?{id:payload.tmdb_id,type:payload.type,season:payload.season,episode:payload.episode,rows:Array.isArray(payload.links)?payload.links.map(x=>({server:x.server,type:x.type})):null}:null}}catch(e){return {name,path,ms:Date.now()-start,error:e.name,cause:e.cause?.code||e.cause?.name||null}}}
const wreq=(url,init)=>browserFetch(url,{...init,browser:'chrome_149',os:'windows',timeout:12000});
for(const path of ['/api/tv/65942/1/1','/api/m/550']){
 for(const [name,f] of [['native',original],['profiled',profiled],['wreq',wreq]]) report('TGVIDX transport '+path,await run(name,f,path));
}
let b;try{
 b=await chromium.launch({executablePath:await binary.executablePath(),args:[...binary.args,'--autoplay-policy=no-user-gesture-required']});const p=await b.newPage();const responses=[],pending=[];
 p.on('response',r=>{try{const u=new URL(r.url());if(u.hostname==='tgvidx.lovable.app'&&u.pathname.startsWith('/_serverFn/'))pending.push((async()=>{const t=await r.text().catch(()=>'');const d=decodeTgvidxResponse(t);responses.push({path:u.pathname,status:r.status(),length:t.length,decoded:!!d,rows:Array.isArray(d?.links)?d.links.map(x=>({server:x.server,type:x.type})):null})})())}catch{}});
 await p.goto(origin+'/embed/tv/65942/1/1',{waitUntil:'domcontentloaded',timeout:30000});await p.waitForTimeout(18000);await Promise.allSettled(pending);
 const ui=await p.evaluate(()=>({text:document.body.innerText.slice(0,600),video:[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,time:v.currentTime,ready:v.readyState}))}));
 const pageFetch=await p.evaluate(async({rpc,body})=>{const start=Date.now();try{const r=await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json','x-tsr-serverfn':'true',Accept:'application/json'},body,signal:AbortSignal.timeout(12000)});const text=await r.text();return {status:r.status,ms:Date.now()-start,length:text.length,server:r.headers.get('server'),contentType:r.headers.get('content-type'),body:text}}catch(e){return {error:e.name,ms:Date.now()-start}}},{rpc,body:makeBody('/api/tv/65942/1/1')});
 const decoded=pageFetch.body&&decodeTgvidxResponse(pageFetch.body);delete pageFetch.body;pageFetch.decoded=!!decoded;pageFetch.rows=Array.isArray(decoded?.links)?decoded.links.map(x=>({server:x.server,type:x.type})):null;
 report('TGVIDX actual site browser',{ui,responses,pageFetch});
}catch(e){report('TGVIDX browser error',{name:e.name,message:String(e.message||'').replace(/https?:\/\/\S+/g,'[url]').slice(0,160)})}finally{await b?.close().catch(()=>{});globalThis.fetch=original}
