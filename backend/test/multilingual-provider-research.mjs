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
