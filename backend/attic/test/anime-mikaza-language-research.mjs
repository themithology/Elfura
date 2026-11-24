// Research only: language requests and manifest/file liveness; no raw media URLs,
// cookies or payloads are logged. Provider language labels are not audio proof.
import {createHash} from 'node:crypto';
import {anilistIdForTmdb} from '../../dist/backend/sources/anime-db.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
const origin='https://mikaza.buzz',ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const samples=[{name:'Naruto',id:'46260'},{name:'Jujutsu Kaisen',id:'95479'},{name:'Attack on Titan',id:'1429'},{name:'One Piece',id:'37854'},{name:'Demon Slayer',id:'85937'}];
const rows=[];
for(const s of samples){const row={title:s.name};try{
 const mapping=await anilistIdForTmdb(s.id);row.mapped=!!mapping?.anilistId;row.lanes=[];
 if(mapping?.anilistId){
  for(const requested of ['eng','jpn','hin']){
   const item={requested};try{
    const embed=`${origin}/embed/haiku/ani/${mapping.anilistId}/1/${requested}`;
    const r=await fetch(embed,{redirect:'error',headers:{'User-Agent':ua,Referer:origin+'/'},signal:AbortSignal.timeout(9000)});item.embed=r.status;
    const html=await readBoundedText(r,1000000),ref=html?.match(/resolve\s*:\s*"([^"\\]{1,8192})"/)?.[1];
    if(ref){const u=new URL(ref,origin);if(u.protocol!=='https:'||!isSafeUpstreamUrl(u.href))throw Error('unsafe');
     const response=await fetch(u,{redirect:'error',headers:{'User-Agent':ua,Accept:'application/json',Referer:embed},signal:AbortSignal.timeout(9000)});item.resolve=response.status;
     const data=JSON.parse((await readBoundedText(response,200000))??'null');item.declared=typeof data?.source?.resolvedLanguage==='string'?data.source.resolvedLanguage.slice(0,20):null;
     const src=typeof data?.src==='string'?new URL(data.src,origin):null;
     if(src&&src.protocol==='https:'&&isSafeUpstreamUrl(src.href)){
      item.hasMedia=true;item.urlFingerprint=createHash('sha256').update(src.href).digest('hex').slice(0,12);item.subtitleCount=Array.isArray(data.tracks)?data.tracks.length:0;
      const cand={key:src.href,url:src.href,type:'mp4',quality:'auto',headers:{}};const checked=await verifyAndFilterCandidatesDetailed([cand],AbortSignal.timeout(6000));item.alive=checked.verifiedAliveCount;
     }else item.hasMedia=false;
    }
   }catch(e){item.error=e?.cause?.code??e.name;}row.lanes.push(item);
  }
 }
}catch(e){row.error=e?.cause?.code??e.name;}rows.push(row);}
console.log('::notice title=Anime language lane research::'+JSON.stringify(rows));
