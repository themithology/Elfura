// Research-only probes of endpoints documented in public Nuvio provider implementations.
const cases=[
 ['vidmody Dune','https://vidmody.com/vs/tt15239678','https://vidmody.com/'],
 ['vidmody Oppenheimer','https://vidmody.com/vs/tt15398776','https://vidmody.com/'],
 ['vidmody Interstellar','https://vidmody.com/vs/tt0816692','https://vidmody.com/'],
 ['vidmody Breaking Bad S1E1','https://vidmody.com/vs/tt0903747/s1/e01','https://vidmody.com/'],
 ['vidlove Dune ipcloud','https://api.vidlove.cc/movie?id=693134&mode=json&sources=ipcloud','https://player.vidlove.cc/'],
 ['vidlove TV warden','https://api.vidlove.cc/tv?id=93405&season=1&episode=1&mode=json&sources=warden','https://player.vidlove.cc/'],
];
await Promise.all(cases.map(async ([name,url,ref])=>{const start=Date.now();try{const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36',Referer:ref,Range:'bytes=0-65535'},signal:AbortSignal.timeout(16000)});const reader=r.body?.getReader();let parts=[],size=0;if(reader){try{while(size<65536){let x=await reader.read();if(x.done)break;parts.push(x.value);size+=x.value.length}}finally{await reader.cancel().catch(()=>{})}}const body=Buffer.concat(parts).subarray(0,65536).toString('utf8');const audio=[...body.matchAll(/^#EXT-X-MEDIA:.*TYPE=AUDIO.*$/gim)].map(x=>({lang:/LANGUAGE="([^"]+)"/i.exec(x[0])?.[1]||null,name:/NAME="([^"]+)"/i.exec(x[0])?.[1]||null}));let json=null;try{let j=JSON.parse(body);json={keys:Object.keys(j).slice(0,12),sourceCount:Array.isArray(j.sources)?j.sources.length:null}}catch{};console.log('::notice title=NuvioHls::'+JSON.stringify({name,status:r.status,host:new URL(r.url).hostname,contentType:r.headers.get('content-type'),hls:body.trimStart().startsWith('#EXTM3U'),audio,json,ms:Date.now()-start}));}catch(e){console.log('::notice title=NuvioHls::'+JSON.stringify({name,error:e.name,code:e.cause?.code||null,ms:Date.now()-start}));}}));
