// Research-only status probes. No external source or library is installed into Elfura.
const probes = [
 {name:'AnimeDekho home',url:'https://animedekho.app/'},
 {name:'AnimeDekho Solo Leveling',url:'https://animedekho.app/serie/solo-leveling-hindi/'},
 {name:'AnimeDekho search',url:'https://animedekho.app/?s=solo+leveling'},
 {name:'MovieBlast origin',url:'https://app.cloud-mb.xyz/'},
 {name:'CineFreak origin',url:'https://cinefreak.nl/'},
 {name:'Zephyrix example',url:'https://play.zephyrix.org/video/64c32b8eb5304d80ba093227975ece13'},
];
await Promise.all(probes.map(async ({name,url})=>{const start=Date.now();try {const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36',Accept:'text/html,application/json;q=0.9,*/*;q=0.8'},redirect:'follow',signal:AbortSignal.timeout(15000)});const body=(await r.text()).slice(0,300000);const result={name,status:r.status,ms:Date.now()-start,finalHost:new URL(r.url).hostname,bodySize:body.length,challenge:/just a moment|cf-chl-|checking your browser/i.test(body),hls:body.includes('#EXTM3U'),titleTag:(/<title[^>]*>([^<]*)/i.exec(body)?.[1]||'').slice(0,100)};console.log('::notice title=ProviderSurface::'+JSON.stringify(result).replace(/%/g,'%25'));}catch(e){console.log('::notice title=ProviderSurface::'+JSON.stringify({name,error:e.name,ms:Date.now()-start}));}}));
