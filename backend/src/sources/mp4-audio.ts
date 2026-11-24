/** Bounded ISO-BMFF metadata parser. Only a complete moov with exactly one
 * audio track and a valid mdhd language is evidence of a single language. */
interface Box { type: string; start: number; end: number; data: number }
function boxes(buf: Buffer, from: number, to: number): Box[] | null {
  const result: Box[] = [];
  for (let pos = from; pos < to;) {
    if (to - pos < 8) return null;
    let size = buf.readUInt32BE(pos), header = 8;
    if (size === 1) {
      if (to - pos < 16) return null;
      const big = buf.readBigUInt64BE(pos + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big); header = 16;
    } else if (size === 0) size = to - pos;
    if (size < header || pos + size > to) return null;
    result.push({type: buf.toString('ascii', pos + 4, pos + 8), start: pos, end: pos + size, data: pos + header});
    pos += size;
  }
  return result;
}
export function extractMp4SingleAudioLanguage(buf: Buffer, tail = false): string | null {
  let moov: Box | undefined;
  if (!tail) {
    // The range can end inside a later mdat; locate moov without requiring the
    // entire file to be present, while still validating every preceding box.
    for (let pos = 0; pos + 8 <= buf.length;) {
      const size = buf.readUInt32BE(pos);
      if (size < 8 || pos + size > buf.length) break;
      if (buf.toString('ascii', pos + 4, pos + 8) === 'moov') { moov = {type:'moov', start:pos, data:pos+8, end:pos+size}; break; }
      pos += size;
    }
  } else {
    // A tail range may begin inside mdat. Check each complete moov-sized box,
    // then validate its full child hierarchy before trusting any language.
    for (let i = 4; i + 4 <= buf.length; i++) {
      if (buf.toString('ascii', i, i + 4) !== 'moov') continue;
      const start = i - 4, size = buf.readUInt32BE(start);
      if (size >= 8 && start + size === buf.length) { moov = {type:'moov', start, data:start+8, end:start+size}; break; }
    }
  }
  if (!moov) return null;
  const children = boxes(buf, moov.data, moov.end);
  if (!children) return null;
  let audios = 0, lang: string | null = null;
  for (const trak of children.filter(b => b.type === 'trak')) {
    const track = boxes(buf, trak.data, trak.end); if (!track) return null;
    const mdia = track.find(b => b.type === 'mdia'); if (!mdia) continue;
    const media = boxes(buf, mdia.data, mdia.end); if (!media) return null;
    const handler = media.find(b => b.type === 'hdlr');
    if (!handler || handler.data + 12 > handler.end || buf.toString('ascii', handler.data + 8, handler.data + 12) !== 'soun') continue;
    audios++;
    const mdhd = media.find(b => b.type === 'mdhd');
    if (!mdhd) continue;
    const version = buf[mdhd.data];
    if (version !== 0 && version !== 1) continue;
    const offset = mdhd.data + (version === 1 ? 32 : 20);
    if (offset + 2 > mdhd.end) continue;
    const value = buf.readUInt16BE(offset);
    const codes = [(value >> 10) & 31, (value >> 5) & 31, value & 31];
    if (codes.every(n => n >= 1 && n <= 26)) lang = String.fromCharCode(...codes.map(n => n + 96));
  }
  return audios === 1 && lang && lang !== 'und' ? lang : null;
}

/** Walk box headers without downloading large sample tables. `fetchWindow`
 * returns the bytes at the exact absolute offset; all reads and counts are bounded. */
export async function extractMp4AudioByRanges(
  head: Buffer, total: number, fetchWindow: (offset: number, length: number) => Promise<Buffer | null>,
): Promise<string | null> {
  if (!Number.isSafeInteger(total) || total < head.length || total < 8) return null;
  const windows: {start:number; data:Buffer}[] = [{start:0,data:head}];
  let requests = 0, count = 0;
  const read = async (at: number, length: number): Promise<Buffer | null> => {
    if (at < 0 || at + length > total) return null;
    let win = windows.find(w => at >= w.start && at + length <= w.start + w.data.length);
    if (!win) {
      if (++requests > 8) return null;
      const data = await fetchWindow(at, Math.min(16 * 1024, total - at));
      if (!data || data.length < length) return null;
      win = {start:at,data}; windows.push(win);
    }
    return win.data.subarray(at-win.start, at-win.start+length);
  };
  const list = async (start:number,end:number): Promise<Box[] | null> => {
    const found:Box[] = [];
    for (let at=start; at<end;) {
      if (++count > 128 || at + 8 > end) return null;
      const h=await read(at,16 > end-at ? 8 : 16); if (!h) return null;
      let size=h.readUInt32BE(0), header=8;
      if(size===1) {if(h.length<16)return null;const n=h.readBigUInt64BE(8);if(n>BigInt(Number.MAX_SAFE_INTEGER))return null;size=Number(n);header=16;}
      else if(size===0) size=end-at;
      if(size<header||at+size>end)return null;
      found.push({type:h.toString('ascii',4,8),start:at,data:at+header,end:at+size}); at+=size;
    }
    return found;
  };
  const top=await list(0,total); if(!top)return null;
  const moov=top.find(b=>b.type==='moov');if(!moov)return null;
  const children=await list(moov.data,moov.end);if(!children)return null;
  let countAudio=0, lang:string|null=null;
  for(const trak of children.filter(b=>b.type==='trak')){
    const track=await list(trak.data,trak.end);if(!track)return null;
    const mdia=track.find(b=>b.type==='mdia');if(!mdia)continue;
    const media=await list(mdia.data,mdia.end);if(!media)return null;
    const handler=media.find(b=>b.type==='hdlr');if(!handler)continue;
    const h=await read(handler.data,12);if(!h)return null;
    if(h.toString('ascii',8,12)!=='soun')continue;
    countAudio++;
    const mdhd=media.find(b=>b.type==='mdhd');if(!mdhd)continue;
    const version=(await read(mdhd.data,1))?.[0];if(version!==0&&version!==1)continue;
    const at=mdhd.data+(version===1?32:20);if(at+2>mdhd.end)continue;
    const b=await read(at,2);if(!b)return null;
    const v=b.readUInt16BE(0), chars=[(v>>10)&31,(v>>5)&31,v&31];
    if(chars.every(c=>c>=1&&c<=26))lang=String.fromCharCode(...chars.map(c=>c+96));
  }
  return countAudio===1 && lang && lang!=='und' ? lang : null;
}
