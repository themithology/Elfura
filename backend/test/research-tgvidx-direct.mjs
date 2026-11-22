// Research: reproduce the published browser protocol with ordinary HTTP and
// test returned media without logging signed URLs or credentials.
const base='https://tgvidx.lovable.app';
const fn='/_serverFn/ff183e1ad6d02c4c08e8e73151c60e5dcc23f8f4c9db53eac9d271b87a56e121';
const notice=(t,v)=>console.log(`::notice title=${t}::${JSON.stringify(v).replace(/%/g,'%25').replace(/\n/g,'%0A').slice(0,9000)}`);
const key='tGfL1x#9vQ'; // public client-side XOR obfuscation, not authorization
function decode(p){const bytes=Buffer.from([...p].reverse().join(''),'base64');for(let i=0;i<bytes.length;i++)bytes[i]^=key.charCodeAt(i%key.length)^(i&255);return JSON.parse(bytes.toString('utf8'))}
async function boundedRead(r,limit=8192){const reader=r.body?.getReader();if(!reader)return '';let parts=[],length=0;try{while(length<limit){const {done,value}=await reader.read();if(done)break;parts.push(value.subarray(0,limit-length));length+=value.length}}finally{await reader.cancel().catch(()=>{})}return Buffer.concat(parts).toString('utf8')}
for(const [type,id,s,e] of [['movie','1303331'],['movie','550'],['tv','1396','1','1']]){
 const path=type==='movie'?`/api/m/${id}`:`/api/tv/${id}/${s}/${e}`;
 const request={t:{t:10,i:0,p:{k:['data'],v:[{t:10,i:1,p:{k:['path'],v:[{t:1,s:path}]},o:0}]},o:0},f:127,m:[]};
 try{const r=await fetch(base+fn,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','x-tsr-serverfn':'true','Origin':base,'Referer':base+'/'},body:JSON.stringify(request),signal:AbortSignal.timeout(25000)});if(!r.ok){notice('TGVIDX direct '+path,{status:r.status});continue}const o=await r.json();const raw=o?.p?.v?.[0]?.p?.v?.[0]?.s;const data=decode(raw);const samples=[];
 for(const x of data.links||[]){const server=String(x.server||'');if(/pirate/i.test(server))continue;const u=new URL(x.url,base);let outcome={server,host:u.hostname,path:u.pathname,type:x.type};try{const res=await fetch(u,{headers:{Referer:base+'/',Origin:base},signal:AbortSignal.timeout(8000)});const head=res.ok?await boundedRead(res):'';if(!res.ok)await res.body?.cancel();outcome={...outcome,status:res.status,contentType:res.headers.get('content-type'),hls:head.includes('#EXTM3U'),dash:/<MPD[\s>]/i.test(head),headBytes:head.length};}catch(err){outcome.error=err.name}samples.push(outcome);}
 notice('TGVIDX direct '+path,{status:r.status,ok:data.ok,id:data.tmdb_id,type:data.type,count:data.links?.length,samples});
 }catch(err){notice('TGVIDX direct '+path,{error:err.name,cause:err.cause?.code,message:String(err.message).slice(0,100)})}
}
