// Research-only availability check using catalogue IDs, not a source adapter.
// No URLs, response bodies, provider secrets or media are logged.
const samples=[['Naruto','naruto-fz9'],['One Piece','one-piece-fznhz']];
const roots=['https://anidap.se/api/anime/servers','https://chad.anidap.lol/rest/api/servers'];
for(const root of roots)for(const [title,slug] of samples){
 const row={service:new URL(root).hostname,title};
 try{
  const u=new URL(root);u.searchParams.set('id',slug);u.searchParams.set(root.includes('/rest/')?'epNum':'ep','1');
  const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json',Referer:new URL(root).origin+'/'}});row.status=r.status;
  if(r.ok){const obj=await r.json(),body=obj?.data??obj;for(const key of ['subProviders','dubProviders','hSubProviders'])row[key]=Array.isArray(body?.[key])?body[key].length:null;}
 }catch(e){row.error=e.name;}
 console.log('::notice title=Hard subtitle API sample::'+JSON.stringify(row));
}
