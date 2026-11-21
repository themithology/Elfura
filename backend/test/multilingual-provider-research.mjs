// Network-dependent investigation only: never print stream URLs or credentials.
import {extractManifestAudioLangs} from '../../dist/backend/relay.js';
const headers={'User-Agent':'Mozilla/5.0','X-Requested-With':'NetmirrorNewTV v1.0',Accept:'application/json'};
const report=[];
async function get(url,h=headers) {
 const res=await fetch(url,{headers:h,signal:AbortSignal.timeout(6500)});
 if(!res.ok) throw Error('http-'+res.status);
 return res;
}
let base='https://tv.imgcdn.kim';
try {
 const d=await (await get('https://mobiledetects.com/checknewtv.php')).json();
 const decoded=Buffer.from(String(d.token_hash??''),'base64').toString('utf8').trim();
 if(new URL(decoded).protocol==='https:')base=decoded;
} catch{}
for(const sample of [{title:'Stranger Things',season:1,episode:1},{title:'Fight Club'}, {title:'Avengers: Endgame'}]) {
 for(const service of ['nf','pv','hs']) {
  const row={sample:sample.title,service};
  try {
   const reqHeaders={...headers,Ott:service};
   const search=await (await get(base+'/newtv/search.php?'+new URLSearchParams({s:sample.title,t:String(Date.now())}),reqHeaders)).json();
   const normalize=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]/g,'');
   const matches=(search.searchResult??[]).filter(x=>normalize(x.t)===normalize(sample.title));
   row.exactMatches=matches.length;
   if(matches.length!==1){report.push(row);continue;}
   let id=matches[0].id;
   if(sample.season) {
    const post=await (await get(base+'/newtv/post.php?'+new URLSearchParams({id}),reqHeaders)).json();
    row.seasonCount=Array.isArray(post.season)?post.season.length:0;
    const season=(post.season??[]).find(s=>/^(?:season\s*0?1|s0?1|1)$/i.test(String(s.s??'').trim()));
    if(!season){report.push(row);continue;}
    const data=season.selected?post:await (await get(base+'/newtv/episodes.php?'+new URLSearchParams({id:season.id}),reqHeaders)).json();
    const ep=(data.episodes??[]).find(e=>Number(e.ep)===sample.episode||e.info?.some(x=>/^e0?1$/i.test(String(x))));
    if(!ep){report.push(row);continue;}id=ep.id;
   }
   const play=await (await get(base+'/newtv/player.php?'+new URLSearchParams({id}),reqHeaders)).json();
   row.hasStream=typeof play.video_link==='string';
   if(row.hasStream){
    const u=new URL(play.video_link);row.protocol=u.protocol; row.extension=u.pathname.split('.').pop();
    if(u.protocol==='https:'){
     const response=await get(u,{...headers,Referer:play.referer||'https://net52.cc',Origin:'https://net52.cc'});
     const text=await response.text();row.manifest=text.startsWith('#EXTM3U');
     row.languages=extractManifestAudioLangs(text);row.variants=(text.match(/#EXT-X-STREAM-INF:/g)??[]).length;
     row.audioRenditions=(text.match(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO/gi)??[]).length;
     row.codecs=[...new Set([...text.matchAll(/CODECS="([^"]+)"/g)].map(m=>m[1]))];
    }
   }
  }catch(e){row.error=String(e.message??e).replace(/https?:\/\/\S+/g,'[url]').slice(0,80);}
  report.push(row);
 }
}
console.log('::notice title=Multilingual provider research::'+JSON.stringify(report));
// A second candidate: resolve a TMDB movie to a direct HLS manifest. HTML is
// consulted only on the server; no embed URL would be returned to the player.
const cineverse=[];
for(const [title,id,kind] of [['Avengers: Endgame',299534,'movie'],['Fight Club',550,'movie'],['Dune',438631,'movie'],['Breaking Bad S1E1',1396,'tv'],['Breaking Bad S1E2',1396,'tv2']]) {
 const row={title};
 try {
  const tv=kind.startsWith('tv');
  const u=`https://rozgarlelo.modiplay.xyz/embed/tmdb/${tv?'tv':kind}?id=${id}${tv?`&season=1&episode=${kind==='tv2'?2:1}`:''}`;
  const h={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',Referer:'https://m1.multimovies.courses/'};
  const a=await get(u,h), html=await a.text();
  const iframe=html.match(/<iframe[^>]+src=["']([^"']+)/i)?.[1]?.replace(/&amp;/g,'&');
  if(!iframe)throw Error('no player reference');
  const playerUrl=new URL(iframe,a.url).toString();
  row.playerSameOrigin=new URL(playerUrl).origin===new URL(u).origin;
  const b=await get(playerUrl,{...h,Referer:u}),script=await b.text();
  const raw=script.match(/(?:var|let|const)\s+src\s*=\s*["']([^"']*stream_proxy\.php[^"']*)["']/i)?.[1];
  if(!raw)throw Error('no direct manifest');
  const manifestUrl=new URL(raw.replace(/\\\//g,'/').replace(/&amp;/g,'&'),b.url).toString();
  row.manifestSameOrigin=new URL(manifestUrl).origin===new URL(u).origin;
  row.streamKey=(await import('node:crypto')).createHash('sha256').update(new URL(manifestUrl).searchParams.get('url')??'').digest('hex').slice(0,12);
  const manifest=await (await get(manifestUrl,{...h,Referer:playerUrl})).text();
  row.manifest=manifest.trimStart().startsWith('#EXTM3U');row.languages=extractManifestAudioLangs(manifest);
  row.variants=(manifest.match(/#EXT-X-STREAM-INF:/g)??[]).length;
  row.codecs=[...new Set([...manifest.matchAll(/CODECS="([^"]+)"/g)].map(m=>m[1]))];
  const lines=manifest.split(/\r?\n/);const at=lines.findIndex(l=>l.startsWith('#EXT-X-STREAM-INF:'));
  const child=lines.slice(at+1).find(l=>l.trim()&&!l.startsWith('#'));
  if(child){
   const cu=new URL(child,manifestUrl);const childRes=await get(cu,{...h,Referer:playerUrl});const body=await childRes.text();
   const segment=body.split(/\r?\n/).find(l=>l.trim()&&!l.startsWith('#'));
   row.childOk=body.trimStart().startsWith('#EXTM3U');
   if(segment){const seg=new URL(segment,cu);const r=await fetch(seg,{headers:{...h,Referer:playerUrl,Range:'bytes=0-1023'},signal:AbortSignal.timeout(8000)});row.segmentStatus=r.status;await r.body?.cancel();}
  }
 } catch(e) {row.error=String(e.message??e).replace(/https?:\/\/\S+/g,'[url]').slice(0,80);}
 cineverse.push(row);
}
console.log('::notice title=Cineverse research::'+JSON.stringify(cineverse));
