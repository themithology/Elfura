const log=(a)=>console.log('::notice title=AnimeCoverage::'+JSON.stringify(a).replace(/%/g,'%25'));
const base='https://animesalttv.to', ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/137.0.0.0 Safari/537.36';
for(const [title,s,e] of [['Jujutsu Kaisen',1,1],['Demon Slayer: Kimetsu no Yaiba',1,1],['Solo Leveling',1,1],['Attack on Titan',1,1],['Naruto',1,1],['One Piece',1,1],['Chainsaw Man',1,1],['Death Note',1,1],['Jujutsu Kaisen',2,1]]){
 const start=Date.now();try{
 let search=await fetch(base+'/wp-json/wp/v2/anime?search='+encodeURIComponent(title)+'&per_page=20&_fields=id,slug,title,link',{headers:{'User-Agent':ua},signal:AbortSignal.timeout(10000)});let items=await search.json();let norm=s=>s.toLowerCase().replace(/&#038;|&amp;/g,'and').replace(/[^a-z0-9]+/g,'');let matches=items.filter(x=>norm(x.title?.rendered||'')===norm(title));
 if(matches.length!==1){log({title,s,e,step:'search',status:search.status,matches:matches.length,returned:items.map(x=>x.title?.rendered).slice(0,8)});continue}
 const slug=matches[0].slug;if(!/^[a-z0-9-]+$/.test(slug))throw Error('invalid slug');const ep=await fetch(`${base}/episode/${slug}-${s}x${e}/`,{headers:{'User-Agent':ua},signal:AbortSignal.timeout(10000)});const html=await ep.text();const ids=[...html.matchAll(/https?:\/\/player\.nekomux\.com\/episode\/(\d+)/gi)].map(m=>m[1]);
 if(!ids.length){log({title,s,e,step:'episode',status:ep.status,ms:Date.now()-start});continue}
 const p=await fetch(`https://player.nekomux.com/episode/${ids[0]}/source`,{headers:{'User-Agent':ua,Referer:`https://player.nekomux.com/episode/${ids[0]}`},signal:AbortSignal.timeout(10000)});const d=await p.json();if(!d.url){log({title,s,e,step:'source',status:p.status,ms:Date.now()-start});continue}
 const m=await fetch(d.url,{headers:{'User-Agent':ua,Referer:'https://player.nekomux.com/'},signal:AbortSignal.timeout(10000)});const text=await m.text();const aud=text.split(/\r?\n/).filter(l=>/^#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(l));log({title,s,e,status:m.status,langs:aud.map(l=>l.match(/LANGUAGE="([^"]+)"/i)?.[1]).filter(Boolean),variants:(text.match(/#EXT-X-STREAM-INF/g)||[]).length,ms:Date.now()-start});
 }catch(err){log({title,s,e,error:err.name,ms:Date.now()-start})}
}
