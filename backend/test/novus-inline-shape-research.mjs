// Research-only shape inspection. Token-bearing string literals are redacted.
import {readBoundedText} from '../../dist/backend/sources/upstream-fetch.js';
const url='https://novuscloud.buzz/embed/ani/20/1/sub?k=1';
const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0',Referer:'https://anikototv.to/'}});
const html=await readBoundedText(r,1500000),sections=[];
function shape(text){return text.replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g,'"LITERAL"').replace(/\b[A-Za-z0-9_=-]{24,}\b/g,'OPAQUE').replace(/\b\d{2,}\b/g,'N').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').slice(0,220);}
for(const m of (html??'').matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)){
 const body=m[1];for(const re of [/getSources/gi,/\bfetch\s*\(/gi,/\bjwplayer\s*\(/gi,/\btoken\b/gi]){
  for(const hit of body.matchAll(re)){const i=hit.index;sections.push(shape(body.slice(Math.max(0,i-80),i+130)));if(sections.length>=12)break;}if(sections.length>=12)break;
 }if(sections.length>=12)break;
}
console.log('::notice title=Novus inline player structure::'+JSON.stringify({status:r.status,count:sections.length,sections}));
