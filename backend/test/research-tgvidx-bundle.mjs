// Inspect public TGVIDX browser code and data shape; emit no secrets or signed URLs.
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
const browser=await chromium.launch({executablePath:await binary.executablePath(),args:binary.args});const page=await browser.newPage();const jobs=[];let found=0;
const notice=(title,data)=>console.log(`::notice title=${title}::${JSON.stringify(data).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,7000)}`);
function sanitize(s){return s.replace(/(["'`])(?:\\.|(?!\1)[^\\]){35,}?\1/g,'"[long string]"').replace(/https?:\/\/[^\s"'`]+/g,'[url]');}
page.on('response',r=>{let u=new URL(r.url());if(u.hostname!=='tgvidx.lovable.app')return;
 if(u.pathname.endsWith('.js')) jobs.push((async()=>{try{const text=await r.text();const terms=['ff183e1ad6d02c4c','/api/m/','stream-proxy','STREAMHG','streamhg','atob(','crypto.subtle','decrypt'];let out=[];for(const term of terms){let idx=-1,count=0;while((idx=text.indexOf(term,idx+1))>=0 && count++<3){out.push({term,code:sanitize(text.slice(Math.max(0,idx-250),idx+350))});}}if(out.length)notice('TGVIDX JS '+u.pathname,out)}catch{}})());
 if(u.pathname.includes('ff183e1ad6d02c4c'))jobs.push((async()=>{try{let o=await r.json();let p=o?.p?.v?.[0]?.p?.v?.[0]?.s||'';notice('TGVIDX payload shape',{length:p.length,first:p.slice(0,6).replace(/[A-Za-z0-9]/g,'x'),characterSet:/^[A-Za-z0-9+/=_-]+$/.test(p)?'base64-like':'other',json: (()=>{try{let z=JSON.parse(p);return {type:typeof z,keys:Object.keys(z).slice(0,20)}}catch{return false}})()});found++}catch{}})());
});
try{await page.goto('https://tgvidx.lovable.app/embed/movie/1303331',{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(20000);await Promise.allSettled(jobs);notice('TGVIDX result',{found,jobs:jobs.length});}catch(e){notice('TGVIDX error',{name:e.name,message:e.message.slice(0,150)})}finally{await browser.close()}
