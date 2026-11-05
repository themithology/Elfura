// Research only. Contacts original VidBolt-family upstreams, never Aethoflix.
// Do not log request URLs, API keys, signed URLs, or response bodies.
const cases=[{id:'93405',type:'tv',title:'Squid Game',year:'2021'}, {id:'289517',type:'tv',title:'Dead-End Job',year:'2026'}, {id:'693134',type:'movie',title:'Dune: Part Two',year:'2024'}];
const h={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36',Referer:'https://vidbolt.xyz/',Origin:'https://vidbolt.xyz',Accept:'*/*'};
const banned=u=>/(^|\.)(vidstuck\.cc|nxsha\.space|embed\.aethoflix\.live|embed\.aethoflix\.world|zxcstream-mirror\.vercel\.app)$/i.test(new URL(u).hostname);
async function request(url,headers=h) {
 for(let i=0;i<4;i++) { if(banned(url)) return {blocked:true}; const r=await fetch(url,{headers,redirect:'manual',signal:AbortSignal.timeout(8000)}); if([301,302,303,307,308].includes(r.status)) {const next=r.headers.get('location'); await r.body?.cancel(); if(!next)return {r}; url=new URL(next,url).href;continue;} return {r,url}; }
 return {};
}
async function read(r,limit=262144) {const reader=r.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks=[];let total=0;try{while(total<limit){const x=await reader.read();if(x.done)break;chunks.push(x.value);total+=x.value.length;}}finally{await reader.cancel().catch(()=>{});}return Buffer.concat(chunks).subarray(0,limit);}
function media(b){const tag=b.subarray(4,8).toString('ascii');return b.length>188&&((b[0]===0x47&&b[188]===0x47)||['ftyp','styp','moof','mdat'].includes(tag));}
async function playlist(url,depth=0){
 if(depth>4)return {error:'depth'};
 try {const x=await request(url,{...h,Range:'bytes=0-65535'}); if(x.blocked)return {error:'excluded'};if(!x.r?.ok)return {error:`http-${x.r?.status||0}`};const b=await read(x.r);const text=b.toString('utf8');if(!text.trimStart().startsWith('#EXTM3U'))return {bytes:media(b)?b.length:0};
 const lines=text.split(/\r?\n/);const tracks=lines.filter(l=>/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(l)); const langs=tracks.map(l=>l.match(/LANGUAGE="([^"]+)"/i)?.[1]).filter(Boolean); const hindi=tracks.find(l=>/LANGUAGE="(?:hi|hin)(?:-[^"]*)?"/i.test(l)); const audioUri=hindi?.match(/URI="([^"]+)"/i)?.[1]; const child=lines.map(l=>l.trim()).find(l=>l&&!l.startsWith('#')); const [video,audio]=await Promise.all([child?playlist(new URL(child,x.url).href,depth+1):null,audioUri?playlist(new URL(audioUri,x.url).href,depth+1):null]); return {audioTracks:tracks.length,languages:langs,variants:(text.match(/^#EXT-X-STREAM-INF/gim)||[]).length,video,audioHindi:audio};
 }catch(e){return {error:e.name};}
}
async function resolve(c,family,keys){
 const qs=new URLSearchParams({tmdbId:c.id,title:c.title,year:c.year});if(c.type==='tv'){qs.set('season','1');qs.set('episode','1');}
 let u;
 if(family==='callisto')u=`https://scraper.vidbolt.xyz/scrape/Callisto/${c.type}/${c.type==='tv'?'tmdb':''}${c.id}?${qs}`;
 else if(family==='vidbolt'){const q=new URLSearchParams({type:c.type,id:c.id,season:'1',episode:'1',only:'orion',hevc:'0'});u=`https://vidbolt.xyz/api/resolve?${q}`;}
 else if(c.type==='tv')u=`https://img.animecurx.tech/api/tv/${c.id}/1/1?${new URLSearchParams({api_key:keys.tv,apikey:keys.tv})}`;
 else u=`https://api.movy.lol/api/source/${c.id}?${new URLSearchParams({api_key:keys.movie,apikey:keys.movie})}`;
 try{const start=Date.now(), x=await request(u);if(!x.r?.ok)return {id:c.id,family,status:x.r?.status||0,ms:Date.now()-start}; const payload=JSON.parse((await read(x.r)).toString('utf8')); let sources=Array.isArray(payload.sources)?payload.sources:Array.isArray(payload.stream?.sources)?payload.stream.sources:[];if(!sources.length&&payload.m3u8_path){const base='https://img.rousav.tech';sources=[{url:`${base}/${String(payload.m3u8_path).replace(/^\//,'')}?${new URLSearchParams({api_key:c.type==='tv'?keys.tv:keys.movie})}`}];}
 const candidates=sources.map(s=>s?.url||s?.file).filter(v=>typeof v==='string'&&/^https?:/i.test(v)&&!banned(v)).slice(0,3);const checks=await Promise.all(candidates.map(async url=>({host:new URL(url).hostname,stream:await playlist(url)})));return {id:c.id,family,status:x.r.status,count:sources.length,checks,ms:Date.now()-start};
 }catch(e){return {id:c.id,family,error:e.name};}
}
let keys={movie:'',tv:''};
try {const r=await fetch('https://github.com/FmcStore/streamex-api/raw/refs/heads/main/players/p5_vidbolt.py',{signal:AbortSignal.timeout(12000)});const s=await r.text();keys.movie=s.match(/key = "([a-f0-9]{40,})"/)?.[1]||'';keys.tv=s.match(/"(streamrip_secret_[0-9]+)"/)?.[1]||'';}catch{}
for(const c of cases){const out=await Promise.all(['vidbolt','orion'].map(f=>resolve(c,f,keys)));console.log(`::notice title=VidboltDirect::${JSON.stringify(out).replace(/%/g,'%25').replace(/\n/g,'%0A')}`);}
const unkeyed=await Promise.all(cases.map(async c=>{const url=c.type==='tv'?`https://img.animecurx.tech/api/tv/${c.id}/1/1`:`https://api.movy.lol/api/source/${c.id}`;try {const x=await request(url);await x.r?.body?.cancel();return {id:c.id,status:x.r?.status||0};}catch(e){return {id:c.id,error:e.name};}}));
console.log(`::notice title=VidboltDirect::${JSON.stringify({unkeyed}).replace(/%/g,'%25')}`);
