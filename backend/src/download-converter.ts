/** Experimental, opt-in converter: FFmpeg reads segment bytes, never a playlist or URL. */
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import type {Writable} from 'node:stream';
import type {ServerResponse} from 'node:http';
import {localRelay, parseDownloadMediaPlaylist, relayText, type HlsChoice} from './download-hls.js';

async function segments(base:string, url:string, secret:Buffer, signal:AbortSignal):Promise<string[]> {
  const text=await relayText(base,url,AbortSignal.any([signal,AbortSignal.timeout(12_000)]));
  return parseDownloadMediaPlaylist(text,base).segments.map(s=>localRelay(s,base,secret,'a'));
}
async function feed(base:string,urls:string[],stream:Writable,signal:AbortSignal,budget:{bytes:number}):Promise<void>{
  for(const url of urls){
    const res=await fetch(new URL(url,base),{headers:{'user-agent':'Mozilla/5.0 ElfuraDownload'},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)])});
    if(!res.ok||!res.body)throw Error('Segment unavailable');
    let segmentBytes=0;
    for await(const chunk of res.body){
      segmentBytes+=chunk.length;budget.bytes+=chunk.length;
      if(segmentBytes>64*1024*1024||budget.bytes>20*1024*1024*1024)throw Error('Download limit reached');
      if(!stream.write(chunk))await once(stream,'drain',{signal});
    }
  }
  stream.end();
}
/** Build a safe filename from available metadata, never inventing codec or release details. */
export function downloadFilename(item:HlsChoice):string {
  const clean=(value:string)=>value.normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g,' ').replace(/\s+/g,' ').trim();
  const title=Array.from(clean(item.name)).slice(0,80).join('')||'Download';
  const quality=/^\d{2,4}p$/i.test(item.quality)?item.quality:'';
  const language=item.languages.filter(x=>x && !/^(?:unknown|und)$/i.test(x)).map(x=>Array.from(clean(x)).slice(0,25).join('')).filter(Boolean).join(' + ');
  return [title,quality,language,'TheOGPirateBot.online'].filter(Boolean).join(' - ')+'.mkv';
}
function contentDisposition(name:string):string {
  const ascii=name.normalize('NFKD').replace(/[^\x20-\x7e]/g,'').replace(/["\\]/g,'').trim()||'Download - TheOGPirateBot.online.mkv';
  const encoded=encodeURIComponent(name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
export async function convertDownload(res:ServerResponse, item:HlsChoice, base:string, secret:Buffer, ffmpeg:string):Promise<void>{
  const controller=new AbortController();let child:ChildProcess|undefined;let completed=false;
  const timer=setTimeout(()=>controller.abort(),2*60*60*1000);timer.unref();
  const disconnected=()=>{if(!completed)controller.abort();};res.once('close',disconnected);
  controller.signal.addEventListener('abort',()=>{child?.kill('SIGKILL');},{once:true});
  try{
    const [video,audio]=await Promise.all([segments(base,item.video,secret,controller.signal),item.audio?segments(base,item.audio,secret,controller.signal):Promise.resolve(null)]);
    const args=['-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-f','mpegts','-i','pipe:3'];
    if(audio)args.push('-protocol_whitelist','pipe','-f','mpegts','-i','pipe:4');
    args.push('-map','0:v:0','-map',audio?'1:a:0':'0:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-f','matroska','pipe:1');
    child=spawn(ffmpeg,args,{stdio:['ignore','pipe','pipe','pipe','pipe']});
    child.stderr?.resume();
    const done=new Promise<number|null>((resolve,reject)=>{child!.once('error',reject);child!.once('close',code=>{if(code!==0)controller.abort();resolve(code);});});
    const pipes=child.stdio;const budget={bytes:0};
    (pipes[3] as Writable).on('error',()=>controller.abort());
    (pipes[4] as Writable).on('error',()=>controller.abort());
    const feeding=Promise.all([feed(base,video,pipes[3] as Writable,controller.signal,budget),...(audio?[feed(base,audio,pipes[4] as Writable,controller.signal,budget)]:[])]);
    // Observe errors immediately, including before FFmpeg has produced output.
    void feeding.catch(()=>controller.abort());
    let started=false;
    child.stdout!.once('data',chunk=>{
      if(res.destroyed||controller.signal.aborted)return;
      started=true;const filename=downloadFilename(item);
      res.writeHead(200,{'Content-Type':'video/x-matroska','Content-Disposition':contentDisposition(filename),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
      res.write(chunk);child!.stdout!.pipe(res,{end:false});
    });
    const [code]=await Promise.all([done,feeding]);
    if(code!==0||!started)throw Error('Could not convert this stream');
    completed=true;res.end();
  }catch{
    controller.abort();
    if(!res.destroyed){if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({ok:false,error:'This HLS stream could not be converted. Try another source.'}));}else res.destroy();}
  }finally{clearTimeout(timer);res.removeListener('close',disconnected);}
}
