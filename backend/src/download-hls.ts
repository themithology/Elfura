/**
 * Experimental VOD-only HLS segment parser for a future offline converter.
 * It never passes a manifest to FFmpeg. No production endpoint imports it.
 */
export interface DownloadMediaPlaylist { segments: string[]; duration: number }

export function parseDownloadMediaPlaylist(text: string, relayBase: string): DownloadMediaPlaylist {
  if (Buffer.byteLength(text, 'utf8') > 2_000_000) throw new Error('Playlist is too large');
  const lines = text.split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U' || !lines.includes('#EXT-X-ENDLIST')) throw new Error('Only complete VOD playlists are supported');
  const base = new URL(relayBase);
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Expected the local relay');
  const segments: string[] = [];
  let expectSegment = false;
  let duration = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.startsWith('#')) {
      // Do not guess about encryption, fragmented MP4, ranges or discontinuities.
      if (/^#EXT-X-(?:KEY|SESSION-KEY|MAP|BYTERANGE|DISCONTINUITY|STREAM-INF|I-FRAME-STREAM-INF|PART|SKIP):?/i.test(line)) {
        throw new Error('Unsupported HLS playlist feature');
      }
      if (/^#EXTINF:/i.test(line)) {
        if (expectSegment) throw new Error('Missing segment');
        const value = Number(line.slice(8).split(',')[0]);
        if (!Number.isFinite(value) || value <= 0 || value > 3600) throw new Error('Invalid segment duration');
        duration += value;
        if (duration > 21600) throw new Error('Playlist duration too long');
        expectSegment = true;
      }
      continue;
    }
    if (!expectSegment) throw new Error('Unexpected playlist URI');
    const url = new URL(line, base);
    if (url.origin !== base.origin || url.pathname !== '/api/v1/stream' || !url.searchParams.get('t') || url.username || url.password || url.hash) {
      throw new Error('Segment must use the local relay');
    }
    segments.push(url.pathname + url.search);
    if (segments.length > 10000) throw new Error('Too many segments');
    expectSegment = false;
  }
  if (expectSegment || !segments.length) throw new Error('Incomplete media playlist');
  return { segments, duration };
}

import { openStreamTicket, sealStreamTicket } from './security.js';
import type { UniformStreamOption } from './sources/types.js';

export interface HlsChoice { name: string; quality: string; size: string; languages: string[]; kind: string; video: string; audio?: string }
const langNames: Record<string,string> = {hi:'Hindi',hin:'Hindi',en:'English',eng:'English',ta:'Tamil',tam:'Tamil',te:'Telugu',tel:'Telugu',ml:'Malayalam',kn:'Kannada',ja:'Japanese',jpn:'Japanese',ko:'Korean',bn:'Bengali',mr:'Marathi'};
const label = (code?:string) => code ? langNames[code.toLowerCase().split('-')[0]] || code.toUpperCase().slice(0,30) : 'Unknown';
const attrs = (s:string):Record<string,string> => {const out:Record<string,string>={};for(const m of s.matchAll(/(?:^|,)([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))out[m[1]]=m[2].replace(/^"|"$/g,'');return out;};
export function localRelay(raw:string, base:string, secret:Buffer, expected:'m'|'a'):string {
  const u = new URL(raw,base), b=new URL(base);
  if(u.origin!==b.origin||u.pathname!=='/api/v1/stream'||u.hash||u.username||u.password)throw Error('Invalid relay URL');
  const ticket=u.searchParams.get('t') || '';if(ticket.length>12000||openStreamTicket(secret,ticket)?.k!==expected)throw Error('Invalid relay ticket');
  u.searchParams.set('p','1');return u.pathname+u.search;
}
export async function relayText(base:string, local:string, signal:AbortSignal):Promise<string> {
  const res=await fetch(new URL(local,base),{headers:{'user-agent':'Mozilla/5.0 ElfuraDownload'},redirect:'error',signal});
  if(!res.ok||!res.body)throw Error('Playlist unavailable');
  const chunks:Uint8Array[]=[];let length=0;
  for await(const chunk of res.body){length+=chunk.length;if(length>2_000_000){await res.body.cancel().catch(()=>{});throw Error('Playlist too large');}chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
export function choicesFromManifest(text:string, base:string, opt:UniformStreamOption, title:string, secret:Buffer):HlsChoice[] {
  const lines=text.split(/\r?\n/).map(s=>s.trim());if(lines[0]!=='#EXTM3U')return [];
  const audio:{group:string;url:string;language:string}[]=[];
  for(const line of lines){if(!line.startsWith('#EXT-X-MEDIA:'))continue;const a=attrs(line.slice(13));if(a.TYPE!=='AUDIO'||!a.URI||!a['GROUP-ID'])continue;try{audio.push({group:a['GROUP-ID'],url:localRelay(a.URI,base,secret,'m'),language:label(a.LANGUAGE)});}catch{}}
  const variants:{url:string;quality:string;group:string}[]=[];
  for(let i=0;i<lines.length;i++){if(!lines[i].startsWith('#EXT-X-STREAM-INF:'))continue;const a=attrs(lines[i].slice(18));let j=i+1;while(j<lines.length&&(!lines[j]||lines[j].startsWith('#')))j++;try{variants.push({url:localRelay(lines[j]||'',base,secret,'m'),quality:a.RESOLUTION?.match(/^\d+x(\d+)$/)?.[1] ? `${a.RESOLUTION.split('x')[1]}p` : 'Auto',group:a.AUDIO||''});}catch{}}
  if(!variants.length){if(lines.some(l=>l.startsWith('#EXT-X-STREAM-INF:')))return [];try{parseDownloadMediaPlaylist(text,base);variants.push({url:localRelay(base,base,secret,'m'),quality:opt.quality&&opt.quality!=='auto'?opt.quality:'Auto',group:''});}catch{return [];}}
  const out:HlsChoice[]=[];
  for(const v of variants){const tracks=audio.filter(a=>a.group===v.group);if(tracks.length)for(const a of tracks)out.push({name:title,quality:v.quality,size:'',languages:[a.language],kind:'HLS → MP4',video:v.url,audio:a.url});else out.push({name:title,quality:v.quality,size:'',languages:[label(opt.audioLang)],kind:'HLS → MP4',video:v.url});}
  return out.slice(0,60);
}
export function issueChoice(secret:Buffer,c:HlsChoice):string{return sealStreamTicket(secret,{u:c.video,h:{purpose:'hls-download-v3',name:c.name,quality:c.quality,languages:c.languages.join(', '),audio:c.audio||''}},1800);}
export function readChoice(secret:Buffer,token:string,base:string):HlsChoice|null {
  if(token.length>12000)return null;const t=openStreamTicket(secret,token);if(!t||t.h?.purpose!=='hls-download-v3')return null;
  try{return {name:(t.h.name||'Download').slice(0,200),quality:t.h.quality||'Auto',languages:[t.h.languages||'Unknown'],size:'',kind:'HLS → MP4',video:localRelay(t.u,base,secret,'m'),...(t.h.audio?{audio:localRelay(t.h.audio,base,secret,'m')}:{})};}catch{return null;}
}
