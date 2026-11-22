// Read the public player-decoded discovery response without logging URLs or secrets.
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
const notice=(t,v)=>console.log(`::notice title=${t}::${JSON.stringify(v).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,9000)}`);
const browser=await chromium.launch({executablePath:await binary.executablePath(),args:binary.args});
for(const route of ['/embed/movie/1303331','/embed/movie/550','/embed/tv/1396/1/1']){
 const page=await browser.newPage();let rpc=null,scramble=null,requestBody=null;const tasks=[];
 page.on('response',r=>{try{const u=new URL(r.url());if(u.hostname!=='tgvidx.lovable.app')return;if(/\/scramble-[^/]+\.js$/.test(u.pathname))scramble=u.pathname;if(u.pathname.includes('ff183e1ad6d02c4c'))tasks.push((async()=>{try{const o=await r.json();rpc=o?.p?.v?.[0]?.p?.v?.[0]?.s;requestBody=r.request().postData()}catch{}})())}catch{}});
 try{
 await page.goto('https://tgvidx.lovable.app'+route,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(18000);await Promise.allSettled(tasks);
 const result=await page.evaluate(async({rpc,scramble})=>{
  if(!rpc||!scramble)return {error:'missing RPC or client decoder',hasRpc:!!rpc,scramble};
  let text;try{text=(await import(scramble)).unscramble(rpc)}catch(e){return {error:'decode '+e.name}};
  let obj;try{obj=JSON.parse(text)}catch{return {error:'not JSON',len:text.length,head:text.slice(0,12).replace(/[a-zA-Z0-9]/g,'x')}}
  const rows=[];
  function walk(v,path,depth){if(depth>12||!v||typeof v!=='object')return;if(Array.isArray(v)){if(v.length&&v[0]&&typeof v[0]==='object')rows.push({path,count:v.length,keys:Object.keys(v[0]).slice(0,20),samples:v.slice(0,30).map(x=>{if(!x||typeof x!=='object')return null;const r={};for(const [k,z] of Object.entries(x)){if(typeof z==='string'&&/^(id|provider|label|name|type|quality|language|server|source)$/i.test(k))r[k]=z.slice(0,80);if(typeof z==='string'&&/^(url|file|src|link)$/i.test(k)){try{const u=new URL(z,location.origin);r[k]={host:u.hostname,path:u.pathname,queryKeys:[...u.searchParams.keys()]}}catch{}}}return r})});for(let i=0;i<Math.min(v.length,4);i++)walk(v[i],path+'[]',depth+1)}else for(const [k,x] of Object.entries(v))walk(x,path+'.'+k,depth+1)}
  walk(obj,'$',0);return {rootKeys:Object.keys(obj),rows};
 },{rpc,scramble});
 notice('TGVIDX decode '+route,{request:requestBody?JSON.parse(requestBody):null,...result});
 }catch(e){notice('TGVIDX error '+route,{name:e.name,message:e.message.slice(0,100)})}finally{await page.close().catch(()=>{})}
}
await browser.close();
