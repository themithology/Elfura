import assert from 'node:assert/strict';
import {fetchAnimeMultiAudio} from '../../dist/backend/sources/source4.js';
import {refreshNekoSignedUrl,rewriteHlsManifest} from '../../dist/backend/relay.js';
import {openStreamTicket} from '../../dist/backend/security.js';
const oldFetch=globalThis.fetch, root='01M3DWJRA9H8YZPNQBZX1YDEH8', now=Math.floor(Date.now()/1000);let wrongTitle=false,wrongEpisode=false,ambiguous=false,single=false,refreshes=0;
const query={type:'tv',tmdbId:'95479',season:1,episode:1,resolveMetaFallback:async()=>({rawTitle:'Jujutsu Kaisen',originalLanguage:'ja'})};
globalThis.fetch=async input=>{const u=new URL(String(input));
 if(u.hostname==='animesalttv.to'&&u.pathname.includes('/wp-json/'))return Response.json(Array.from({length:ambiguous?2:1},()=>({slug:'jujutsu-kaisen',title:{rendered:'JUJUTSU KAISEN'}})));
 if(u.hostname==='animesalttv.to')return new Response('<iframe src="https://player.nekomux.com/episode/42"></iframe>');
 if(u.hostname==='player.nekomux.com' && u.pathname.endsWith('/source')){refreshes++;return Response.json({ok:true,type:'hls',url:`https://play.nekomux.com/p/newtoken/${now+1200}/5/hls/${root}/master.m3u8`})}
 if(u.hostname==='player.nekomux.com')return new Response(`<title>${wrongTitle?'OTHER SHOW':'JUJUTSU KAISEN'} · S1 E${wrongEpisode?2:1} · Ryomen Sukuna</title>`);
 if(u.hostname==='play.nekomux.com')return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="hi",URI="audio/hi.m3u8"\n'+(single?'':'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",URI="audio/en.m3u8"\n')+'#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="audio"\nv0/index.m3u8\n');
 throw Error('unexpected request');};
try{
 const [cand]=await fetchAnimeMultiAudio(query);assert(cand?.multiAudio);assert.deepEqual(cand.availableAudioLangs,['hi','en']);assert.equal(cand.refreshNekoEpisode,'42');
 wrongTitle=true;assert.deepEqual(await fetchAnimeMultiAudio(query),[]);wrongTitle=false;wrongEpisode=true;assert.deepEqual(await fetchAnimeMultiAudio(query),[]);wrongEpisode=false;ambiguous=true;assert.deepEqual(await fetchAnimeMultiAudio(query),[]);ambiguous=false;single=true;assert.deepEqual(await fetchAnimeMultiAudio(query),[]);single=false;
 const secret=Buffer.alloc(32,1);const manifest=rewriteHlsManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nv0/index.m3u8\n',cand.url,cand.headers,secret,'/api/v1/stream',undefined,{forceProxy:true,nekoEpisode:'42'});const url=manifest.split('\n').find(x=>x.startsWith('/api/'));const ticket=openStreamTicket(secret,new URL(url,'https://local.example').searchParams.get('t'));assert.equal(ticket.nr,'42');assert.equal(ticket.fp,1);
 const old=`https://play.nekomux.com/p/expired/${now-1}/5/hls/${root}/v0/seg_0.ts`;const refreshed=await refreshNekoSignedUrl(old,'42');assert.match(refreshed,/\/p\/newtoken\//);assert(refreshed.endsWith(`/5/hls/${root}/v0/seg_0.ts`));const n=refreshes;await refreshNekoSignedUrl(old,'42');assert.equal(refreshes,n,'refresh must be shared');
 const other=old.replace(root,'01M3DWJRA9H8YZPNQBZX1YDEH9');assert.equal(await refreshNekoSignedUrl(other,'42'),other,'must not substitute a different media identity');
 assert.equal(await refreshNekoSignedUrl('https://evil.example/p/expired/1/a','42'),'https://evil.example/p/expired/1/a');
 console.log('✓ Source 4 validates title, episode and genuine audio tracks; signed HLS refresh remains scoped.');
}finally{globalThis.fetch=oldFetch}
