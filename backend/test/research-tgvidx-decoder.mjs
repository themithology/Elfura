// Read only the public decoder's structure, not the embedded transform string.
import {chromium} from 'playwright-core';import binary from '@sparticuz/chromium';
const b=await chromium.launch({executablePath:await binary.executablePath(),args:binary.args});const p=await b.newPage();const tasks=[];
p.on('response',r=>{if(!/\/scramble-[^/]+\.js$/.test(new URL(r.url()).pathname))return;tasks.push((async()=>{let t=await r.text();let clean=t.replace(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g,m=>`<literal:${m.length-2}>`);console.log('::notice title=Public decoder structure::'+JSON.stringify({code:clean.slice(0,4000)}).replace(/%/g,'%25'));})())});
await p.goto('https://tgvidx.lovable.app/embed/movie/1303331',{waitUntil:'domcontentloaded',timeout:30000});await p.waitForTimeout(10000);await Promise.allSettled(tasks);await b.close();
