// Research only: compare locally generated VidLink tokens with the existing
// external token service against the actual API. Never print tokens, URLs or
// response bodies. Results from this runner are not proof of VPS reachability.
import nacl from 'tweetnacl';
import {installEgressProfile} from '../../dist/backend/egress.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';

const secret=Buffer.from('c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd','hex');
const zero=new Uint8Array(24);
const localToken=id=>{
 const idBytes=Buffer.from(id,'utf8');
 const message=Buffer.alloc(idBytes.length+8);
 idBytes.copy(message);message.writeBigUInt64BE(BigInt(Math.floor(Date.now()/1000)+480),idBytes.length);
 return Buffer.concat([Buffer.from(zero),Buffer.from(nacl.secretbox(message,zero,secret))]).toString('base64url');
};
const reveal=token=>{
 try{const b=Buffer.from(token,'base64url');const p=nacl.secretbox.open(b.subarray(24),b.subarray(0,24),secret);if(!p)return null;const x=Buffer.from(p);if(x.length<=8)return null;return {id:x.subarray(0,-8).toString('utf8'),expiry:Number(x.readBigUInt64BE(x.length-8)),zeroNonce:b.subarray(0,24).equals(Buffer.from(zero))};}catch{return null;}
};
const headers={Accept:'application/json,*/*',Referer:'https://vidlink.pro/',Origin:'https://vidlink.pro','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'};
await installEgressProfile(()=>{});
const samples=[{type:'movie',id:'550'},{type:'movie',id:'936622'},{type:'tv',id:'1396',s:1,e:1},{type:'tv',id:'44006',s:1,e:1}];
for(const x of samples){
 const row={title:`${x.type}/${x.id}${x.type==='tv'?`/${x.s}/${x.e}`:''}`};
 let remoteToken;
 try{const r=await fetch(`https://enc-dec.app/api/enc-vidlink?text=${x.id}`,{signal:AbortSignal.timeout(9000)});row.encHttp=r.status;if(r.ok){const j=await r.json();remoteToken=j?.result;const p=typeof remoteToken==='string'?reveal(remoteToken):null;row.remoteDecodes=!!p;row.remoteIdMatches=p?.id===x.id;row.remoteZeroNonce=p?.zeroNonce??null;row.remoteExpiryOffsetSec=p?Math.round(p.expiry-Date.now()/1000):null;}}catch(e){row.encError=e.name;}
 for(const [mode,token] of [['local',localToken(x.id)],['remote',remoteToken]]){
  if(!token){row[mode]={skipped:true};continue;}
  const out={};row[mode]=out;
  try{
   const path=x.type==='movie'?`/movie/${token}`:`/tv/${token}/${x.s}/${x.e}`;
   const response=await fetch('https://vidlink.pro/api/b'+path,{headers,signal:AbortSignal.timeout(12000)});out.http=response.status;
   if(!response.ok){await response.body?.cancel().catch(()=>{});continue;}
   const data=await response.json();
   const urls=[data?.stream?.playlist,...Object.values(data?.stream?.qualities??{}).map(q=>q?.url),data?.url,...(Array.isArray(data?.streams)?data.streams.map(s=>s?.url):[])].filter(u=>typeof u==='string'&&/^https:\/\//.test(u));
   out.candidates=urls.length;
   const hls=urls.find(u=>/\.m3u8(?:[?#]|$)/i.test(u));
   if(hls){const c={key:'fixture',url:hls,type:'hls',quality:'auto',headers,rank:0};const p=await verifyAndFilterCandidatesDetailed([c],AbortSignal.timeout(7000));out.manifestAlive=p.verifiedAliveCount;out.manifestDead=p.probedDead.size;}
  }catch(e){out.error=e.name;}
 }
 console.log('::notice title=VidLink token experiment::'+JSON.stringify(row));
}
