"""Investigation only: patch fragment header durations in small local fixtures."""
import struct, sys
from pathlib import Path
source=Path(sys.argv[1]).read_bytes()
containers={'moov','trak','mdia'}
def patch(all_tracks):
 b=bytearray(source)
 def u32(p):return struct.unpack_from('>I',b,p)[0]
 def set32(p,n):struct.pack_into('>I',b,p,n)
 def walk(start,end):
  pos=start
  while pos+8<=end:
   size=u32(pos);kind=bytes(b[pos+4:pos+8]).decode('latin1');header=8
   if size==1:size=struct.unpack_from('>Q',b,pos+8)[0];header=16
   if size<8 or pos+size>end:break
   p=pos+header;v=b[p] if p<pos+size else 0
   if kind=='mvhd':
    scale=u32(p+(12 if v==0 else 20));set32(p+16,int(scale*8)) if v==0 else struct.pack_into('>Q',b,p+24,int(scale*8))
   if all_tracks and kind=='tkhd':
    set32(p+20,8000) if v==0 else struct.pack_into('>Q',b,p+28,8000)
   if all_tracks and kind=='mdhd':
    scale=u32(p+(12 if v==0 else 20));set32(p+16,int(scale*8)) if v==0 else struct.pack_into('>Q',b,p+24,int(scale*8))
   if kind in containers:walk(p,pos+size)
   pos+=size
 walk(0,len(b));return b
Path(sys.argv[2]).write_bytes(patch(False))
Path(sys.argv[3]).write_bytes(patch(True))
