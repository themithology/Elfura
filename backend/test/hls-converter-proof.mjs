// Isolated converter experiment: no production routes and no network access.
// Set ELFURA_TEST_FFMPEG to an FFmpeg binary with lavfi, MPEG-TS and Matroska support.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const ffmpeg = process.env.ELFURA_TEST_FFMPEG;
if (!ffmpeg) throw new Error('Set ELFURA_TEST_FFMPEG to a supported FFmpeg executable.');
const dir = mkdtempSync(path.join(tmpdir(), 'elfura-hls-proof-'));
const run = args => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20_000_000 });
try {
  const video = path.join(dir, 'video.ts');
  run(['-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mpegts',video]);
  for (const [language, frequency] of [['hi',440], ['en',880]]) {
    const audio = path.join(dir, `${language}.ts`);
    run(['-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=44100`,'-t','4','-c:a','aac','-f','mpegts',audio]);
    const out = path.join(dir, `${language}.mkv`);
    const child = spawn(ffmpeg, ['-hide_banner','-loglevel','error','-protocol_whitelist','pipe','-f','mpegts','-i','pipe:3','-protocol_whitelist','pipe','-f','mpegts','-i','pipe:4','-map','0:v:0','-map','1:a:0','-c','copy','-f','matroska',out], {stdio:['ignore','ignore','pipe','pipe','pipe']});
    let errors = ''; child.stderr.on('data', c => { errors += c.toString(); });
    const exit = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    const feeds = Promise.all([pipeline(createReadStream(video),child.stdio[3]),pipeline(createReadStream(audio),child.stdio[4])]);
    const [code] = await Promise.all([exit,feeds]);
    assert.equal(code, 0, errors);
    assert.equal(readFileSync(out).subarray(0,4).toString('hex'), '1a45dfa3');
    const pcm=run(['-i',out,'-map','0:a:0','-f','s16le','-ac','1','-ar','44100','pipe:1']);
    assert(pcm.length > 44100 * 2 * 3, 'decoded audio must contain at least three seconds');
    let crossings=0, prev=0; const start=44100; const samples=44100;
    for(let i=start;i<start+samples;i++){const cur=pcm.readInt16LE(i*2);if(prev<=0 && cur>0)crossings++;prev=cur;}
    assert(Math.abs(crossings-frequency)<15, `expected ${frequency}Hz, decoded ${crossings}Hz`);
    console.log(`✓ ${language}: MKV decodes and selected audio measures ${crossings}Hz`);
  }
} finally { rmSync(dir,{recursive:true,force:true}); }
