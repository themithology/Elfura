// Research-only: compare provider-labelled dubs without exposing URLs or tokens.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const origin = 'https://vidsync.pro';
const headers = { 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36', Referer: `${origin}/`, Accept: '*/*' };
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);
function notice(msg) { console.log(`::notice title=DubIntegrity::${msg.replace(/%/g, '%25').replace(/\n/g, '%0A')}`); }
for (const endpoint of ['core/streams', 'stream']) {
  try {
    const res = await fetch(`${origin}/api/${endpoint}?type=tv&id=289517&season=1&episode=1`, { headers, signal: AbortSignal.timeout(12000) });
    const data = await res.json();
    const rows = Array.isArray(data.sources) ? data.sources : [];
    const selected = [];
    for (const row of rows) {
      const language = String(row.audioLanguage || row.language || 'unknown').toLowerCase();
      if (selected.some((r) => r.language === language)) continue;
      if (!/^(en|english|hi|hindi|ko|korean)$/.test(language)) continue;
      selected.push({ language, row });
    }
    const reports = [];
    for (const { language, row } of selected.slice(0, 4)) {
      try {
        const candidate = new URL(row.url || row.directUrl || row.rawUrl, `${origin}/`);
        const response = await fetch(candidate, { headers, signal: AbortSignal.timeout(12000) });
        const text = await response.text();
        const renditions = (text.match(/#EXT-X-MEDIA:.*TYPE=AUDIO/gi) || []).length;
        const variants = (text.match(/#EXT-X-STREAM-INF/gi) || []).length;
        const first = text.split(/\r?\n/).map(x => x.trim()).find(x => x && !x.startsWith('#'));
        let media = '-';
        if (first && text.startsWith('#EXTM3U')) {
          const next = new URL(first, candidate);
          const r = await fetch(next, { headers, signal: AbortSignal.timeout(12000) });
          const bytes = new Uint8Array(await r.arrayBuffer());
          const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:stream_tags=language', '-of', 'json', 'pipe:0'], { input: bytes, timeout: 5000, maxBuffer: 1000000 });
          let audioTags = [];
          try {
            audioTags = (JSON.parse(probe.stdout.toString()).streams || [])
              .filter(s => s.codec_type === 'audio').map(s => s.tags?.language || 'untagged');
          } catch { /* missing or encrypted media, not proof of language */ }
          media = `${r.status}:${hash(bytes)}:audioTags=${audioTags.join('/') || 'none'}`;
        }
        reports.push(`${language}:status=${response.status},manifest=${hash(text)},audio=${renditions},variants=${variants},first=${media}`);
      } catch (e) { reports.push(`${language}:error=${e.name}`); }
    }
    notice(`${endpoint} rows=${rows.length} ${reports.join(' | ') || 'no labelled rows'}`);
  } catch (e) { notice(`${endpoint} error=${e.name}`); }
}
