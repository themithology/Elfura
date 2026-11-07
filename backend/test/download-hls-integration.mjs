import {createBackendServer} from '../../dist/backend/index.js';
import {loadBackendConfig} from '../../dist/backend/config.js';
import {sealStreamTicket} from '../../dist/backend/security.js';
import {issueChoice} from '../../dist/backend/download-hls.js';
import {execFileSync,spawnSync} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const ff=process.env.ELFURA_TEST_FFMPEG;if(!ff)throw Error('Set ELFURA_TEST_FFMPEG');
process.env.ELFURA_FFMPEG_PATH=ff;process.env.ELFURA_EXPERIMENTAL_HLS_DOWNLOADS='1';process.env.NODE_ENV='test';process.env.ELFURA_ALLOW_LOOPBACK_TEST='1';
const tmp=mkdtempSync(path.join(tmpdir(),'hls-dl-test-'));
const gen=(args)=>execFileSync(ff,['-hide_banner','-loglevel','error',...args],{stdio:'pipe',maxBuffer:20_000_000});
for(const [h,w] of [[90,160],[180,320]]) gen(['-f','lavfi','-i',`color=c=blue:s=${w}x${h}:r=10`,'-t','4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mpegts',path.join(tmp,`v${h}.ts`)]);
for(const [lang,freq,offset] of [['hi',440,0],['en',880,0],['late',660,1],['far',330,20]])gen(['-f','lavfi','-i',`sine=frequency=${freq}:sample_rate=44100`,'-t','4','-c:a','aac','-output_ts_offset',String(offset),'-f','mpegts',path.join(tmp,lang+'.ts')]);
const playlist=f=>`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${f}.ts\n#EXT-X-ENDLIST\n`;
const master='#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Hindi",LANGUAGE="hi",DEFAULT=YES,AUTOSELECT=YES,URI="hi.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=160x90,AUDIO="audio"\nv90.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=320x180,AUDIO="audio"\nv180.m3u8\n';
let requests=[];
const upstream=http.createServer((req,res)=>{const p=(req.url||'').split('?')[0];requests.push(p);if(p==='/short.m3u8')res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'}).end('#EXTM3U\n#EXTINF:1,\nhi.ts\n#EXT-X-ENDLIST\n');else if(p==='/encrypted.m3u8')res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'}).end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:4,\nv90.ts\n#EXT-X-ENDLIST\n');else if(p==='/master.m3u8')res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'}).end(master);else if(/^\/(v90|v180|hi|en|late|far)\.m3u8$/.test(p))res.writeHead(200,{'content-type':'application/vnd.apple.mpegurl'}).end(playlist(p.slice(1,-5)));else if(/^\/(v90|v180|hi|en|late|far)\.ts$/.test(p))res.writeHead(200,{'content-type':'video/mp2t'}).end(readFileSync(path.join(tmp,p.slice(1))));else res.writeHead(404).end();});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const {server,cfg,registry}=createBackendServer({...loadBackendConfig(),isProd:false,requireToken:false});const u=`http://127.0.0.1:${upstream.address().port}/master.m3u8`;const source={id:'source-1:1',sourceId:'source-1',label:'Source 1',type:'hls',url:`/api/v1/stream?t=${sealStreamTicket(cfg.secret,{u,k:'m'})}`,quality:'auto',audioTracks:[],subtitles:[]};registry.resolvePlayback=async()=>({media:{title:'Fixture',year:'2024'},primary:source,sources:[source]});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
try {
 const search=await fetch(base+'/dl/api/resolve?type=movie&tmdb=550').then(r=>r.json());assert.equal(search.items.length,4,JSON.stringify(search));
 for(const [lang,quality,freq] of [['Hindi','90p',440],['English','180p',880]]){
  const item=search.items.find(x=>x.languages.includes(lang)&&x.quality===quality);assert(item);requests=[];
  const meta=await fetch(base+'/dl/api/file?t='+encodeURIComponent(item.ticket)).then(r=>r.json());assert.equal(meta.quality,quality);
  const response=await fetch(base+'/dl/go?t='+encodeURIComponent(item.ticket));assert.equal(response.status,200);const disposition=response.headers.get('content-disposition');assert(disposition.includes(`Fixture 2024 - ${quality} - ${lang} - TheOGPirateBot.online.mp4`),disposition);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(4,8).toString(),'ftyp');assert(requests.includes(lang==='Hindi'?'/hi.ts':'/en.ts'));assert(requests.includes(quality==='90p'?'/v90.ts':'/v180.ts'));
  const file=path.join(tmp,lang+'.mp4');writeFileSync(file,bytes);const pcm=gen(['-i',file,'-map','0:a:0','-f','s16le','-ac','1','-ar','44100','pipe:1']);assert(pcm.length>44100*2*3);
  let crossings=0,prev=0;for(let i=44100;i<88200;i++){const cur=pcm.readInt16LE(i*2);if(prev<=0&&cur>0)crossings++;prev=cur;}assert(Math.abs(crossings-freq)<15,`${lang}: ${crossings} Hz`);
  let probe='';try{execFileSync(ff,['-hide_banner','-i',file],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}catch(e){probe=String(e.stderr);}assert(probe.includes(quality==='90p'?'160x90':'320x180'),probe);
  console.log(`✓ ${lang} ${quality}: ${bytes.length} bytes, valid MP4 decode and ${crossings}Hz selected audio`);
 }
 const tvSearch=await fetch(base+'/dl/api/resolve?type=tv&tmdb=550&season=3&episode=2').then(r=>r.json());
 const tvItem=tvSearch.items.find(x=>x.languages.includes('Hindi')&&x.quality==='90p');assert(tvItem);
 const tvDownload=await fetch(base+'/dl/go?t='+encodeURIComponent(tvItem.ticket));assert.equal(tvDownload.status,200);
 assert(tvDownload.headers.get('content-disposition').includes('Fixture 2024 S03E02 - 90p - Hindi - TheOGPirateBot.online.mp4'));await tvDownload.arrayBuffer();
 console.log('✓ TV filenames include the requested season and episode.');
 const localManifest=name=>`/api/v1/stream?t=${sealStreamTicket(cfg.secret,{u:`http://127.0.0.1:${upstream.address().port}/${name}.m3u8`,k:'m'})}`;
 const choiceFor=audio=>issueChoice(cfg.secret,{name:'Sync Fixture',quality:'90p',size:'',languages:['English'],kind:'HLS',video:localManifest('v90'),audio:localManifest(audio)});
 const lateTicket=choiceFor('late');assert.equal((await fetch(base+'/dl/api/file?t='+encodeURIComponent(lateTicket))).status,200);
 const lateResponse=await fetch(base+'/dl/go?t='+encodeURIComponent(lateTicket));assert.equal(lateResponse.status,200);const lateFile=path.join(tmp,'sync.mp4');writeFileSync(lateFile,Buffer.from(await lateResponse.arrayBuffer()));
 function firstPts(file,kind){
  const result=spawnSync(ff,['-hide_banner','-loglevel','info','-copyts','-i',file,'-map',`0:${kind}:0`,`-filter:${kind}`,kind==='v'?'showinfo':'ashowinfo',`-frames:${kind}`,'1','-f','null','-'],{encoding:'utf8'});
  const match=result.stderr.match(/pts_time:\s*([\d.-]+)/);assert(match,result.stderr);return Number(match[1]);
 }
 const originalOffset=firstPts(path.join(tmp,'late.ts'),'a')-firstPts(path.join(tmp,'v90.ts'),'v');
 const actualOffset=firstPts(lateFile,'a')-firstPts(lateFile,'v');
 assert(Math.abs(originalOffset-actualOffset)<0.06,`audio offset changed: ${originalOffset} vs ${actualOffset}`);
 console.log(`✓ Separate HLS rendition timestamps preserved: ${originalOffset.toFixed(3)}s → ${actualOffset.toFixed(3)}s.`);
 const farTicket=choiceFor('far');assert.equal((await fetch(base+'/dl/api/file?t='+encodeURIComponent(farTicket))).status,502,'incompatible timestamp clocks must not show download');
 const shortTicket=choiceFor('short');assert.equal((await fetch(base+'/dl/api/file?t='+encodeURIComponent(shortTicket))).status,502,'mismatched durations must not show download');
 console.log('✓ Large audio/video timestamp and duration mismatches rejected before download.');
 const invalid=await fetch(base+'/dl/go?t=invalid');assert.equal(invalid.status,410);
 const encrypted=`/api/v1/stream?t=${sealStreamTicket(cfg.secret,{u:`http://127.0.0.1:${upstream.address().port}/encrypted.m3u8`,k:'m'})}`;
 const encryptedTicket=issueChoice(cfg.secret,{name:'Fixture',quality:'Auto',size:'',languages:['Unknown'],kind:'HLS',video:encrypted});
 assert.equal((await fetch(base+'/dl/api/file?t='+encodeURIComponent(encryptedTicket))).status,502,'encrypted HLS should not show the download button');
 assert.equal((await fetch(base+'/dl/go?t='+encodeURIComponent(encryptedTicket))).status,502,'encrypted HLS should fail closed');
 const valid=search.items[0].ticket;process.env.ELFURA_FFMPEG_PATH='/bin/false';
 assert.equal((await fetch(base+'/dl/go?t='+encodeURIComponent(valid))).status,502,'converter exit must not report a valid download');
 process.env.ELFURA_EXPERIMENTAL_HLS_DOWNLOADS='0';assert.equal((await fetch(base+'/dl/api/resolve?type=movie&tmdb=550')).status,503);
 console.log('✓ Encrypted playlists, failing converter, invalid tickets and disabled mode fail safely.');
} finally {await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));rmSync(tmp,{recursive:true,force:true});}
