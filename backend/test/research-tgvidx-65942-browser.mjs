// Compare upstream's actual player selection with Source 17. Do not log URLs,
// tokens or body content; controls and network host/status counts are enough.
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
const note=(title,value)=>console.log('::notice title='+title+'::'+JSON.stringify(value).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,10000));
const b=await chromium.launch({executablePath:await binary.executablePath(),args:[...binary.args,'--autoplay-policy=no-user-gesture-required']});const p=await b.newPage();
try{
 for(const label of ['TG VIDARA','TG VIDSHARED','TG MAGPIE']){
  const network={};const onResponse=r=>{try{const u=new URL(r.url());if(/\.(?:js|css|png|jpg|webp|svg|woff2?)$/i.test(u.pathname))return;const k=`${u.hostname} ${r.status()} ${(r.headers()['content-type']||'').split(';')[0]}`;network[k]=(network[k]||0)+1}catch{}};p.on('response',onResponse);
  const row={label};try{
   await p.goto('https://tgvidx.lovable.app/embed/tv/65942/1/1',{waitUntil:'domcontentloaded',timeout:30000});
   await p.getByRole('button',{name:'Servers',exact:true}).first().click({timeout:50000});
   const option=p.getByRole('button',{name:label,exact:false}).first();row.found=await option.count()>0;
   if(row.found){await option.click({timeout:5000});for(const delay of [5000,10000,15000]){await p.waitForTimeout(delay);(row.observations??=[]).push(await p.evaluate(()=>({video:[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,height:v.videoHeight,time:Math.round(v.currentTime*10)/10,ready:v.readyState,paused:v.paused,error:v.error?.code})),text:document.body.innerText.slice(0,700)})))}}
  }catch(e){row.error=e.name}p.off('response',onResponse);row.network=network;note('TGVIDX upstream '+label,row);
 }
}finally{await b.close()}
