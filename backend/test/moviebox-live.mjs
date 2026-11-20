// Live GitHub runner probe: no tokens or upstream URLs are printed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSource26Adapter } from '../../dist/backend/sources/source26.js';
import { diagnoseCandidatePlayback } from '../../dist/backend/sources/liveness.js';

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
const run = promisify(execFile);
let playable = false;
for (const candidate of result.candidates.slice(0, 3)) {
  const probe = await diagnoseCandidatePlayback(candidate, 'full');
  console.log('::notice title=Direct source network::' + JSON.stringify({kind, type:candidate.type, manifest:probe.manifest, media:probe.media, checks:probe.checks}));
  try {
    const headers = Object.entries(candidate.headers || {}).map(([k,v]) => `${k}: ${v}\r\n`).join('');
    const { stdout } = await run('ffprobe', ['-v','error','-rw_timeout','10000000','-headers',headers,'-show_entries','stream=codec_type,codec_name:stream_tags=language','-of','json',candidate.url], {timeout:30000,maxBuffer:1024*1024});
    const parsed = JSON.parse(stdout);
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find(s => s.codec_type === 'video' && ['h264','vp9','av1'].includes(s.codec_name));
    const audio = streams.filter(s => s.codec_type === 'audio').map(s => ({codec:s.codec_name, language:s.tags?.language || null}));
    console.log('::notice title=Direct source media::' + JSON.stringify({kind, type:candidate.type, video:video?.codec_name ?? null, audio}));
    if (video && audio.length) { playable = true; break; }
  } catch (error) { console.log('::warning title=Direct source probe::' + JSON.stringify({kind, type:candidate.type, probe:'failed', code:typeof error.code === 'number' ? error.code : String(error.code || 'unknown'), error:error.killed ? 'timeout' : ((String(error.stderr || '').match(/(?:HTTP error|Server returned|Invalid data|Connection refused|Connection timed out)[^\r\n]*/i)?.[0] || 'probe-error').replace(/https?:\/\/\S+/g, '[redacted]').slice(0, 120))})); }
}
if (!playable) throw Error('No browser-compatible video and audio detected by ffprobe');
