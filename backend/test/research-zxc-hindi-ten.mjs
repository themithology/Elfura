// Hosted research only: inspect the original ZXC endpoint, never the mirror.
// Do not print response bodies, media URLs, tokens, or title content.
import crypto from 'node:crypto';
const sourceUrl = 'https://github.com/tyer255/ZXCSTREAM-MIRROR/raw/refs/heads/main/serverApp.ts';
const codeRes = await fetch(sourceUrl, {signal: AbortSignal.timeout(15000)});
if (!codeRes.ok) throw new Error('public protocol reference unavailable');
const code = await codeRes.text();
const fields = {};
for (const name of ['id','ts','token','title','year','season','episode','path','mediaType','date']) {
  fields[name] = code.match(new RegExp(`\\b${name}:\\s*'([a-f0-9]+)'`))?.[1];
  if (!fields[name]) throw new Error(`missing field ${name}`);
}
const mintPath = code.match(/CURRENT_TOKEN_ENDPOINT\s*=\s*'([^']+)'/)?.[1];
const key = code.match(/const DECRYPTION_KEY\s*=\s*'([^']+)'/)?.[1];
if (!mintPath || !key) throw new Error('protocol reference missing');
const root = 'https://zxcstream.cc';
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36';
const cases = [
  {type:'movie',id:'579974',title:'RRR',year:'2022'},
  {type:'movie',id:'346364',title:'It',year:'2017'},
  {type:'movie',id:'872585',title:'Jawan',year:'2023'},
  {type:'movie',id:'360814',title:'Dangal',year:'2016'},
  {type:'movie',id:'299534',title:'Avengers: Endgame',year:'2019'},
  {type:'movie',id:'634649',title:'Spider-Man: No Way Home',year:'2021'},
  {type:'tv',id:'85937',title:'Demon Slayer: Kimetsu no Yaiba',year:'2019'},
  {type:'tv',id:'66732',title:'Stranger Things',year:'2016'},
  {type:'tv',id:'93405',title:'Squid Game',year:'2021'},
  {type:'tv',id:'289517',title:'Dead-End Job',year:'2026'},
];
const servers = ['andromeda','download','resshin','valstrax','alatreon','orion','atlas','ursa'];
function blocked(url) { return /(?:^|\.)(?:vidstuck\.cc|nxsha\.space|zxcstream-mirror\.vercel\.app)$/i.test(new URL(url).hostname); }
function decrypt(value) {
  try {
    const b = Buffer.from(value, 'base64');
    if (b.subarray(0,8).toString() !== 'Salted__') return value;
    const salt=b.subarray(8,16), ciphertext=b.subarray(16); let data=Buffer.alloc(0), prev=Buffer.alloc(0);
    while (data.length<48) { prev=crypto.createHash('md5').update(Buffer.concat([prev,Buffer.from(key),salt])).digest(); data=Buffer.concat([data,prev]); }
    const d=crypto.createDecipheriv('aes-256-cbc',data.subarray(0,32),data.subarray(32,48));
    return Buffer.concat([d.update(ciphertext),d.final()]).toString('utf8');
  } catch { return ''; }
}
async function get(url, opts = {}) {
  for (let i=0;i<4;i++) {
    if (blocked(url)) return {blocked:true};
    const res=await fetch(url,{...opts,redirect:'manual',signal:AbortSignal.timeout(7500)});
    if ([301,302,303,307,308].includes(res.status)) { const loc=res.headers.get('location'); await res.body?.cancel(); if (!loc) return {response:res}; url=new URL(loc,url).href; continue; }
    return {response:res,url};
  }
  return {};
}
async function bodyLimit(res,max) {
  if (!res.body) return Buffer.alloc(0);
  const reader=res.body.getReader(), chunks=[]; let total=0;
  try { while(total<max) { const x=await reader.read(); if(x.done) break; chunks.push(x.value); total+=x.value.length; } } finally { await reader.cancel().catch(()=>{}); }
  return Buffer.concat(chunks).subarray(0,max);
}
async function verifyHls(url, headers, depth=0) {
  if(depth>4) return {error:'nesting-limit'};
  const {response:r,url:final,blocked:denied}=await get(url,{headers:{...headers,Range:'bytes=0-65535'}});
  if(denied) return {error:'excluded-host'};
  if(!r?.ok) return {error:`http-${r?.status||0}`};
  const b=await bodyLimit(r,262144), text=b.toString('utf8');
  if(!text.trimStart().startsWith('#EXTM3U')) {
    const tag=b.subarray(4,8).toString('ascii');
    const valid=(b.length>188 && b[0]===0x47 && b[188]===0x47)||['ftyp','styp','moof','mdat'].includes(tag);
    return {mediaBytes:valid?b.length:0};
  }
  const lines=text.split(/\r?\n/), audio=lines.filter(l=>/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(l));
  const languages=audio.map(l=>l.match(/LANGUAGE="([^"]+)"/i)?.[1]).filter(Boolean);
  const hindi=audio.find(l=>/LANGUAGE="(?:hi|hin)(?:-[^"]*)?"/i.test(l))?.match(/URI="([^"]+)"/i)?.[1];
  const child=lines.map(l=>l.trim()).find(l=>l&&!l.startsWith('#'));
  const follow=async value=>value?verifyHls(new URL(value,final).href,headers,depth+1):null;
  return {audio:audio.length,languages,variants:(text.match(/^#EXT-X-STREAM-INF/gim)||[]).length,video:await follow(child),hindi:await follow(hindi)};
}
async function verifyDash(url, headers) {
  const {response:r,url:final,blocked:denied}=await get(url,{headers});
  if(denied) return 'removed-provider';
  if(!r?.ok) return `http-${r?.status||0}`;
  const text=(await bodyLimit(r,524288)).toString('utf8');
  if(!/<MPD\b/i.test(text)) return 'not-mpd';
  const audioSets=[...text.matchAll(/<AdaptationSet\b([^>]*)>/gi)].map(x=>x[1]).filter(s=>/audio/i.test(s));
  const langs=[...new Set(audioSets.map(s=>s.match(/\blang=["']([^"']+)["']/i)?.[1]).filter(Boolean))];
  const heights=[...new Set([...text.matchAll(/\bheight=["'](\d+)["']/gi)].map(x=>x[1]))];
  const template=text.match(/<SegmentTemplate\b[^>]*\bmedia=["']([^"']+)["']/i)?.[1];
  const repr=text.match(/<Representation\b[^>]*\bid=["']([^"']+)["']/i)?.[1];
  const bandwidth=text.match(/<Representation\b[^>]*\bbandwidth=["'](\d+)["']/i)?.[1];
  let segment='unresolved';
  if(template && !/\$Time/i.test(template)) {
    const base=text.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i)?.[1] || final;
    let rel=template.replaceAll('&amp;','&').replace(/\$RepresentationID\$/g,repr||'').replace(/\$Bandwidth\$/g,bandwidth||'').replace(/\$Number(?:%0(\d+)d)?\$/g,(_,n)=>'1'.padStart(Number(n)||1,'0'));
    if(!rel.includes('$')) {
      const media=await get(new URL(rel,new URL(base,final)).href,{headers:{...headers,Range:'bytes=0-65535'}});
      if(media.blocked) segment='removed-provider';
      else if(!media.response?.ok) segment=`http-${media.response?.status||0}`;
      else {const b=await bodyLimit(media.response,65536); const tag=b.subarray(4,8).toString('ascii'); segment=['ftyp','styp','moof','mdat'].includes(tag)||b[0]===0x47 ? `bytes-${b.length}` : 'unrecognized';}
    }
  }
  return `mpd audioSets=${audioSets.length} langs=${langs.join('|')||'none'} heights=${heights.join('|')||'none'} segment=${segment}`;
}
async function test(item,server) {
  const h={'User-Agent':userAgent,Referer:`${root}/player/${item.type}/${item.id}${item.type==='tv'?'/1/1':''}`,Origin:root,'Content-Type':'application/json'};
  const form = {[fields.id]:item.id,[fields.mediaType]:item.type,[fields.path]:server};
  if(item.type==='tv') {form[fields.season]=1;form[fields.episode]=1;}
  const time=Date.now();
  try {
    const mint=await get(`${root}${mintPath}`,{method:'POST',headers:h,body:JSON.stringify(form)});
    if(!mint.response?.ok) return `${item.id}/${server} token=${mint.response?.status||0} ms=${Date.now()-time}`;
    const ticket=await mint.response.json();
    if(!ticket.token || !ticket.ts) return `${item.id}/${server} token=no-token ms=${Date.now()-time}`;
    const q=new URLSearchParams({[fields.id]:item.id,[fields.path]:server,[fields.mediaType]:item.type,[fields.ts]:String(ticket.ts),[fields.token]:ticket.token,[fields.title]:item.title,[fields.year]:item.year,[fields.date]:item.year});
    if(item.type==='tv') {q.set(fields.season,'1');q.set(fields.episode,'1');}
    const src=await get(`${root}/backend_/sources/${server}?${q}`,{headers:h});
    if(!src.response?.ok) return `${item.id}/${server} sources=${src.response?.status||0} ms=${Date.now()-time}`;
    const payload=await src.response.json();
    const candidates=(Array.isArray(payload.links)?payload.links:[]).map(x=>({url:decrypt(String(x.link||'')),type:x.type}));
    const candidate=candidates.find(c=>/^https?:/i.test(c.url) && !blocked(c.url) && (c.type==='hls'||c.url.includes('.m3u8')));
    const dash=candidates.find(c=>/^https?:/i.test(c.url) && !blocked(c.url) && c.type==='dash');
    const result=candidate ? await verifyHls(candidate.url,h) : dash ? await verifyDash(dash.url,h) : 'no-eligible-hls';
    const summary = candidates.map(c => {
      let hostClass='-', hostName='-', pathClass='-', wrapped='none';
      try {
        const u = new URL(c.url);
        hostName = u.hostname.replace(/[^a-z0-9.-]/gi,'').slice(0,100);
        hostClass = /(?:^|\.)vidstuck\.cc$/i.test(u.hostname) ? 'vidstuck' : /(?:^|\.)nxsha\.space$/i.test(u.hostname) ? 'nxsha' : /(?:^|\.)zxcstream-mirror\.vercel\.app$/i.test(u.hostname) ? 'mirror' : 'other';
        pathClass = /proxy|stream|manifest|playlist/i.test(u.pathname) ? 'proxy-like' : 'other';
        for (const k of ['url','u','target','src','link']) {
          const v = u.searchParams.get(k);
          if (v && /^https?:\/\//i.test(v)) wrapped = blocked(v) ? 'excluded' : 'direct-url';
        }
      } catch { /* opaque URL */ }
      return { type:String(c.type||'unknown').replace(/[^a-z0-9_-]/gi,'').slice(0,16), shape: /^https?:/i.test(c.url) ? (blocked(c.url) ? 'excluded-host' : 'absolute') : c.url.startsWith('/') ? 'relative' : c.url ? 'opaque' : 'empty', hostClass, hostName, pathClass, wrapped, ext: /\.mpd(?:[?#]|$)/i.test(c.url) ? 'mpd' : /\.m3u8(?:[?#]|$)/i.test(c.url) ? 'm3u8' : 'other' };
    });
    return `${item.id}/${server} sources=200 links=${candidates.length} hosts=${summary.map(x=>x.hostName+":"+x.type).join("|")} result=${typeof result==='object'?JSON.stringify(result):result} ms=${Date.now()-time}`;
  } catch(e) { return `${item.id}/${server} error=${e.name} ms=${Date.now()-time}`; }
}
for (let i=0;i<cases.length;i+=2) {
  const results=await Promise.all(cases.slice(i,i+2).flatMap(item=>servers.map(server=>test(item,server))));
  console.log(`::notice title=ZxcHindiTen::${JSON.stringify(results).replace(/%/g,'%25')}`);
}
