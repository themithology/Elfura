// Redacted, research-only MovieNerds access/identity/liveness probe. No keys or URLs logged.
import {createHash} from 'node:crypto';
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
import {isSafeUpstreamUrl} from '../../dist/backend/security.js';
import {verifyAndFilterCandidatesDetailed} from '../../dist/backend/sources/liveness.js';
const site='https://movienerds.site';
const headers={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',Origin:site,Referer:site+'/'};
const cases=[{name:'Fight Club',id:'550',type:'movie',title:'Fight Club',year:1999,imdb:'tt0137523'},{name:'Inception',id:'27205',type:'movie',title:'Inception',year:2010,imdb:'tt1375666'},{name:'Dune Part Two',id:'693134',type:'movie',title:'Dune: Part Two',year:2024,imdb:'tt15239678'},{name:'Casablanca',id:'289',type:'movie',title:'Casablanca',year:1943,imdb:'tt0034583'},{name:'Parasite',id:'496243',type:'movie',title:'Parasite',year:2019,imdb:'tt6751668'},{name:'Game of Thrones E1',id:'1399',type:'tv',title:'Game of Thrones',year:2011,season:1,episode:1},{name:'Game of Thrones E2',id:'1399',type:'tv',title:'Game of Thrones',year:2011,season:1,episode:2},{name:'Breaking Bad E1',id:'1396',type:'tv',title:'Breaking Bad',year:2008,season:1,episode:1},{name:'Breaking Bad S5E16',id:'1396',type:'tv',title:'Breaking Bad',year:2008,season:5,episode:16},{name:'Naruto E1',id:'46260',type:'tv',title:'Naruto',year:2002,season:1,episode:1},{name:'Naruto E2',id:'46260',type:'tv',title:'Naruto',year:2002,season:1,episode:2},{name:'Nonexistent movie',id:'999999999999',type:'movie',title:'Nonexistent movie',year:1874},{name:'Nonexistent episode',id:'1396',type:'tv',title:'Breaking Bad',year:2008,season:999,episode:999}];
const report={setup:{},rows:[]};
try{
 const home=await fetch(site+'/',{headers,redirect:'error',signal:AbortSignal.timeout(8000)});report.setup.homeStatus=home.status;const html=await readBoundedText(home,500000);
 const asset=html?.match(/<script\b[^>]*\bsrc=["'](\/assets\/[^"']+\.js)["'][^>]*>/i)?.[1];report.setup.assetFound=!!asset;
 if(asset){const r=await fetch(site+asset,{headers,redirect:'error',signal:AbortSignal.timeout(8000)});report.setup.assetStatus=r.status;const js=await readBoundedText(r,3000000);
 const key=js?.match(/["']x-app-key["']\s*:\s*[`"']([^`"']{1,200})[`"']/i)?.[1],client=js?.match(/["']x-client-app["']\s*:\s*[`"']([^`"']{1,100})[`"']/i)?.[1];
 report.setup.publicConfigFound=!!key&&!!client&&!!js?.includes('https://api.movienerds.online');
 if(report.setup.publicConfigFound)for(const c of cases){const row={sample:c.name};try{
 const params=new URLSearchParams({tmdbId:c.id,type:c.type,title:c.title,year:String(c.year),lang:'en',...(c.imdb?{imdbId:c.imdb}:{}),...(c.type==='tv'?{season:String(c.season),episode:String(c.episode)}:{})});
 const res=await fetch(`https://api.movienerds.online/api/stream?${params}`,{headers:{...headers,Accept:'application/json','x-app-key':key,'x-client-app':client},redirect:'error',signal:AbortSignal.timeout(18000)});row.status=res.status;
 const raw=await readBoundedText(res,500000);let data;try{data=JSON.parse(raw??'null')}catch{}
 row.identity=data?.success===true&&Number(data.tmdbId)===Number(c.id)&&data.type===c.type&&String(data.title??'').toLowerCase()===c.title.toLowerCase()&&(c.type==='movie'?Number(data.year)===c.year:Number(data.season)===c.season&&Number(data.episode)===c.episode);
 const list=Array.isArray(data?.sources)?data.sources.slice(0,12):[];row.rows=list.length;
 const urls=[...new Set(list.filter(x=>x?.type==='hls'&&x?.isDirect!==false).map(x=>typeof x.rawUrl==='string'?x.rawUrl:x.url).filter(x=>typeof x==='string'&&isSafeUpstreamUrl(x)&&new URL(x).protocol==='https:'))].slice(0,3);row.candidates=urls.length;
 if(urls.length&&row.identity){const candidates=urls.map(url=>({key:url,url,type:'hls',quality:'auto',headers:{'User-Agent':headers['User-Agent'],Referer:site+'/',Origin:site}}));const checked=await verifyAndFilterCandidatesDetailed(candidates,AbortSignal.timeout(6000));row.alive=checked.verifiedAliveCount;row.hosts=urls.map(url=>createHash('sha256').update(new URL(url).hostname).digest('hex').slice(0,10));}
 }catch(e){row.error=e?.cause?.code??e.name;}report.rows.push(row);}
 }
}catch(e){report.setup.error=e?.cause?.code??e.name;}
console.log('::notice title=MovieNerds research::'+JSON.stringify(report));
