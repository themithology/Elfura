// Real runner transport diagnostics. Never print response bodies or signed URLs.
import https from 'node:https';

const origin='https://greyboxtv.duckdns.org';
const endpoint=origin+'/api/player/sources?media=tv&id=71446&season=1&episode=1';
const ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
async function probe(encoding){
  const item={encoding,ms:0}; const start=Date.now();
  await new Promise(resolve=>{
    let done=false;
    const finish=()=>{if(done)return;done=true; item.ms=Date.now()-start;resolve();};
    const req=https.get(endpoint,{headers:{'User-Agent':ua,Accept:'application/json, text/plain, */*',Referer:origin+'/',Origin:origin,'Accept-Encoding':encoding},timeout:15000},res=>{
      item.status=res.statusCode;
      item.contentEncoding=res.headers['content-encoding']||'none';
      item.contentLength=Number(res.headers['content-length']||0);
      item.transferEncoding=res.headers['transfer-encoding']||'none';
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes<=2_000_000)chunks.push(chunk);else res.destroy();});
      res.on('end',()=>{item.bytes=bytes;item.complete=res.complete;if(item.contentEncoding==='none')try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));item.rows=Array.isArray(data.sources)?data.sources.length:0;}catch{item.json='invalid';}finish();});
      res.on('error',e=>{item.bytes=bytes;item.complete=res.complete;item.error=e.code||e.name;finish();});
      res.on('aborted',()=>{item.bytes=bytes;item.complete=res.complete;item.aborted=true;finish();});
    });
    req.on('timeout',()=>{item.error='timeout';req.destroy();finish();});
    req.on('error',e=>{item.error=e.code||e.name;finish();});
  });
  return item;
}
for (const encoding of ['identity','gzip, deflate']) console.log('::notice title=Greybox transport::'+JSON.stringify(await probe(encoding)));
