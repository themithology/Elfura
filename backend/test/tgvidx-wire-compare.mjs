// Research: compare real TGVIDX inventory, HLS/DASH and Elfura relay bytes.
// Raw URLs, media, keys and credentials are not printed or persisted.
import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {createSource17Adapter,decodeTgvidxResponse} from '../../dist/backend/sources/source17.js';
import {sealStreamTicket,openStreamTicket} from '../../dist/backend/security.js';
import {resolveHlsChildUrl} from '../../dist/backend/relay.js';
import crypto from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const orig=globalThis.fetch, names=new Map(),secret='fixture-only-wire-analysis-secret-0123456789';
globalThis.fetch=async(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);const r=await orig(input,init);if(u.hostname==='tgvidx.lovable.app'&&u.pathname.includes('/_serverFn/'))try{const data=decodeTgvidxResponse(await r.clone().text());for(const row of data?.links||[])if(typeof row.url==='string')names.set(new URL(row.url,'https://tgvidx.lovable.app').href,row.server)}catch{}return r};
const cfg=loadBackendConfig({ELFURA_SECRET:secret,OPENSUBTITLES_ENABLED:'0'}),{server}=createBackendServer({...cfg,isProd:false,requireToken:false});
const notice=(t,x)=>console.log(`::notice title=${t}::${JSON.stringify(x).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,10000)}`);
const timing=async(url,opts={})=>{const start=Date.now();const res=await fetch(url,{...opts,signal:AbortSignal.timeout(18000)});const body=Buffer.from(await res.arrayBuffer());return {status:res.status,type:(res.headers.get('content-type')||'').split(';')[0],url:res.url||String(url),ms:Date.now()-start,body}};
const attrs=(s,key)=>s.match(new RegExp(`(?:^|[:,])${key}=(?:"([^"]*)"|([^,\\s]*))`,'i'))?.slice(1).find(x=>x!==undefined)||'';
function describe(text){return {kind:text.trimStart().startsWith('#EXTM3U')?'hls':text.includes('<MPD')?'dash':'unknown',codecs:[...new Set([...text.matchAll(/\b(?:CODECS|codecs)=["']([^"']+)["']/g)].map(x=>x[1]))].slice(0,12),audio:[...text.matchAll(/^#EXT-X-MEDIA:.*TYPE=AUDIO.*$/gim)].map(x=>({name:attrs(x[0],'NAME'),language:attrs(x[0],'LANGUAGE'),default:attrs(x[0],'DEFAULT')})).slice(0,8),encrypted:[...text.matchAll(/^#EXT-X-KEY:.*$/gim)].map(x=>({method:attrs(x[0],'METHOD'),format:attrs(x[0],'KEYFORMAT'),iv:!!attrs(x[0],'IV')})).slice(0,4),variantCount:(text.match(/^#EXT-X-STREAM-INF/gm)||[]).length,mediaSegments:(text.match(/^#EXTINF/gm)||[]).length,hasMap:!!text.match(/^#EXT-X-MAP/gm),hasByteRange:!!text.match(/^#EXT-X-BYTERANGE/gm)}}
function findChildren(text){const lines=text.split(/\r?\n/).map(x=>x.trim());const out=[];for(let i=0;i<lines.length;i++)if(/^#EXT-X-STREAM-INF:/i.test(lines[i])){const next=lines.slice(i+1).find(x=>x&&!x.startsWith('#'));if(next){out.push({kind:'video',ref:next,desc:lines[i]});break}};const audio=lines.find(x=>/^#EXT-X-MEDIA:/i.test(x)&&/TYPE=AUDIO/i.test(x)&&/DEFAULT=YES/i.test(x))||lines.find(x=>/^#EXT-X-MEDIA:/i.test(x)&&/TYPE=AUDIO/i.test(x));if(audio&&attrs(audio,'URI'))out.push({kind:'audio',ref:attrs(audio,'URI'),desc:audio});return out}
function firstSegment(text){const lines=text.split(/\r?\n/).map(x=>x.trim());let key=null,sequence=Number(lines.find(x=>/^#EXT-X-MEDIA-SEQUENCE:/i.test(x))?.split(':')[1]||0),i=0;for(;i<lines.length;i++){if(/^#EXT-X-KEY:/i.test(lines[i]))key={method:attrs(lines[i],'METHOD'),ref:attrs(lines[i],'URI'),iv:attrs(lines[i],'IV')};if(/^#EXTINF:/i.test(lines[i])){const ref=lines.slice(i+1).find(x=>x&&!x.startsWith('#'));return {ref,key,sequence}}}return null}
function tsSync(buf){for(let i=0;i<Math.min(188,buf.length);i++){if(i+564<buf.length&&[0,188,376,564].every(n=>buf[i+n]===0x47))return i}return null}
function bytesInfo(b){return {bytes:b.length,sha:crypto.createHash('sha256').update(b).digest('hex').slice(0,16),head:b.subarray(0,12).toString('hex'),tsSync:tsSync(b),mp4Box:b.length>=8?b.subarray(4,8).toString('ascii').replace(/[^a-z0-9]/gi,'.'):''}}
const extract=(raw,base)=>{const u=new URL(raw,base);const t=u.searchParams.get('t');return t?openStreamTicket(cfg.secret,t):null};
const temp=mkdtempSync(path.join(os.tmpdir(),'tgvidx-bytes-'));
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const diag=[],result=await createSource17Adapter(()=>true).resolve({type:'tv',tmdbId:'65942',season:1,episode:1,diag});notice('TGVIDX inventory research',{diag,names:result.candidates.map(c=>({name:names.get(c.url),type:c.type}))});
 for(const name of ['TG VIDARA','TG VIDSHARED','TG MAGPIE']){const c=result.candidates.find(x=>names.get(x.url)===name);const row={name,found:!!c};try{if(!c){notice('TGVIDX wire '+name,row);continue}
  const token=sealStreamTicket(cfg.secret,{u:c.url,h:c.headers,k:'m',fp:1});const proxy=base+'/api/v1/stream?t='+encodeURIComponent(token);
  const [direct,relayed]=await Promise.all([timing(c.url,{headers:c.headers}),timing(proxy)]);
  row.master={direct:{status:direct.status,ms:direct.ms,contentType:direct.type,...describe(direct.body.toString('utf8'))},relay:{status:relayed.status,ms:relayed.ms,contentType:relayed.type,...describe(relayed.body.toString('utf8'))}};
  if(c.type==='hls'&&direct.status===200&&relayed.status===200){const children=findChildren(relayed.body.toString('utf8'));row.children=[];
   for(const child of children){const childTicket=extract(child.ref,base);if(!childTicket){row.children.push({kind:child.kind,missingTicket:true});continue}
    const [a,b]=await Promise.all([timing(childTicket.u,{headers:childTicket.h}),timing(new URL(child.ref,base))]);const at=a.body.toString('utf8'),bt=b.body.toString('utf8');const segA=firstSegment(at),segB=firstSegment(bt);const info={kind:child.kind,direct:{status:a.status,ms:a.ms,...describe(at)},relay:{status:b.status,ms:b.ms,...describe(bt)}};
    if(segA?.ref&&segB?.ref){const expected=resolveHlsChildUrl(segA.ref,a.url),ticket=extract(segB.ref,base);info.mapping={sameTarget:ticket?.u===expected,kind:ticket?.k};if(ticket){const [x,y]=await Promise.all([timing(ticket.u,{headers:ticket.h}),timing(new URL(segB.ref,base))]);info.segment={direct:{status:x.status,ms:x.ms,type:x.type,...bytesInfo(x.body)},relay:{status:y.status,ms:y.ms,type:y.type,...bytesInfo(y.body)},identical:x.body.equals(y.body)};
     const k=segA.key;if(k?.method==='AES-128'&&k.ref){const keyRes=await timing(resolveHlsChildUrl(k.ref,a.url),{headers:ticket.h});const iv=k.iv?Buffer.from(k.iv.replace(/^0x/i,'').padStart(32,'0'),'hex'):Buffer.from(BigInt(segA.sequence).toString(16).padStart(32,'0'),'hex');try{const decipher=crypto.createDecipheriv('aes-128-cbc',keyRes.body,iv);const decrypted=Buffer.concat([decipher.update(x.body),decipher.final()]);info.segment.decrypted=bytesInfo(decrypted)}catch(e){info.segment.decryptError=e.name}}
     const data=x.body;const file=path.join(temp,'probe.bin');writeFileSync(file,data);try{const p=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height','-of','json',file],{timeout:8000,stdio:['ignore','pipe','ignore']}).toString());info.segment.ffprobe=p.streams}catch{};
    }}row.children.push(info);
   }
  }
 }catch(e){row.error={name:e.name,message:String(e.message||'').replace(/https?:\/\/\S+/g,'[url]').slice(0,120)}}notice('TGVIDX wire '+name,row)}
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=orig;rmSync(temp,{recursive:true,force:true})}
