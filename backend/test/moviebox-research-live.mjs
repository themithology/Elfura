// Controlled provider audit: summaries only, never print signed URLs or tokens.
import { movieBoxHeaders, movieBoxDashFromCookie } from '../../dist/backend/sources/source26.js';
import { extractQualityLadder } from '../../dist/backend/sources/liveness.js';
const base='https://api6.aoneroom.com/wefeed-mobile-bff';
const summary=(label, data)=>console.log(`::notice title=${label}::${JSON.stringify(data)}`);
async function call(path, body, token) {
  const method=body ? 'POST' : 'GET'; const url=base+path;
  const res=await fetch(url,{ method,headers:movieBoxHeaders(method,url,body,token),...(body?{body}:{}),signal:AbortSignal.timeout(8000),redirect:'error'});
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const data=await res.json(); return data.data??data;
}
const login=await call('/user-api/visitor-login','{}');
if(!login.token) throw Error('No visitor token');
for(const sample of [
 {title:'Fight Club',type:'movie'},
 {title:'Breaking Bad',type:'tv',season:1,episode:1},
 {title:'Avengers: Endgame',type:'movie'},
]) {
 try {
  const data=await call('/subject-api/search/v2', JSON.stringify({keyword:sample.title,page:1,perPage:15,subjectType:0}),login.token);
  const rows=(data.results??[]).flatMap(g=>g.subjects??[]).concat(data.list??[]);
  const norm=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const exact=rows.find(r=>norm(r.title)===norm(sample.title)) ?? rows.find(r=>norm(r.title)===norm(sample.title+' S1'));
  summary('Search sample',{title:sample.title,rows:rows.slice(0,12).map(r=>({title:r.title,type:r.subjectType,year:String(r.releaseDate??'').slice(0,4),audios:r.audios??null})),exact:!!exact});
  if(!exact) continue;
  const id=String(exact.subjectId??exact.id);
  const details=await call('/subject-api/get?'+new URLSearchParams({subjectId:id}),null,login.token);
  const subject=details.subject??details;
  summary('Details sample',{title:sample.title,keys:Object.keys(subject),audios:subject.audios??null,dubs:(subject.dubs??[]).slice(0,12).map(d=>({language:d.lanName??d.language??d.lang??null,title:d.title??d.name??null,keys:Object.keys(d)}))});
  const params=new URLSearchParams({subjectId:id}); if(sample.type==='tv'){params.set('se',String(sample.season));params.set('ep',String(sample.episode));}
  const play=await call('/subject-api/play-info/v2?'+params,null,login.token);
  const rows2=play.streams??[];
  summary('Play sample',{title:sample.title,displayResolutions:play.displayResolutions??null,streams:rows2.slice(0,5).map(s=>({format:s.format,codec:s.codecName,resolutions:s.resolutions,hasCookie:!!s.signCookie,hasDash:!!movieBoxDashFromCookie(s.signCookie??''),keys:Object.keys(s)}))});
  for(const stream of rows2.slice(0,2)){
   const url=movieBoxDashFromCookie(stream.signCookie??''); if(!url) continue;
   const res=await fetch(url,{headers:{Cookie:stream.signCookie,Referer:'https://sportslive.wine','User-Agent':movieBoxHeaders('GET',base)['User-Agent']},signal:AbortSignal.timeout(8000)});
   if(!res.ok){summary('Manifest sample',{title:sample.title,status:res.status});continue;}
   const text=await res.text();
   const sets=[...text.matchAll(/<AdaptationSet\b([^>]*)>/gi)].map(m=>({type:m[1].match(/(?:contentType|mimeType)=["']([^"']+)/i)?.[1],lang:m[1].match(/\blang=["']([^"']+)/i)?.[1]??null}));
   summary('Manifest sample',{title:sample.title,status:res.status,ladder:extractQualityLadder(text,true),adaptations:sets,heights:[...text.matchAll(/\bheight=["'](\d+)/gi)].map(m=>Number(m[1])).slice(0,16)});
  }
 }catch(e){summary('Sample error',{title:sample.title,error:e.name});}
}
