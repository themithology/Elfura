// Hosted research only. Do not log provider URLs, tokens or response bodies.
const origin = 'https://embed.vidrift.in';
const cases = [ ['movie', '693134'], ['tv', '289517'], ['tv', '213375'] ];
const headers = { 'User-Agent': 'Mozilla/5.0 Chrome/137.0.0.0 Safari/537.36', Referer: `${origin}/`, Origin: origin };
function log(message) { console.log(`::notice title=RiftResearch::${message.replace(/%/g, '%25').replace(/\n/g, '%0A')}`); }
for (const [type, id] of cases) {
  const path = type === 'tv' ? `tv/${id}/1/1` : `movie/${id}`;
  const t = Date.now();
  try {
    const boot = await fetch(`${origin}/api/boot/${path}?type=${type}&id=${id}&source=0&provider=&shell=1`, { headers, signal: AbortSignal.timeout(10000) });
    const body = await boot.json().catch(() => ({}));
    const meta = body.meta || {};
    const streams = (meta.orionStreams || []).filter(s => typeof s.url === 'string' && s.url.includes('/api/orion/')); 
    let sourceInfo = '';
    if (!streams.length && meta.playbackToken) {
      const q = new URLSearchParams({token: meta.playbackToken, provider: 'vaplayer'});
      const r = await fetch(`${origin}/api/source/${path}?${q}`, {headers, signal: AbortSignal.timeout(10000)});
      const json = await r.json().catch(() => ({}));
      sourceInfo = ` sourceStatus=${r.status} sourceKeys=${Object.keys(json).join(',')} sourceStreams=${Array.isArray(json.streams) ? json.streams.length : -1} success=${json.success ?? '-'} `;
      streams.push(...(json.streams || []).filter(s => s.type === 'hls' && !s.direct && (s.proxyUrl || s.url)));
    }
    let result = `boot=${boot.status} metaKeys=${Object.keys(meta).join(',')} orion=${Array.isArray(meta.orionStreams) ? meta.orionStreams.length : -1} warm=${meta.warmStreams?.length || 0} token=${!!meta.playbackToken} hls=${streams.length}${sourceInfo}`;
    if (streams[0]) {
      let u = new URL(streams[0].proxyUrl || streams[0].url, origin);
      let kind = ''; let audio = 0; let variants = 0;
      for (let n=0; n<3; n++) {
        const response = await fetch(u, {headers: {...headers, 'X-Playback-Token': meta.playbackToken || '', Range: 'bytes=0-65535'}, signal: AbortSignal.timeout(10000)});
        if (!response.ok) { kind = `http-${response.status}`; break; }
        const reader = response.body.getReader(); const parts = []; let total = 0; while (total < 65536) { const r = await reader.read(); if (r.done) break; parts.push(r.value); total += r.value.length; } await reader.cancel(); const bytes = new Uint8Array(Math.min(total, 65536)); let offset = 0; for (const p of parts) { bytes.set(p.subarray(0, bytes.length-offset), offset); offset += Math.min(p.length, bytes.length-offset); }
        const text = new TextDecoder().decode(bytes);
        if (!text.trimStart().startsWith('#EXTM3U')) { kind = (bytes[0] === 0x47 && bytes.length > 188 && bytes[188] === 0x47) ? `mpegts-bytes=${bytes.length}` : (bytes.length > 8 && ['ftyp','styp','moof'].includes(String.fromCharCode(...bytes.slice(4,8)))) ? `mp4-bytes=${bytes.length}` : `unrecognized-bytes=${bytes.length}`; break; }
        audio = Math.max(audio, (text.match(/^#EXT-X-MEDIA:.*TYPE=AUDIO/gim) || []).length);
        variants = Math.max(variants, (text.match(/^#EXT-X-STREAM-INF/gim) || []).length);
        const child = text.split(/\r?\n/).map(s=>s.trim()).find(s=>s && !s.startsWith('#'));
        if (!child) { kind = 'no-child'; break; }
        u = new URL(child,u);
      }
      result += ` result=${kind} audio=${audio} variants=${variants}`;
    }
    log(`${type}:${id} ${result} ms=${Date.now()-t}`);
  } catch (e) { log(`${type}:${id} failed=${e.name} ms=${Date.now()-t}`); }
}
