// Public examples only. Do not log stream URLs, tokens, headers or payloads.
const cases=[{name:'example-movie',code:'mzfdFOguU87x'},{name:'example-multi',code:'fea967f75055'}];
for(const c of cases){
 const start=Date.now();
 try{
  const res=await fetch('https://vidara.to/api/stream',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',Referer:'https://vidara.to/',Origin:'https://vidara.to'},body:JSON.stringify({filecode:c.code,device:'web'}),signal:AbortSignal.timeout(10000)});
  const json=await res.json().catch(()=>null);const raw=json?.streaming_url;
  let manifest=null;
  if(typeof raw==='string'){
   const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)throw new Error('unsafe url');
   const m=await fetch(u,{headers:{Referer:'https://vidara.to/',Origin:'https://vidara.to'},signal:AbortSignal.timeout(10000)});
   const text=await m.text();const lines=text.split(/\r?\n/).filter(l=>/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(l));
   manifest={status:m.status,isHls:text.trimStart().startsWith('#EXTM3U'),audio:lines.map(l=>({lang:/\bLANGUAGE="([^"]+)"/i.exec(l)?.[1]||null,name:/\bNAME="([^"]+)"/i.exec(l)?.[1]||null}))};
  }
  console.log('::notice title=VidaraResearch::'+JSON.stringify({name:c.name,status:res.status,hasStream:!!raw,manifest,ms:Date.now()-start}));
 }catch(e){console.log('::notice title=VidaraResearch::'+JSON.stringify({name:c.name,error:e.name,ms:Date.now()-start}));}
}
