// Public surface research only. No tokens, signed URLs or page contents are logged.
const root='https://bingr.one';
const paths=['/','/watch/movie/872585','/watch/movie/299534','/watch/tv/93405/1/1','/watch/tv/85937/1/1'];
for (const path of paths) {
  try {
    const r=await fetch(root+path,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0 Safari/537.36'},signal:AbortSignal.timeout(15000)});
    const html=(await r.text()).slice(0,2_000_000);
    let rsc='';
    for(const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\[\s\S])*)"\]\)/g)) { try {rsc+=JSON.parse('"'+m[1]+'"');} catch {} }
    const labels=['Prism','Edge','Nimbus','Citadel','Flux','Pulse','Volt'].filter(x=>new RegExp('\\b'+x+'\\b','i').test(html+' '+rsc));
    console.log(`::notice title=BingrSurface::${JSON.stringify({path,status:r.status,host:new URL(r.url).hostname,bytes:html.length,labels,embeddedPayload:/v1\.[A-Za-z0-9_-]{60,}/.test(rsc),sessionToken:/"token":"[^"]+"/.test(rsc),scripts:[...html.matchAll(/<script[^>]+src="([^"]+)/gi)].length}).replace(/%/g,'%25')}`);
  } catch(e) {console.log(`::notice title=BingrSurface::${JSON.stringify({path,error:e.name,cause:e.cause?.code})}`)}
}
