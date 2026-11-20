// Live GitHub runner probe: no tokens or upstream URLs are printed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSource26Adapter } from '../../dist/backend/sources/source26.js';
import { diagnoseCandidatePlayback, verifyAndFilterCandidates } from '../../dist/backend/sources/liveness.js';

const kind = process.argv[2];
const input = kind === 'movie'
  ? { type:'movie', tmdbId:'550', title:'Fight Club', year:'1999' }
  : kind === 'tv'
    ? { type:'tv', tmdbId:'1396', title:'Breaking Bad', year:'2008', season:1, episode:1 }
    : null;
if (!input) throw Error('Expected movie or tv');
const diag = [];
const result = await createSource26Adapter(() => true).resolve({ ...input, diag });
console.log('::notice title=Direct source resolution::' + JSON.stringify({kind, candidates:result.candidates.length, diag}));
if (!result.candidates.length) throw Error('No supported candidates');
// Real manifest evidence, not the provider's declared dub label, must reach
// the same verified candidates consumed by the source selector.
const verified = await verifyAndFilterCandidates(result.candidates, AbortSignal.timeout(8000));
console.log('::notice title=Verified source audio::' + JSON.stringify({kind, candidates:verified.map(c=>({type:c.type, language:c.audioLang??null, claimed:c.claimedAudioLang??null, ladder:c.qualityLadder??[], quality:c.quality}))}));
if (kind === 'movie' && !verified.some(c=>c.audioLang === 'hi' && c.type === 'dash')) throw Error('Hindi DASH dub was not verified');
const run = promisify(execFile);
let playable = false;
for (const candidate of result.candidates.slice(0, 3)) {
  const probe = await diagnoseCandidatePlayback(candidate, 'full');
  console.log('::notice title=Direct source network::' + JSON.stringify({kind, type:candidate.type, manifest:probe.manifest, media:probe.media, checks:probe.checks}));
  try {
    const headers = Object.entries(candidate.headers || {}).map(([k,v]) => `${k}: ${v}\r\n`).join('');
    const { stdout } = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-rw_timeout','10000000','-headers',headers,'-show_entries','stream=codec_type,codec_name:stream_tags=language','-of','json',candidate.url], {timeout:30000,maxBuffer:1024*1024});
    const parsed = JSON.parse(stdout);
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videos = streams.filter(s => s.codec_type === 'video').map(s => s.codec_name);
    // HEVC playback depends on browser/device support; this is not a browser test.
    const video = videos.find(codec => ['h264','hevc','vp9','av1'].includes(codec));
    const audio = streams.filter(s => s.codec_type === 'audio').map(s => ({codec:s.codec_name, language:s.tags?.language || null}));
    console.log('::notice title=Direct source media::' + JSON.stringify({kind, type:candidate.type, video:videos, audio}));
    if (video && audio.length) { playable = true; break; }
  } catch (error) { console.log('::warning title=Direct source probe::' + JSON.stringify({kind, type:candidate.type, probe:'failed', errorName:error.name, signal:error.signal || null, code:typeof error.code === 'number' ? error.code : String(error.code || 'unknown'), error:error.killed ? 'timeout' : ((String(error.stderr || '').match(/(?:HTTP error|Server returned|Invalid data|Connection refused|Connection timed out)[^\r\n]*/i)?.[0] || 'probe-error').replace(/https?:\/\/\S+/g, '[redacted]').slice(0, 120))})); }
}
if (!playable) throw Error('No supported video and audio detected by ffprobe');
// Metadata advertises MP4 qualities, but only ffprobe can confirm the file's
// actual height and audio tags. This optional audit does not assume availability.
if (kind === 'movie') {
  const mp4 = verified.find(c => c.type === 'mp4' && c.quality === '720p');
  if (mp4) {
    try {
      const headers = Object.entries(mp4.headers || {}).map(([k,v]) => `${k}: ${v}\r\n`).join('');
      const {stdout} = await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-rw_timeout','10000000','-headers',headers,'-show_entries','stream=codec_type,codec_name,height:stream_tags=language','-of','json',mp4.url], {timeout:30000,maxBuffer:1024*1024});
      const streams=JSON.parse(stdout).streams ?? [];
      console.log('::notice title=MP4 media audit::'+JSON.stringify({qualityClaim:mp4.quality,video:streams.filter(s=>s.codec_type==='video').map(s=>({codec:s.codec_name,height:s.height})),audio:streams.filter(s=>s.codec_type==='audio').map(s=>({codec:s.codec_name,language:s.tags?.language??null}))}));
    } catch(error) {console.log('::notice title=MP4 media audit::'+JSON.stringify({qualityClaim:mp4.quality,probe:'failed',errorName:error.name}));}
  }
}
