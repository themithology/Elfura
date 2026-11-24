import {createSource30Adapter} from '../../../dist/backend/sources/source30.js';
import {restrictedFetchWithRedirects} from '../../../dist/backend/restricted-fetch.js';
import {readBoundedText} from '../../../dist/backend/sources/upstream-fetch.js';
import {resolveHlsChildUrl} from '../../../dist/backend/relay.js';
const adapter=createSource30Adapter(()=>true,{mapEpisode:async()=>({anilistId:'20',episode:2})});
const rows=[];
for(const c of (await adapter.resolve({type:'tv',tmdbId:'46260',season:1,episode:2})).candidates){
 const row={lane:c.audioVariant,steps:[]};let u=c.url;
 for(let depth=0;depth<3;depth++)try{
  const res=await restrictedFetchWithRedirects(u,{headers:c.headers,signal:AbortSignal.timeout(9000)},'*public*');
  const item={depth,host:new URL(u).hostname,status:res.status,ct:res.headers.get('content-type')?.split(';')[0]??''};row.steps.push(item);
  if(depth===2){const reader=res.body?.getReader();const r=await reader?.read();item.bytes=r?.value?.length??0;await reader?.cancel();break;}
  const text=await readBoundedText(res,500000);if(!text?.startsWith('#EXTM3U'))break;
  let ref=text.split(/\r?\n/).map(x=>x.trim()).find(x=>x&&!x.startsWith('#'));
  if(depth===1){let elapsed=0,seg=0;for(const line of text.split(/\r?\n/).map(x=>x.trim())){const m=line.match(/^#EXTINF:([\d.]+)/);if(m){seg=Number(m[1]);continue}if(line&&!line.startsWith('#')&&seg){if(elapsed+seg>=420){ref=line;break}elapsed+=seg;seg=0;}}}
  if(!ref)break;u=resolveHlsChildUrl(ref,res.url||u);
 }catch(e){row.steps.push({depth,error:e.name,code:e.cause?.code??e.code??''});break;}
 rows.push(row);
}
console.log('::notice title=MegaPlay media probe::'+JSON.stringify(rows));
